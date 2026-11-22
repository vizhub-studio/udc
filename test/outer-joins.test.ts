import { describe, expect, it } from "vitest";
import {
  UDC_LIMITS,
  UdcError,
  canonicalMember,
  canonicalizeCube,
  codedRef,
  createCube,
  getCellKey,
  integrateCubes,
  resolveConcordance,
  sliceCube,
  type CanonicalCube,
  type CodeMapping,
  type JoinMode,
  type SemanticSchema,
} from "../src/index";

const country = { id: "country", name: "Country" };
const year = { id: "year", name: "Year" };
type Row = { country: string; year: string; value: string };
const mapping = (dimensionId: string, code: string): CodeMapping => ({
  source: codedRef(dimensionId, dimensionId + "-codes", "v1", code),
  canonical: canonicalMember(dimensionId, dimensionId + ":" + code),
  relationship: "exact",
  verified: true,
  revision: "mapping:v1",
  provenance: "outer-join fixture",
});
const concordance = resolveConcordance(
  [
    ...["US", "CN", "IN"].map((code) => mapping("country", code)),
    ...["2020", "2021"].map((code) => mapping("year", code)),
  ],
  { revision: "concordance:v1" },
);
function cube(measureId: string, rows: Row[]): CanonicalCube {
  const schema: SemanticSchema = {
    id: "schema:" + measureId,
    revision: "v1",
    dimensions: [
      {
        field: "country",
        dimension: country,
        codelist: { id: "country-codes", revision: "v1" },
      },
      {
        field: "year",
        dimension: year,
        codelist: { id: "year-codes", revision: "v1" },
      },
    ],
    measures: [
      {
        field: "value",
        measure: {
          id: measureId,
          name: measureId,
          unit: measureId === "population" ? "persons" : "USD",
          aggregation: "sum",
        },
        scale: 1,
      },
    ],
  };
  return canonicalizeCube(
    createCube(rows, schema, {
      datasetId: "dataset:" + measureId,
      revision: "r1",
    }),
    concordance,
  );
}
const left = () =>
  cube("population", [
    { country: "US", year: "2020", value: "0" },
    { country: "CN", year: "2021", value: "" },
  ]);
const right = () =>
  cube("gdp", [
    { country: "US", year: "2020", value: "42" },
    { country: "IN", year: "2021", value: "17" },
  ]);
const key = (code: string, y: string) =>
  getCellKey({
    members: [
      canonicalMember("country", "country:" + code),
      canonicalMember("year", "year:" + y),
    ],
  });
const has = (values: object, measure: string) =>
  Object.prototype.hasOwnProperty.call(values, measure);
const expectCode = (f: () => unknown, code: UdcError["code"]) => {
  try {
    f();
    throw new Error("Expected UdcError");
  } catch (error) {
    expect(error).toBeInstanceOf(UdcError);
    expect((error as UdcError).code).toBe(code);
  }
};

describe("explicit outer joins", () => {
  it("keeps the default and explicit inner join dense and backward compatible", () => {
    const a = left();
    const b = right();
    const implicit = integrateCubes(a, b);
    const explicit = integrateCubes(a, b, { join: "inner" });
    expect(implicit).toEqual(explicit);
    expect(implicit.stage).toBe("canonical");
    expect(implicit.observations.map((o) => o.cellKey)).toEqual([
      key("US", "2020"),
    ]);
    expect(implicit.observations[0].values.population.value).toBe(0);
    expect(implicit.observations[0].values.gdp.value).toBe(42);
  });

  it("distinguishes absent sources from a present null measure, with correct lineage", () => {
    const a = left();
    const b = right();
    const before = [JSON.stringify(a), JSON.stringify(b)];
    const full = integrateCubes(a, b, { join: "full" });
    expect(full.stage).toBe("sparse-integrated");
    expect(full.join).toBe("full");
    expect(full.observations.map((o) => o.cellKey)).toEqual(
      [key("US", "2020"), key("CN", "2021"), key("IN", "2021")].sort(),
    );
    const shared = full.observations.find(
      (o) => o.cellKey === key("US", "2020"),
    )!;
    expect(shared.presence).toEqual({ left: true, right: true });
    expect(shared.values.population?.value).toBe(0);
    expect(shared.values.gdp?.value).toBe(42);
    expect(shared.values.population?.provenance.snapshot.datasetId).toBe(
      "dataset:population",
    );
    expect(shared.values.gdp?.provenance.snapshot.datasetId).toBe(
      "dataset:gdp",
    );
    const onlyLeft = full.observations.find(
      (o) => o.cellKey === key("CN", "2021"),
    )!;
    expect(onlyLeft.presence).toEqual({ left: true, right: false });
    expect(has(onlyLeft.values, "population")).toBe(true);
    expect(onlyLeft.values.population?.value).toBeNull();
    expect(has(onlyLeft.values, "gdp")).toBe(false);
    expect(onlyLeft.values.gdp).toBeUndefined();
    expect(onlyLeft.values.population?.provenance).toMatchObject({
      snapshot: { datasetId: "dataset:population", revision: "r1" },
      sourceRow: 2,
      concordanceRevision: "concordance:v1",
      mappingRevisions: ["mapping:v1"],
    });
    const onlyRight = full.observations.find(
      (o) => o.cellKey === key("IN", "2021"),
    )!;
    expect(onlyRight.presence).toEqual({ left: false, right: true });
    expect(has(onlyRight.values, "population")).toBe(false);
    expect(onlyRight.values.gdp?.value).toBe(17);
    expect(onlyRight.values.gdp?.provenance.sourceRow).toBe(2);
    expect(full.snapshots).toEqual([...a.snapshots, ...b.snapshots]);
    expect(full.schemaRevisions).toEqual(["v1"]);
    expect(full.concordanceRevisions).toEqual(["concordance:v1"]);
    expect([JSON.stringify(a), JSON.stringify(b)]).toEqual(before);
  });

  it("supports left and right asymmetry, reversed order, and empty cubes", () => {
    const a = left();
    const b = right();
    const l = integrateCubes(a, b, { join: "left" });
    const r = integrateCubes(a, b, { join: "right" });
    expect(l.observations.map((o) => o.cellKey)).toEqual(
      [key("US", "2020"), key("CN", "2021")].sort(),
    );
    expect(r.observations.map((o) => o.cellKey)).toEqual(
      [key("US", "2020"), key("IN", "2021")].sort(),
    );
    const swapped = integrateCubes(b, a, { join: "full" });
    expect(swapped.observations.map((o) => o.cellKey)).toEqual(
      integrateCubes(a, b, { join: "full" }).observations.map((o) => o.cellKey),
    );
    expect(
      swapped.observations.find((o) => o.cellKey === key("CN", "2021"))
        ?.presence,
    ).toEqual({ left: false, right: true });
    const empty = cube("gdp", []);
    expect(integrateCubes(a, empty).observations).toEqual([]);
    const outer = integrateCubes(a, empty, { join: "full" });
    expect(outer.observations).toHaveLength(2);
    expect(
      outer.observations.every((o) => o.presence.left && !o.presence.right),
    ).toBe(true);
    expect(
      integrateCubes(empty, a, { join: "right" }).observations,
    ).toHaveLength(2);
  });

  it("slices sparse results without inserting values or changing availability", () => {
    const joined = integrateCubes(left(), right(), { join: "full" });
    const at2021 = sliceCube(joined, canonicalMember("year", "year:2021"));
    expect(at2021.stage).toBe("sparse-integrated");
    expect(at2021.join).toBe("full");
    expect(at2021.dimensions).toEqual([country]);
    expect(at2021.observations).toHaveLength(2);
    const byCode = new Map(
      at2021.observations.map((o) => [o.coordinate.members[0].id, o]),
    );
    expect(byCode.get("country:CN")?.presence).toEqual({
      left: true,
      right: false,
    });
    expect(byCode.get("country:CN")?.values.population?.value).toBeNull();
    expect(has(byCode.get("country:CN")!.values, "gdp")).toBe(false);
    expect(byCode.get("country:IN")?.presence).toEqual({
      left: false,
      right: true,
    });
    expect(
      sliceCube(at2021, canonicalMember("country", "country:US")).observations,
    ).toEqual([]);
    expect(joined.dimensions).toHaveLength(2);
  });

  it("still rejects incompatible grains, duplicate measures and malformed source coordinates", () => {
    const a = left();
    const b = right();
    for (const join of ["inner", "left", "right", "full"] as JoinMode[]) {
      expectCode(
        () => integrateCubes(a, { ...b, dimensions: [country] }, { join }),
        "INCOMPATIBLE",
      );
      expectCode(() => integrateCubes(a, a, { join }), "CONFLICT");
      expectCode(
        () =>
          integrateCubes(
            a,
            {
              ...b,
              observations: [...b.observations, ...b.observations],
            },
            { join },
          ),
        "DUPLICATE",
      );
      expectCode(
        () =>
          integrateCubes(
            a,
            {
              ...b,
              observations: [{ ...b.observations[0], values: {} }],
            },
            { join },
          ),
        "INCOMPATIBLE",
      );
    }
    expectCode(
      () => integrateCubes(a, b, { join: "cross" as "full" }),
      "INVALID",
    );
  });

  it("fails closed when the union exceeds the output cap, even when each source is in budget", () => {
    const seedA = left();
    const seedB = right();
    function many(cube: CanonicalCube, start: number): CanonicalCube {
      return {
        ...cube,
        observations: Array.from(
          { length: UDC_LIMITS.outputObservations / 2 + 1 },
          (_, index) => {
            const coordinate = {
              members: [
                canonicalMember("country", "country:" + (start + index)),
                canonicalMember("year", "year:2020"),
              ],
            };
            return {
              ...cube.observations[0],
              coordinate,
              cellKey: getCellKey(coordinate),
            };
          },
        ),
      };
    }
    const a = many(seedA, 0);
    const b = many(seedB, 6000);
    expect(a.observations.length).toBeLessThanOrEqual(UDC_LIMITS.rows);
    expect(b.observations.length).toBeLessThanOrEqual(UDC_LIMITS.rows);
    expectCode(() => integrateCubes(a, b, { join: "full" }), "LIMIT");
    expect(integrateCubes(a, b).observations).toEqual([]);
  });
});
