import { describe, expect, it } from "vitest";
import {
  aggregateCube,
  calculateMeasure,
  canonicalMember,
  codedRef,
  createHierarchy,
  describeQuerySource,
  diceCube,
  executeQuery,
  filterCube,
  getCellKey,
  integrateCubes,
  planQuery,
  rollupCube,
  topNCube,
  UdcError,
  validateQuery,
  type AggregationOperator,
  type CanonicalCube,
  type QuerySpec,
} from "../src";

type Row = readonly [string, string, number | null];
const populationRows: readonly Row[] = [
  ["a", "2020", 10],
  ["b", "2020", 30],
  ["c", "2020", 90],
  ["a", "2021", 20],
  ["b", "2021", null],
];
const gdpRows: readonly Row[] = [
  ["a", "2020", 100],
  ["b", "2020", 600],
  ["c", "2020", 900],
  ["a", "2021", 600],
  ["b", "2021", 700],
];
function source(
  id: string,
  rows: readonly Row[] = populationRows,
  datasetId = id,
  aggregation: AggregationOperator = "sum",
): CanonicalCube {
  const snapshot = { datasetId, revision: "v1" };
  return {
    stage: "canonical",
    dimensions: [
      { id: "space", name: "Space" },
      { id: "time", name: "Year" },
    ],
    measures: [{ id, name: id, unit: "units", aggregation }],
    snapshots: [snapshot],
    schemaRevisions: ["schema-v1"],
    concordanceRevisions: ["concordance-v1"],
    observations: rows.map(([country, year, value], i) => {
      const coordinate = {
        members: [
          canonicalMember("space", country),
          canonicalMember("time", year),
        ],
      };
      return {
        coordinate,
        cellKey: getCellKey(coordinate),
        values: {
          [id]: {
            value,
            provenance: {
              snapshot,
              sourceRow: i + 1,
              schemaId: "schema",
              schemaRevision: "v1",
              measureId: id,
              unit: "units",
              sourceCoordinate: {
                members: [
                  codedRef("space", "countries", "v1", country),
                  codedRef("time", "years", "v1", year),
                ],
              },
            },
          },
        },
      };
    }),
  };
}
const population = source("population");
const gdp = source("gdp", gdpRows);
const hierarchy = createHierarchy({
  key: "geography",
  dimensionId: "space",
  revision: "v1",
  edges: [
    ["a", "east"],
    ["b", "east"],
    ["c", "west"],
  ].map(([child, parent], i) => ({
    child: canonicalMember("space", child),
    parent: canonicalMember("space", parent),
    provenance: {
      snapshot: { datasetId: "geography", revision: "v1" },
      sourceRow: i + 1,
      mappingRevision: "v1",
    },
  })),
});
const base: QuerySpec = {
  version: 1,
  dimensions: ["space", "time"],
  measures: ["population"],
};
const ratio = {
  id: "ratio",
  name: "GDP per capita",
  unit: "USD/person",
  expression: {
    kind: "binary",
    operator: "/",
    left: { kind: "measure", measureId: "gdp" },
    right: { kind: "measure", measureId: "population" },
  } as const,
};
const ratioQuery: QuerySpec = {
  ...base,
  measures: ["ratio"],
  calculatedMeasures: [ratio],
};
const filters = [{ dimensionId: "time", memberIds: ["2020"] }];
const rollups = [
  {
    hierarchyKey: "geography",
    revision: "v1",
    targetMembers: ["east", "west"],
  },
];
function plan(q: QuerySpec, cubes: readonly CanonicalCube[] = [population]) {
  return planQuery(q, {
    sources: cubes.map(describeQuerySource),
    hierarchies: [hierarchy],
  });
}
function run(q: QuerySpec, cubes: readonly CanonicalCube[] = [population]) {
  return executeQuery(plan(q, cubes), { cubes, hierarchies: [hierarchy] });
}

describe("declarative query validation", () => {
  it("accepts round-tripped JSON and rejects string expressions", () => {
    const decoded: unknown = JSON.parse(JSON.stringify(ratioQuery));
    expect(() => validateQuery(decoded)).not.toThrow();
    expect(() =>
      validateQuery({
        ...ratioQuery,
        calculatedMeasures: [{ ...ratio, expression: "gdp / population" }],
      }),
    ).toThrow(UdcError);
  });
  it.each([
    null,
    {},
    { ...base, version: 2 },
    { ...base, measures: [] },
    { ...base, dimensions: ["time", "time"] },
    { ...base, measures: ["population", "population"] },
    { ...base, filters: [null] },
    { ...base, filters: [...filters, ...filters] },
    { ...base, unknown: true },
    { ...base, join: "cross" },
    { ...base, join: "left" },
    { ...base, joinAnchor: "population" },
    { ...base, topN: { measureId: "population", n: -1 } },
    { ...base, topN: { measureId: "population", n: 10001 } },
    { ...base, topN: { measureId: "population", n: 1, ties: "random" } },
    { ...base, measureFilter: { kind: "and", operands: [] } },
    {
      ...base,
      measureFilter: {
        kind: "range",
        measureId: "population",
        min: 10,
        max: 1,
      },
    },
    {
      ...base,
      measureFilter: {
        kind: "compare",
        measureId: "population",
        operator: "gt",
        value: Infinity,
      },
    },
    { ...base, rollups: [{ ...rollups[0], targetMembers: [] }] },
    { ...ratioQuery, calculatedMeasures: [ratio, ratio] },
  ])("rejects malformed or unsupported query %#", (value) => {
    expect(() => validateQuery(value)).toThrow(UdcError);
  });
  it("bounds nested expression and predicate trees", () => {
    let expression: unknown = { kind: "constant", value: 1 };
    let predicate: unknown = { kind: "isNull", measureId: "population" };
    for (let i = 0; i < 40; i++) {
      expression = {
        kind: "binary",
        operator: "+",
        left: expression,
        right: { kind: "constant", value: 1 },
      };
      predicate = { kind: "not", operand: predicate };
    }
    expect(() =>
      validateQuery({
        ...ratioQuery,
        calculatedMeasures: [{ ...ratio, expression }],
      }),
    ).toThrow(UdcError);
    expect(() => validateQuery({ ...base, measureFilter: predicate })).toThrow(
      UdcError,
    );
  });
});

describe("query planning", () => {
  it("plans hidden operands, deterministic source order and a JSON round trip", () => {
    const a = plan(
      { ...ratioQuery, filters, topN: { measureId: "ratio", n: 1 } },
      [gdp, population],
    );
    const b = plan(a.query, [population, gdp]);
    expect(a).toEqual(b);
    expect(a.sources.map((s) => s.measureIds)).toEqual([
      ["gdp"],
      ["population"],
    ]);
    expect(a.steps).toEqual([
      "filter-dimensions",
      "integrate",
      "calculate",
      "top-n",
      "project",
    ]);
    expect(
      executeQuery(JSON.parse(JSON.stringify(a)), { cubes: [population, gdp] }),
    ).toEqual(executeQuery(b, { cubes: [gdp, population] }));
  });
  it("fails closed on competing providers, unknown measures and dimensions", () => {
    expect(() =>
      plan(base, [
        population,
        source("population", populationRows, "alternative"),
      ]),
    ).toThrow(UdcError);
    expect(() => plan({ ...base, measures: ["unknown"] })).toThrow(UdcError);
    expect(() => plan({ ...base, dimensions: ["unknown"] })).toThrow(UdcError);
    expect(() =>
      plan({ ...base, topN: { measureId: "unknown", n: 1 } }),
    ).toThrow(UdcError);
  });
  it("rejects unpinned snapshots, duplicate dataset identities and incompatible source grain", () => {
    expect(() =>
      describeQuerySource({
        ...population,
        snapshots: [{ datasetId: "population" }],
      }),
    ).toThrow(UdcError);
    expect(() => plan(base, [population, population])).toThrow(UdcError);
    const other = {
      ...gdp,
      dimensions: [...gdp.dimensions, { id: "extra", name: "Extra" }],
    };
    expect(() => plan(ratioQuery, [population, other])).toThrow(UdcError);
  });
  it("rejects more than the existing two-source operator budget", () => {
    const third = source("third");
    expect(() =>
      plan({ ...base, measures: ["population", "gdp", "third"] }, [
        population,
        gdp,
        third,
      ]),
    ).toThrow(UdcError);
  });
  it("rejects missing hierarchy versions and invalid partition dimensions", () => {
    expect(() =>
      plan({ ...base, rollups: [{ ...rollups[0], revision: "v2" }] }),
    ).toThrow(UdcError);
    expect(() =>
      plan({
        ...base,
        dimensions: ["space"],
        topN: { measureId: "population", n: 2, partitionBy: ["time"] },
      }),
    ).toThrow(UdcError);
  });
  it("rejects cycles and unreferenced calculations", () => {
    expect(() =>
      plan({
        ...ratioQuery,
        calculatedMeasures: [
          { ...ratio, expression: { kind: "measure", measureId: "ratio" } },
        ],
      }),
    ).toThrow(UdcError);
    expect(() => plan({ ...base, calculatedMeasures: [ratio] })).toThrow(
      UdcError,
    );
  });
  it("does not accept tampered plans or changed snapshots and metadata", () => {
    const p = plan(base);
    expect(() =>
      executeQuery({ ...p, steps: [] }, { cubes: [population] }),
    ).toThrow(UdcError);
    const changed = {
      ...population,
      snapshots: [{ datasetId: "population", revision: "v2" }],
    };
    expect(() => executeQuery(p, { cubes: [changed] })).toThrow(UdcError);
    expect(() =>
      executeQuery(p, {
        cubes: [{ ...population, concordanceRevisions: ["v2"] }],
      }),
    ).toThrow(UdcError);
    expect(() => executeQuery(p, { cubes: [population, gdp] })).toThrow(
      UdcError,
    );
    expect(() => executeQuery(p, { cubes: [] })).toThrow(UdcError);
  });
});

describe("query execution", () => {
  it("selects dimensions, projects measures and preserves atomic lineage", () => {
    const input = integrateCubes(population, gdp);
    // A single source may have multiple measures but must carry a single snapshot.
    const multi = { ...input, snapshots: population.snapshots };
    const result = run({ ...base, dimensions: ["time", "space"], filters }, [
      multi,
    ]);
    expect(result.dimensions.map((d) => d.id)).toEqual(["time", "space"]);
    expect(result.observations).toHaveLength(3);
    for (const row of result.observations) {
      expect(Object.keys(row.values)).toEqual(["population"]);
      expect(row.values.population).toEqual(
        population.observations.find((o) => o.cellKey === row.cellKey)?.values
          .population,
      );
    }
  });
  it("golden GDP-per-capita query matches manual operator composition", () => {
    const q: QuerySpec = {
      ...ratioQuery,
      filters,
      rollups,
      measureFilter: {
        kind: "compare",
        measureId: "ratio",
        operator: "gt",
        value: 0,
      },
      topN: { measureId: "ratio", n: 1, partitionBy: ["time"] },
    };
    const actual = run(q, [population, gdp]);
    const joined = integrateCubes(
      diceCube(gdp, filters),
      diceCube(population, filters),
    );
    const manual = topNCube(
      filterCube(
        calculateMeasure(
          rollupCube(joined, hierarchy, rollups[0].targetMembers),
          ratio,
        ),
        q.measureFilter!,
      ),
      q.topN!,
    );
    expect(actual.observations.map((o) => o.cellKey)).toEqual(
      manual.observations.map((o) => o.cellKey),
    );
    expect(actual.observations[0].values.ratio).toEqual(
      manual.observations[0].values.ratio,
    );
    expect(actual.observations[0].values.ratio?.value).toBe(17.5);
    expect(Object.keys(actual.observations[0].values)).toEqual(["ratio"]);
    expect(actual.hierarchyRollups).toEqual(manual.hierarchyRollups);
  });
  it("aggregates before calculating and retains operand provenance", () => {
    const actual = run({ ...ratioQuery, dimensions: ["time"], filters }, [
      population,
      gdp,
    ]);
    const manual = calculateMeasure(
      aggregateCube(diceCube(integrateCubes(gdp, population), filters), [
        "time",
      ]),
      ratio,
    );
    expect(actual.observations[0].values.ratio).toEqual(
      manual.observations[0].values.ratio,
    );
    expect(actual.observations[0].values.ratio?.value).toBe(1600 / 130);
  });
  it("uses explicit derived count identity on aggregation", () => {
    const count = source("countable", populationRows, "countable", "count");
    const result = run(
      { ...base, dimensions: [], measures: ["countable:count"] },
      [count],
    );
    expect(result.observations[0].values["countable:count"]?.value).toBe(4);
    expect(() =>
      run({ ...base, dimensions: [], measures: ["countable"] }, [count]),
    ).toThrow(UdcError);
  });
  it("does not aggregate an unused non-additive measure", () => {
    const other = source("unused", populationRows, "unused", "none");
    const combined = {
      ...integrateCubes(population, other),
      snapshots: population.snapshots,
    };
    const result = run({ ...base, dimensions: [], filters }, [combined]);
    expect(result.observations[0].values.population?.value).toBe(130);
    expect(() =>
      run({ ...base, dimensions: [], measures: ["unused"] }, [combined]),
    ).toThrow(UdcError);
  });
  it("supports scalar output, empty filters and hidden predicate dependencies", () => {
    expect(
      run({ ...base, dimensions: [] }).observations[0].values.population?.value,
    ).toBe(150);
    expect(
      run({ ...base, filters: [{ dimensionId: "time", memberIds: [] }] })
        .observations,
    ).toEqual([]);
    const result = run(
      {
        ...base,
        measureFilter: {
          kind: "compare",
          measureId: "gdp",
          operator: "gt",
          value: 500,
        },
      },
      [population, gdp],
    );
    expect(result.observations).toHaveLength(4);
    expect(result.measures.map((m) => m.id)).toEqual(["population"]);
  });
  it("preserves sparse absence versus present null and honors directional anchor", () => {
    const sparse = source("gdp", [
      ["a", "2020", null],
      ["d", "2020", 1],
    ]);
    const query: QuerySpec = {
      ...base,
      measures: ["population", "gdp"],
      join: "full",
    };
    const result = run(query, [population, sparse]);
    expect(result.inputStage).toBe("sparse-integrated");
    expect(result.observations).toHaveLength(6);
    expect(
      result.observations.filter((o) => !Object.hasOwn(o.values, "gdp")),
    ).toHaveLength(4);
    expect(
      result.observations.filter((o) => o.values.gdp?.value === null),
    ).toHaveLength(1);
    const left = run({ ...query, join: "left", joinAnchor: "population" }, [
      population,
      sparse,
    ]);
    const right = run({ ...query, join: "right", joinAnchor: "population" }, [
      population,
      sparse,
    ]);
    expect(left.observations.map((o) => o.cellKey)).toEqual(
      right.observations.map((o) => o.cellKey),
    );
    expect(left.observations).toHaveLength(5);
    expect(() =>
      run({ ...query, dimensions: ["time"] }, [population, sparse]),
    ).toThrow(UdcError);
    expect(() => run({ ...query, rollups }, [population, sparse])).toThrow(
      UdcError,
    );
  });
  it("keeps null ratios unranked and supports partitioned ties", () => {
    const result = run(
      {
        ...ratioQuery,
        topN: {
          measureId: "ratio",
          n: 1,
          partitionBy: ["time"],
          ties: "include",
        },
      },
      [population, gdp],
    );
    expect(result.observations.map((o) => o.values.ratio?.value)).toEqual([
      20, 30,
    ]);
    expect(
      run({ ...ratioQuery, topN: { measureId: "ratio", n: 0 } }, [
        population,
        gdp,
      ]).observations,
    ).toEqual([]);
  });
  it("rejects malformed source rows before filtering", () => {
    const malformed = {
      ...population,
      observations: [...population.observations, population.observations[0]],
    };
    expect(() =>
      run({ ...base, filters: [{ dimensionId: "time", memberIds: [] }] }, [
        malformed,
      ]),
    ).toThrow(UdcError);
  });
  it("is invariant to reversed source and row order and does not mutate inputs", () => {
    const before = JSON.stringify([population, gdp, ratioQuery]);
    const reverse = (cube: CanonicalCube) => ({
      ...cube,
      observations: [...cube.observations].reverse(),
    });
    expect(run(ratioQuery, [reverse(gdp), reverse(population)])).toEqual(
      run(ratioQuery, [population, gdp]),
    );
    expect(JSON.stringify([population, gdp, ratioQuery])).toBe(before);
  });
});

describe("query edge cases and error contracts", () => {
  it.each([
    { ...base, dimensions: "space" },
    { ...base, dimensions: [1] },
    { ...base, dimensions: [""] },
    { ...base, filters: [{ dimensionId: "time", memberIds: "2020" }] },
    { ...base, rollups: [...rollups, ...rollups] },
    { ...base, rollups: [{ ...rollups[0], targetMembers: ["east", "east"] }] },
    { ...base, topN: { measureId: "population", n: "1" } },
    { ...base, topN: { measureId: "population", n: 1.5 } },
    { ...base, topN: { measureId: "population", n: 1, direction: "up" } },
    { ...base, topN: { measureId: "population", n: 1, method: "other" } },
    {
      ...base,
      topN: { measureId: "population", n: 1, partitionBy: ["time", "time"] },
    },
    { ...base, measureFilter: { kind: "unknown" } },
    {
      ...base,
      measureFilter: {
        kind: "compare",
        measureId: "population",
        operator: "like",
        value: 1,
      },
    },
    {
      ...base,
      measureFilter: {
        kind: "compare",
        measureId: "population",
        operator: "eq",
        value: "1",
      },
    },
    { ...base, measureFilter: { kind: "not", operand: null } },
    { ...ratioQuery, calculatedMeasures: [{ ...ratio, name: "" }] },
    { ...ratioQuery, calculatedMeasures: [{ ...ratio, name: 12 }] },
    {
      ...ratioQuery,
      calculatedMeasures: [{ ...ratio, name: "x".repeat(257) }],
    },
    {
      ...ratioQuery,
      calculatedMeasures: [{ ...ratio, expression: { kind: "unknown" } }],
    },
    {
      ...ratioQuery,
      calculatedMeasures: [
        { ...ratio, expression: { ...ratio.expression, operator: "**" } },
      ],
    },
    {
      ...ratioQuery,
      calculatedMeasures: [
        { ...ratio, expression: { kind: "constant", value: NaN } },
      ],
    },
    {
      ...ratioQuery,
      calculatedMeasures: [
        {
          ...ratio,
          expression: { kind: "measure", measureId: "gdp", value: 1 },
        },
      ],
    },
  ])("rejects additional malformed JSON case %#", (query) => {
    expect(() => validateQuery(query)).toThrow(UdcError);
  });

  it("enforces independent tree-node and collection budgets", () => {
    const leaf = { kind: "constant", value: 1 };
    const tree = (depth: number): unknown =>
      depth === 0
        ? leaf
        : {
            kind: "binary",
            operator: "+",
            left: tree(depth - 1),
            right: tree(depth - 1),
          };
    expect(() =>
      validateQuery({
        ...ratioQuery,
        calculatedMeasures: [{ ...ratio, expression: tree(6) }],
      }),
    ).toThrow(expect.objectContaining({ code: "LIMIT" }));
    expect(() =>
      validateQuery({
        ...base,
        measureFilter: {
          kind: "or",
          operands: Array.from({ length: 100 }, () => ({
            kind: "isNull",
            measureId: "population",
          })),
        },
      }),
    ).toThrow(expect.objectContaining({ code: "LIMIT" }));
    expect(() =>
      validateQuery({
        ...base,
        dimensions: Array.from({ length: 101 }, (_, i) => "d" + i),
      }),
    ).toThrow(expect.objectContaining({ code: "LIMIT" }));
    expect(() =>
      validateQuery({
        ...base,
        filters: [
          { dimensionId: "time", memberIds: Array(10001).fill("2020") },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "LIMIT" }));
  });

  it("rejects invalid catalog declarations and ambiguous hierarchy metadata", () => {
    const entry = describeQuerySource(population);
    expect(() =>
      planQuery(base, {
        sources: [{ ...entry, dimensions: ["space", "space"] }],
      }),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE" }));
    expect(() =>
      planQuery(base, {
        sources: [
          { ...entry, measures: [entry.measures[0], entry.measures[0]] },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE" }));
    expect(() =>
      planQuery(base, {
        sources: [
          {
            ...entry,
            measures: [
              {
                ...entry.measures[0],
                aggregation: "invalid" as AggregationOperator,
              },
            ],
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(() =>
      planQuery(
        { ...base, rollups },
        { sources: [entry], hierarchies: [hierarchy, hierarchy] },
      ),
    ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() =>
      planQuery(
        { ...base, dimensions: ["time"], rollups },
        { sources: [entry], hierarchies: [hierarchy] },
      ),
    ).toThrow(expect.objectContaining({ code: "INCOMPATIBLE" }));
    const otherHierarchy = { ...hierarchy, key: "other" };
    expect(() =>
      planQuery(
        {
          ...base,
          rollups: [...rollups, { ...rollups[0], hierarchyKey: "other" }],
        },
        { sources: [entry], hierarchies: [hierarchy, otherHierarchy] },
      ),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE" }));
  });

  it("distinguishes missing measure, incompatible grain and ambiguous providers", () => {
    expect(() => plan({ ...base, measures: ["missing"] })).toThrow(
      expect.objectContaining({ code: "UNRESOLVED" }),
    );
    expect(() => plan({ ...base, dimensions: ["missing"] })).toThrow(
      expect.objectContaining({ code: "INCOMPATIBLE" }),
    );
    expect(() =>
      plan(base, [
        population,
        source("population", populationRows, "alternative"),
      ]),
    ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => plan({ ...base, join: "left", joinAnchor: "gdp" })).toThrow(
      expect.objectContaining({ code: "INVALID" }),
    );
    expect(() => plan({ ...base, join: "full" })).toThrow(
      expect.objectContaining({ code: "INCOMPATIBLE" }),
    );
  });

  it("supports constant arithmetic and rejects queries without a source measure", () => {
    const constant = {
      ...ratio,
      expression: { kind: "constant", value: 7 } as const,
    };
    expect(() =>
      plan({ ...ratioQuery, calculatedMeasures: [constant] }),
    ).toThrow(expect.objectContaining({ code: "UNRESOLVED" }));
    const result = run({
      ...base,
      measures: ["population", "ratio"],
      calculatedMeasures: [constant],
    });
    expect(result.observations.map((row) => row.values.ratio?.value)).toEqual(
      Array(5).fill(7),
    );
    expect(result.observations[0].values.ratio).toEqual({
      value: 7,
      inputs: [],
    });
  });

  it("resolves all hidden predicate leaves, including negation and ranges", () => {
    const result = run(
      {
        ...base,
        measureFilter: {
          kind: "and",
          operands: [
            { kind: "range", measureId: "gdp", min: 500, max: 900 },
            {
              kind: "not",
              operand: { kind: "isNull", measureId: "population" },
            },
            {
              kind: "or",
              operands: [
                {
                  kind: "compare",
                  measureId: "gdp",
                  operator: "gte",
                  value: 600,
                },
                { kind: "isAbsent", measureId: "gdp" },
              ],
            },
          ],
        },
      },
      [population, gdp],
    );
    expect(
      result.observations
        .map((row) => row.values.population?.value)
        .sort((a, b) => a! - b!),
    ).toEqual([20, 30, 90]);
    expect(result.measures.map((m) => m.id)).toEqual(["population"]);
  });

  it("applies ranking to a hidden measure before projection", () => {
    const result = run(
      {
        ...base,
        topN: {
          measureId: "gdp",
          n: 1,
          direction: "asc",
          method: "ordinal",
          partitionBy: ["time"],
        },
      },
      [population, gdp],
    );
    expect(
      result.observations.map((row) => row.values.population?.value),
    ).toEqual([10, 20]);
    expect(
      result.observations.every((row) => !Object.hasOwn(row.values, "gdp")),
    ).toBe(true);
  });

  it("preserves zero, null and absent calculated values through outer joins", () => {
    const denominator = source("population", [
      ["a", "2020", 0],
      ["b", "2020", 10],
      ["c", "2020", 5],
      ["d", "2020", 2],
    ]);
    const numerator = source("gdp", [
      ["a", "2020", 10],
      ["b", "2020", 0],
      ["c", "2020", null],
      ["e", "2020", 3],
    ]);
    const query: QuerySpec = { ...ratioQuery, join: "full" };
    const result = run(query, [denominator, numerator]);
    const at = (id: string) =>
      result.observations.find((row) =>
        row.coordinate.members.some(
          (m) => m.dimensionId === "space" && m.id === id,
        ),
      )!;
    expect(at("a").values.ratio?.value).toBeNull();
    expect(at("b").values.ratio?.value).toBe(0);
    expect(at("c").values.ratio?.value).toBeNull();
    expect(Object.hasOwn(at("d").values, "ratio")).toBe(false);
    expect(Object.hasOwn(at("e").values, "ratio")).toBe(false);
    expect(result.join).toBe("full");
    expect(result.definition).toEqual(ratio);
    for (const [kind, expected] of [
      ["isAbsent", 2],
      ["isNull", 2],
    ] as const) {
      expect(
        run({ ...query, measureFilter: { kind, measureId: "ratio" } }, [
          denominator,
          numerator,
        ]).observations,
      ).toHaveLength(expected);
    }
    expect(
      run({ ...query, topN: { measureId: "ratio", n: 10 } }, [
        denominator,
        numerator,
      ]).observations,
    ).toHaveLength(1);
  });

  it("composes weighted averages through a hierarchy and dimension reduction", () => {
    const average = source(
      "population",
      populationRows,
      "population",
      "average",
    );
    const result = run({ ...base, dimensions: ["space"], rollups }, [average]);
    const east = result.observations.find(
      (row) => row.coordinate.members[0].id === "east",
    )!;
    expect(east.values.population).toMatchObject({
      value: 20,
      state: { sum: 60, count: 3 },
    });
    expect(result.hierarchyRollups).toHaveLength(1);
  });

  it("returns empty results with the planned output schema", () => {
    const empty = source("population", []);
    const result = run(base, [empty]);
    expect(result.measures.map((m) => m.id)).toEqual(["population"]);
    expect(result.dimensions.map((d) => d.id)).toEqual(["space", "time"]);
    expect(result.observations).toEqual([]);
    expect(result.snapshots).toEqual(empty.snapshots);
  });

  it("rejects corrupted input coordinates, measure sets and values", () => {
    const row = population.observations[0];
    const coordinate = { members: [canonicalMember("space", "a")] };
    const wrongAxis = {
      members: [
        canonicalMember("space", "a"),
        canonicalMember("other", "2020"),
      ],
    };
    const malformedRows = [
      { ...row, cellKey: "invalid" },
      { ...row, coordinate, cellKey: getCellKey(coordinate) },
      { ...row, coordinate: wrongAxis, cellKey: getCellKey(wrongAxis) },
      { ...row, values: {} },
      { ...row, values: { other: row.values.population } },
      {
        ...row,
        values: { population: { ...row.values.population, value: Infinity } },
      },
      {
        ...row,
        values: {
          population: { ...row.values.population, provenance: undefined },
        },
      },
    ];
    for (const malformed of malformedRows) {
      expect(() =>
        run(base, [{ ...population, observations: [malformed as typeof row] }]),
      ).toThrow(UdcError);
    }
  });

  it("rejects malformed plans and over-budget execution inputs", () => {
    const p = plan(base);
    expect(() =>
      executeQuery({ ...p, version: 2 } as unknown as typeof p, {
        cubes: [population],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(() =>
      executeQuery(p, { cubes: [population, gdp, source("third")] }),
    ).toThrow(expect.objectContaining({ code: "LIMIT" }));
    expect(() =>
      executeQuery(p, {
        cubes: [
          {
            ...population,
            observations: Array(10001).fill(population.observations[0]),
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "LIMIT" }));
  });

  it("detaches plan metadata from mutable input objects", () => {
    const query = { ...base, measures: ["population"] };
    const entry = describeQuerySource(population);
    const p = planQuery(query, { sources: [entry] });
    query.measures.push("gdp");
    entry.snapshot.revision = "v2";
    expect(p.query.measures).toEqual(["population"]);
    expect(p.sources[0].source.snapshot.revision).toBe("v1");
    expect(executeQuery(p, { cubes: [population] }).observations).toHaveLength(
      5,
    );
  });
});

describe("query planner and executor coverage boundaries", () => {
  it("rejects distinct output IDs that collide at the raw source grain", () => {
    const counted = source("metric", populationRows, "counted", "count");
    const summed = source("metric", populationRows, "summed", "sum");
    expect(() =>
      plan(
        { ...base, dimensions: [], measures: ["metric", "metric:count"] },
        [counted, summed],
      ),
    ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("rejects a calculated ID that collides with a raw count operand", () => {
    const counted = source("metric", populationRows, "counted", "count");
    expect(() =>
      plan(
        {
          ...base,
          dimensions: [],
          measures: ["metric"],
          calculatedMeasures: [
            {
              ...ratio,
              id: "metric",
              expression: { kind: "measure", measureId: "metric:count" },
            },
          ],
        },
        [counted],
      ),
    ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("projects multiple measures from a single source in requested order", () => {
    const multi: CanonicalCube = {
      ...population,
      measures: [...population.measures, ...gdp.measures],
      observations: population.observations.map((row, i) => ({
        ...row,
        values: {
          ...row.values,
          gdp: {
            ...gdp.observations[i].values.gdp,
            provenance: {
              ...gdp.observations[i].values.gdp.provenance,
              snapshot: population.snapshots[0],
            },
          },
        },
      })),
    };
    const query: QuerySpec = {
      ...base,
      measures: ["population", "gdp"],
      join: "inner",
    };
    const result = run(query, [multi]);
    expect(result.measures.map((m) => m.id)).toEqual(query.measures);
    expect(result.observations).toHaveLength(5);
    for (const row of result.observations) {
      expect(row.values).toEqual(
        multi.observations.find((o) => o.cellKey === row.cellKey)?.values,
      );
    }
    expect(
      run(query, [{ ...multi, measures: [...multi.measures].reverse() }]),
    ).toEqual(result);
  });

  it("accepts repeated member selectors without duplicating observations", () => {
    const result = run({
      ...base,
      filters: [{ dimensionId: "time", memberIds: ["2020", "2020"] }],
    });
    expect(result.observations).toHaveLength(3);
    expect(new Set(result.observations.map((row) => row.cellKey)).size).toBe(3);
  });
});

describe("query ordering and limits", () => {
  const orderBy = [
    { kind: "dimension", dimensionId: "time", direction: "asc" },
    { kind: "measure", measureId: "population", direction: "desc" },
  ] as const;

  it("orders lexicographically by multiple keys and limits globally", () => {
    const query: QuerySpec = { ...base, orderBy, limit: 4 };
    const result = run(query);
    expect(result.observations.map((r) => r.values.population?.value)).toEqual([
      90, 30, 10, 20,
    ]);
    expect(plan(query).steps).toEqual(["order", "limit", "project"]);
    const reversed = {
      ...population,
      observations: [...population.observations].reverse(),
    };
    expect(run(query, [reversed])).toEqual(result);
    expect(
      executeQuery(JSON.parse(JSON.stringify(plan(query))), {
        cubes: [population],
      }),
    ).toEqual(result);
  });

  it("preserves provenance and canonical tie breaking", () => {
    const tied = source("population", [
      ["b", "2020", 10],
      ["a", "2020", 10],
    ]);
    const query: QuerySpec = { ...base, orderBy: [orderBy[1]] };
    const result = run(query, [tied]);
    expect(result.observations).toEqual(run(base, [tied]).observations);
    expect(run({ ...query, limit: 1 }, [tied]).observations).toEqual(
      result.observations.slice(0, 1),
    );
  });

  it("puts numeric values before null and absent in either direction", () => {
    const sparse = source("gdp", [
      ["a", "2020", null],
      ["d", "2020", 1],
      ["c", "2020", 5],
    ]);
    for (const direction of ["asc", "desc"] as const) {
      const query: QuerySpec = {
        ...base,
        measures: ["population", "gdp"],
        join: "full",
        orderBy: [{ kind: "measure", measureId: "gdp", direction }],
      };
      const result = run(query, [population, sparse]);
      expect(result.observations.map((r) => r.values.gdp?.value)).toEqual([
        ...(direction === "asc" ? [1, 5] : [5, 1]),
        null,
        undefined,
        undefined,
        undefined,
      ]);
      expect(result.observations[2].values.gdp).toBeDefined();
      expect(Object.hasOwn(result.observations[3].values, "gdp")).toBe(false);
    }
  });

  it("orders after partitioned top-N and limits after sorting", () => {
    const result = run({
      ...base,
      topN: { measureId: "population", n: 1, partitionBy: ["time"] },
      orderBy: [{ kind: "measure", measureId: "population", direction: "asc" }],
      limit: 1,
    });
    expect(result.observations.map((r) => r.values.population?.value)).toEqual([
      20,
    ]);
  });

  it("sorts calculated measures and aggregated counts at final grain", () => {
    const result = run(
      {
        ...ratioQuery,
        filters,
        orderBy: [{ kind: "measure", measureId: "ratio", direction: "desc" }],
        limit: 1,
      },
      [population, gdp],
    );
    expect(result.observations[0].values.ratio?.value).toBe(20);
    const count = source("countable", populationRows, "countable", "count");
    const counted = run(
      {
        ...base,
        dimensions: ["time"],
        measures: ["countable:count"],
        orderBy: [
          { kind: "measure", measureId: "countable:count", direction: "asc" },
        ],
      },
      [count],
    );
    expect(
      counted.observations.map((r) => r.values["countable:count"]?.value),
    ).toEqual([1, 3]);
  });

  it("supports zero, omitted and oversized-within-budget limits", () => {
    expect(run({ ...base, limit: 0 }).observations).toEqual([]);
    expect(run({ ...base, limit: 0 }).measures).toEqual(run(base).measures);
    expect(run({ ...base, limit: 100 }).observations).toEqual(
      run(base).observations,
    );
    expect(run({ ...base, orderBy: [] })).toEqual(run(base));
  });

  it.each([
    { ...base, limit: -1 },
    { ...base, limit: 1.5 },
    { ...base, limit: 10001 },
    { ...base, limit: "2" },
    { ...base, orderBy: null },
    { ...base, orderBy: [{ ...orderBy[0], direction: "random" }] },
    { ...base, orderBy: [{ ...orderBy[0], measureId: "population" }] },
    { ...base, orderBy: [orderBy[0], orderBy[0]] },
  ])("rejects malformed order or limit %#", (query) => {
    expect(() => validateQuery(query)).toThrow(UdcError);
  });

  it("rejects hidden sort fields and tampered plans", () => {
    expect(() =>
      plan({ ...base, dimensions: ["space"], orderBy: [orderBy[0]] }),
    ).toThrow(UdcError);
    expect(() =>
      plan({
        ...base,
        orderBy: [{ kind: "measure", measureId: "gdp", direction: "desc" }],
      }),
    ).toThrow(UdcError);
    const p = plan({ ...base, orderBy, limit: 1 });
    expect(() =>
      executeQuery({ ...p, steps: ["project"] }, { cubes: [population] }),
    ).toThrow(UdcError);
  });
});
