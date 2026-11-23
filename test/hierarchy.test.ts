import { describe, expect, it } from "vitest";
import {
  UDC_LIMITS,
  UdcError,
  canonicalMember,
  codedRef,
  createHierarchy,
  type HierarchyDefinition,
  type HierarchyEdgeInput,
  type HierarchyProvenance,
} from "../src/index";

const member = (id: string) => canonicalMember("space", id);
const provenance = (
  sourceRow: number,
  mappingRevision = "mapping:v1",
): HierarchyProvenance => ({
  snapshot: {
    datasetId: "un-m49-relationships",
    revision: "file:sha256",
  },
  sourceRow,
  mappingRevision,
  childSource: codedRef("space", "m49-country", "2026", "356"),
  parentSource: codedRef("space", "m49-region", "2026", "034"),
});
const edge = (
  child: string,
  parent: string,
  row: number,
): HierarchyEdgeInput => ({
  child: member(child),
  parent: member(parent),
  provenance: provenance(row),
});
const definition = (edges: HierarchyEdgeInput[]): HierarchyDefinition => ({
  key: "un-m49",
  dimensionId: "space",
  revision: "snapshot:v1",
  edition: "2026",
  edges,
});
const rejects = (run: () => unknown, code: UdcError["code"]) => {
  try {
    run();
    throw new Error("Expected UdcError");
  } catch (error) {
    expect(error).toBeInstanceOf(UdcError);
    expect((error as UdcError).code).toBe(code);
  }
};

describe("versioned canonical member hierarchies", () => {
  it("resolves ancestors in one dimension and retains a disconnected forest", () => {
    const hierarchy = createHierarchy(
      definition([
        edge("india", "southern-asia", 1),
        edge("nepal", "southern-asia", 2),
        edge("southern-asia", "asia", 3),
        edge("asia", "world", 4),
        edge("usa", "northern-america", 5),
      ]),
    );
    expect(hierarchy.key).toBe("un-m49");
    expect(hierarchy.dimensionId).toBe("space");
    expect(hierarchy.revision).toBe("snapshot:v1");
    expect(hierarchy.edition).toBe("2026");
    expect(hierarchy.parent("india")).toEqual(member("southern-asia"));
    expect(hierarchy.parent(member("india"))).toEqual(member("southern-asia"));
    expect(hierarchy.ancestors("india")).toEqual([
      member("southern-asia"),
      member("asia"),
      member("world"),
    ]);
    expect(hierarchy.ancestors("usa")).toEqual([member("northern-america")]);
    expect(hierarchy.parent("world")).toBeUndefined();
    expect(hierarchy.ancestors("unknown")).toEqual([]);
    expect(hierarchy.edges).toHaveLength(5);
  });

  it("deduplicates repeated edges without losing distinct row evidence", () => {
    const inputs = [
      edge("india", "southern-asia", 2),
      edge("india", "southern-asia", 1),
      edge("india", "southern-asia", 1),
      edge("nepal", "southern-asia", 3),
    ];
    const one = createHierarchy(definition(inputs));
    const two = createHierarchy(definition([...inputs].reverse()));
    expect(one.edges).toEqual(two.edges);
    expect(one.edges.map((entry) => entry.child.id)).toEqual([
      "india",
      "nepal",
    ]);
    expect(one.edges[0].provenance.map((p) => p.sourceRow)).toEqual([1, 2]);
    expect(one.edges[0].provenance[0].snapshot).toEqual({
      datasetId: "un-m49-relationships",
      revision: "file:sha256",
    });
    expect(one.edges[0].provenance[0].childSource?.codelistRevision).toBe(
      "2026",
    );
    expect(one.ancestors("india")).toEqual(two.ancestors("india"));
  });

  it("copies input evidence so a caller cannot change the resolved graph", () => {
    const input = edge("india", "asia", 1);
    const hierarchy = createHierarchy(definition([input]));
    input.parent.id = "world";
    input.provenance.snapshot.datasetId = "another-dataset";
    expect(hierarchy.parent("india")).toEqual(member("asia"));
    expect(hierarchy.edges[0].provenance[0].snapshot.datasetId).toBe(
      "un-m49-relationships",
    );
  });

  it("rejects conflicting parents, self-parenting and long cycles", () => {
    rejects(
      () =>
        createHierarchy(
          definition([edge("india", "asia", 1), edge("india", "europe", 2)]),
        ),
      "CONFLICT",
    );
    rejects(
      () => createHierarchy(definition([edge("india", "india", 1)])),
      "CONFLICT",
    );
    rejects(
      () =>
        createHierarchy(
          definition([
            edge("india", "asia", 1),
            edge("asia", "world", 2),
            edge("world", "india", 3),
          ]),
        ),
      "CONFLICT",
    );
  });

  it("rejects cross-dimension members and source codes", () => {
    rejects(
      () =>
        createHierarchy(
          definition([
            {
              ...edge("india", "asia", 1),
              parent: canonicalMember("industry", "mining"),
            },
          ]),
        ),
      "INCOMPATIBLE",
    );
    rejects(
      () =>
        createHierarchy(
          definition([
            {
              ...edge("india", "asia", 1),
              provenance: {
                ...provenance(1),
                parentSource: codedRef("industry", "naics", "2022", "21"),
              },
            },
          ]),
        ),
      "INCOMPATIBLE",
    );
    rejects(
      () =>
        createHierarchy(
          definition([
            {
              ...edge("india", "asia", 1),
              child: codedRef("space", "m49", "2026", "356"),
            } as unknown as HierarchyEdgeInput,
          ]),
        ),
      "INVALID",
    );
    const hierarchy = createHierarchy(definition([edge("india", "asia", 1)]));
    rejects(
      () => hierarchy.ancestors(canonicalMember("time", "2026")),
      "INCOMPATIBLE",
    );
  });

  it("requires valid provenance, version pins and bounded inputs", () => {
    rejects(
      () =>
        createHierarchy(
          definition([{ ...edge("india", "asia", 1), provenance: undefined! }]),
        ),
      "INVALID",
    );
    rejects(
      () =>
        createHierarchy(
          definition([
            {
              ...edge("india", "asia", 1),
              provenance: { ...provenance(0), sourceRow: 0 },
            },
          ]),
        ),
      "INVALID",
    );
    rejects(
      () =>
        createHierarchy(
          definition([
            {
              ...edge("india", "asia", 1),
              provenance: { ...provenance(1), parentSource: undefined },
            },
          ]),
        ),
      "INVALID",
    );
    rejects(
      () => createHierarchy({ ...definition([]), revision: "" }),
      "INVALID",
    );
    rejects(
      () => createHierarchy({ ...definition([]), edition: " 2026" }),
      "INVALID",
    );
    rejects(
      () =>
        createHierarchy(
          definition(
            Array.from({ length: UDC_LIMITS.rows + 1 }, (_, i) =>
              edge("child:" + i, "parent", i + 1),
            ),
          ),
        ),
      "LIMIT",
    );
  });

  it("supports other hierarchical dimensions without geography rules", () => {
    const industry = createHierarchy({
      key: "naics",
      dimensionId: "industry",
      revision: "naics:2022",
      edition: "2022",
      edges: [
        {
          child: canonicalMember("industry", "311"),
          parent: canonicalMember("industry", "31-33"),
          provenance: {
            snapshot: { datasetId: "naics-2022" },
            sourceRow: 1,
            mappingRevision: "approved:1",
          },
        },
      ],
    });
    const time = createHierarchy({
      key: "calendar",
      dimensionId: "time",
      revision: "2026",
      edges: [
        {
          child: canonicalMember("time", "2026-11"),
          parent: canonicalMember("time", "2026"),
          provenance: {
            snapshot: { datasetId: "calendar" },
            sourceRow: 11,
            mappingRevision: "approved:2",
          },
        },
      ],
    });
    expect(industry.ancestors("311")[0].id).toBe("31-33");
    expect(time.parent("2026-11")?.id).toBe("2026");
    expect(createHierarchy(definition([])).ancestors("unknown")).toEqual([]);
  });
});
