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
  createInMemoryProvider,
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
  type DataProvider,
  type SourcePushdownCapabilities,
  type SourcePushdownRequest,
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
async function run(
  q: QuerySpec,
  cubes: readonly CanonicalCube[] = [population],
) {
  return executeQuery(plan(q, cubes), {
    provider: createInMemoryProvider(cubes),
    hierarchies: [hierarchy],
  });
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
  it("plans hidden operands, deterministic source order and a JSON round trip", async () => {
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
      await executeQuery(JSON.parse(JSON.stringify(a)), {
        provider: createInMemoryProvider([population, gdp]),
      }),
    ).toEqual(
      await executeQuery(b, {
        provider: createInMemoryProvider([gdp, population]),
      }),
    );
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
  it("does not accept tampered plans or changed snapshots and metadata", async () => {
    const p = plan(base);
    await expect(
      executeQuery(
        { ...p, steps: [] },
        { provider: createInMemoryProvider([population]) },
      ),
    ).rejects.toThrow(UdcError);
    const changed = {
      ...population,
      snapshots: [{ datasetId: "population", revision: "v2" }],
    };
    await expect(
      executeQuery(p, { provider: createInMemoryProvider([changed]) }),
    ).rejects.toThrow(UdcError);
    await expect(
      executeQuery(p, {
        provider: createInMemoryProvider([
          { ...population, concordanceRevisions: ["v2"] },
        ]),
      }),
    ).rejects.toThrow(UdcError);
    await expect(
      executeQuery(p, { provider: createInMemoryProvider([population, gdp]) }),
    ).rejects.toThrow(UdcError);
    await expect(
      executeQuery(p, { provider: createInMemoryProvider([]) }),
    ).rejects.toThrow(UdcError);
  });
});

describe("query execution", () => {
  it("selects dimensions, projects measures and preserves atomic lineage", async () => {
    const input = integrateCubes(population, gdp);
    // A single source may have multiple measures but must carry a single snapshot.
    const multi = { ...input, snapshots: population.snapshots };
    const result = await run(
      { ...base, dimensions: ["time", "space"], filters },
      [multi],
    );
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
  it("golden GDP-per-capita query matches manual operator composition", async () => {
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
    const actual = await run(q, [population, gdp]);
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
  it("aggregates before calculating and retains operand provenance", async () => {
    const actual = await run({ ...ratioQuery, dimensions: ["time"], filters }, [
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
  it("uses explicit derived count identity on aggregation", async () => {
    const count = source("countable", populationRows, "countable", "count");
    const result = await run(
      { ...base, dimensions: [], measures: ["countable:count"] },
      [count],
    );
    expect(result.observations[0].values["countable:count"]?.value).toBe(4);
    await expect(
      run({ ...base, dimensions: [], measures: ["countable"] }, [count]),
    ).rejects.toThrow(UdcError);
  });
  it("does not aggregate an unused non-additive measure", async () => {
    const other = source("unused", populationRows, "unused", "none");
    const combined = {
      ...integrateCubes(population, other),
      snapshots: population.snapshots,
    };
    const result = await run({ ...base, dimensions: [], filters }, [combined]);
    expect(result.observations[0].values.population?.value).toBe(130);
    await expect(
      run({ ...base, dimensions: [], measures: ["unused"] }, [combined]),
    ).rejects.toThrow(UdcError);
  });
  it("supports scalar output, empty filters and hidden predicate dependencies", async () => {
    expect(
      (await run({ ...base, dimensions: [] })).observations[0].values.population
        ?.value,
    ).toBe(150);
    expect(
      (
        await run({
          ...base,
          filters: [{ dimensionId: "time", memberIds: [] }],
        })
      ).observations,
    ).toEqual([]);
    const result = await run(
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
  it("preserves sparse absence versus present null and honors directional anchor", async () => {
    const sparse = source("gdp", [
      ["a", "2020", null],
      ["d", "2020", 1],
    ]);
    const query: QuerySpec = {
      ...base,
      measures: ["population", "gdp"],
      join: "full",
    };
    const result = await run(query, [population, sparse]);
    expect(result.inputStage).toBe("sparse-integrated");
    expect(result.observations).toHaveLength(6);
    expect(
      result.observations.filter((o) => !Object.hasOwn(o.values, "gdp")),
    ).toHaveLength(4);
    expect(
      result.observations.filter((o) => o.values.gdp?.value === null),
    ).toHaveLength(1);
    const left = await run(
      { ...query, join: "left", joinAnchor: "population" },
      [population, sparse],
    );
    const right = await run(
      { ...query, join: "right", joinAnchor: "population" },
      [population, sparse],
    );
    expect(left.observations.map((o) => o.cellKey)).toEqual(
      right.observations.map((o) => o.cellKey),
    );
    expect(left.observations).toHaveLength(5);
    await expect(
      run({ ...query, dimensions: ["time"] }, [population, sparse]),
    ).rejects.toThrow(UdcError);
    await expect(
      run({ ...query, rollups }, [population, sparse]),
    ).rejects.toThrow(UdcError);
  });
  it("keeps null ratios unranked and supports partitioned ties", async () => {
    const result = await run(
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
      (
        await run({ ...ratioQuery, topN: { measureId: "ratio", n: 0 } }, [
          population,
          gdp,
        ])
      ).observations,
    ).toEqual([]);
  });
  it("rejects malformed source rows before filtering", async () => {
    const malformed = {
      ...population,
      observations: [...population.observations, population.observations[0]],
    };
    await expect(
      run({ ...base, filters: [{ dimensionId: "time", memberIds: [] }] }, [
        malformed,
      ]),
    ).rejects.toThrow(UdcError);
  });
  it("is invariant to reversed source and row order and does not mutate inputs", async () => {
    const before = JSON.stringify([population, gdp, ratioQuery]);
    const reverse = (cube: CanonicalCube) => ({
      ...cube,
      observations: [...cube.observations].reverse(),
    });
    expect(await run(ratioQuery, [reverse(gdp), reverse(population)])).toEqual(
      await run(ratioQuery, [population, gdp]),
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

  it("supports constant arithmetic and rejects queries without a source measure", async () => {
    const constant = {
      ...ratio,
      expression: { kind: "constant", value: 7 } as const,
    };
    expect(() =>
      plan({ ...ratioQuery, calculatedMeasures: [constant] }),
    ).toThrow(expect.objectContaining({ code: "UNRESOLVED" }));
    const result = await run({
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

  it("resolves all hidden predicate leaves, including negation and ranges", async () => {
    const result = await run(
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

  it("applies ranking to a hidden measure before projection", async () => {
    const result = await run(
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

  it("preserves zero, null and absent calculated values through outer joins", async () => {
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
    const result = await run(query, [denominator, numerator]);
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
        (
          await run({ ...query, measureFilter: { kind, measureId: "ratio" } }, [
            denominator,
            numerator,
          ])
        ).observations,
      ).toHaveLength(expected);
    }
    expect(
      (
        await run({ ...query, topN: { measureId: "ratio", n: 10 } }, [
          denominator,
          numerator,
        ])
      ).observations,
    ).toHaveLength(1);
  });

  it("composes weighted averages through a hierarchy and dimension reduction", async () => {
    const average = source(
      "population",
      populationRows,
      "population",
      "average",
    );
    const result = await run({ ...base, dimensions: ["space"], rollups }, [
      average,
    ]);
    const east = result.observations.find(
      (row) => row.coordinate.members[0].id === "east",
    )!;
    expect(east.values.population).toMatchObject({
      value: 20,
      state: { sum: 60, count: 3 },
    });
    expect(result.hierarchyRollups).toHaveLength(1);
  });

  it("returns empty results with the planned output schema", async () => {
    const empty = source("population", []);
    const result = await run(base, [empty]);
    expect(result.measures.map((m) => m.id)).toEqual(["population"]);
    expect(result.dimensions.map((d) => d.id)).toEqual(["space", "time"]);
    expect(result.observations).toEqual([]);
    expect(result.snapshots).toEqual(empty.snapshots);
  });

  it("rejects corrupted input coordinates, measure sets and values", async () => {
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
      await expect(
        run(base, [{ ...population, observations: [malformed as typeof row] }]),
      ).rejects.toThrow(UdcError);
    }
  });

  it("rejects malformed plans and over-budget execution inputs", async () => {
    const p = plan(base);
    await expect(
      executeQuery({ ...p, version: 2 } as unknown as typeof p, {
        provider: createInMemoryProvider([population]),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID" }));
    await expect(
      executeQuery(p, {
        provider: createInMemoryProvider([population, gdp, source("third")]),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "LIMIT" }));
    await expect(
      executeQuery(p, {
        provider: createInMemoryProvider([
          {
            ...population,
            observations: Array(10001).fill(population.observations[0]),
          },
        ]),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "LIMIT" }));
  });

  it("detaches plan metadata from mutable input objects", async () => {
    const query = { ...base, measures: ["population"] };
    const entry = describeQuerySource(population);
    const p = planQuery(query, { sources: [entry] });
    query.measures.push("gdp");
    entry.snapshot.revision = "v2";
    expect(p.query.measures).toEqual(["population"]);
    expect(p.sources[0].source.snapshot.revision).toBe("v1");
    expect(
      (
        await executeQuery(p, {
          provider: createInMemoryProvider([population]),
        })
      ).observations,
    ).toHaveLength(5);
  });
});

describe("query planner and executor coverage boundaries", () => {
  it("rejects distinct output IDs that collide at the raw source grain", () => {
    const counted = source("metric", populationRows, "counted", "count");
    const summed = source("metric", populationRows, "summed", "sum");
    expect(() =>
      plan({ ...base, dimensions: [], measures: ["metric", "metric:count"] }, [
        counted,
        summed,
      ]),
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

  it("projects multiple measures from a single source in requested order", async () => {
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
    const result = await run(query, [multi]);
    expect(result.measures.map((m) => m.id)).toEqual(query.measures);
    expect(result.observations).toHaveLength(5);
    for (const row of result.observations) {
      expect(row.values).toEqual(
        multi.observations.find((o) => o.cellKey === row.cellKey)?.values,
      );
    }
    expect(
      await run(query, [{ ...multi, measures: [...multi.measures].reverse() }]),
    ).toEqual(result);
  });

  it("accepts repeated member selectors without duplicating observations", async () => {
    const result = await run({
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

  it("orders lexicographically by multiple keys and limits globally", async () => {
    const query: QuerySpec = { ...base, orderBy, limit: 4 };
    const result = await run(query);
    expect(result.observations.map((r) => r.values.population?.value)).toEqual([
      90, 30, 10, 20,
    ]);
    expect(plan(query).steps).toEqual(["order", "limit", "project"]);
    const reversed = {
      ...population,
      observations: [...population.observations].reverse(),
    };
    expect(await run(query, [reversed])).toEqual(result);
    expect(
      await executeQuery(JSON.parse(JSON.stringify(plan(query))), {
        provider: createInMemoryProvider([population]),
      }),
    ).toEqual(result);
  });

  it("preserves provenance and canonical tie breaking", async () => {
    const tied = source("population", [
      ["b", "2020", 10],
      ["a", "2020", 10],
    ]);
    const query: QuerySpec = { ...base, orderBy: [orderBy[1]] };
    const result = await run(query, [tied]);
    expect(result.observations).toEqual((await run(base, [tied])).observations);
    expect((await run({ ...query, limit: 1 }, [tied])).observations).toEqual(
      result.observations.slice(0, 1),
    );
  });

  it("puts numeric values before null and absent in either direction", async () => {
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
      const result = await run(query, [population, sparse]);
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

  it("orders after partitioned top-N and limits after sorting", async () => {
    const result = await run({
      ...base,
      topN: { measureId: "population", n: 1, partitionBy: ["time"] },
      orderBy: [{ kind: "measure", measureId: "population", direction: "asc" }],
      limit: 1,
    });
    expect(result.observations.map((r) => r.values.population?.value)).toEqual([
      20,
    ]);
  });

  it("sorts calculated measures and aggregated counts at final grain", async () => {
    const result = await run(
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
    const counted = await run(
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

  it("supports zero, omitted and oversized-within-budget limits", async () => {
    expect((await run({ ...base, limit: 0 })).observations).toEqual([]);
    expect((await run({ ...base, limit: 0 })).measures).toEqual(
      (await run(base)).measures,
    );
    expect((await run({ ...base, limit: 100 })).observations).toEqual(
      (await run(base)).observations,
    );
    expect(await run({ ...base, orderBy: [] })).toEqual(await run(base));
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

  it("rejects hidden sort fields and tampered plans", async () => {
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
    await expect(
      executeQuery(
        { ...p, steps: ["project"] },
        { provider: createInMemoryProvider([population]) },
      ),
    ).rejects.toThrow(UdcError);
  });
});

describe("async data providers", () => {
  it("acquires selected sources asynchronously with dependency and filter hints", async () => {
    const p = plan({ ...ratioQuery, filters }, [population, gdp]);
    const requests: string[] = [];
    const memory = createInMemoryProvider([population, gdp]);
    const result = await executeQuery(p, {
      provider: {
        sources: memory.sources,
        async loadSource(request) {
          await Promise.resolve();
          requests.push(request.source.snapshot.datasetId);
          expect(request.filters).toEqual(filters);
          expect(request.measureIds).toEqual(
            p.sources.find(
              (entry) =>
                entry.source.snapshot.datasetId ===
                request.source.snapshot.datasetId,
            )!.measureIds,
          );
          return memory.loadSource(request);
        },
      },
    });
    expect(requests).toEqual(p.sources.map((s) => s.source.snapshot.datasetId));
    expect(result).toEqual(
      await run({ ...ratioQuery, filters }, [population, gdp]),
    );
  });

  it("rejects tampered plans before acquisition", async () => {
    let calls = 0;
    const memory = createInMemoryProvider([population]);
    await expect(
      executeQuery(
        { ...plan(base), steps: [] },
        {
          provider: {
            sources: memory.sources,
            async loadSource(request) {
              calls++;
              return memory.loadSource(request);
            },
          },
        },
      ),
    ).rejects.toThrow(UdcError);
    expect(calls).toBe(0);
  });

  it("rejects wrong returned snapshots and propagates provider failures", async () => {
    const p = plan(base);
    const sources = [describeQuerySource(population)];
    await expect(
      executeQuery(p, {
        provider: {
          sources,
          async loadSource() {
            return gdp;
          },
        },
      }),
    ).rejects.toThrow(UdcError);
    const failure = new Error("remote source unavailable");
    await expect(
      executeQuery(p, {
        provider: {
          sources,
          async loadSource() {
            throw failure;
          },
        },
      }),
    ).rejects.toBe(failure);
  });
});

/** Simulate an exact backend using the independently composed pure operators. */
function pushdownProvider(
  cubes: readonly CanonicalCube[],
  capabilities: SourcePushdownCapabilities,
  requests: SourcePushdownRequest[],
): DataProvider {
  const memory = createInMemoryProvider(cubes);
  return {
    ...memory,
    pushdown: {
      capabilities: () => capabilities,
      async load(request) {
        requests.push(request);
        const raw = await memory.loadSource(request);
        const ids = request.pushdown.measureIds;
        const projected = {
          ...raw,
          measures: raw.measures
            .filter((m) => ids.includes(m.id))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
          observations: raw.observations.map((row) => ({
            ...row,
            values: Object.fromEntries(
              Object.entries(row.values).filter(([id]) => ids.includes(id)),
            ),
          })),
        };
        const subset = diceCube(projected, request.pushdown.filters);
        return request.pushdown.aggregateDimensions === undefined
          ? { kind: "subset", cube: subset }
          : {
              kind: "aggregate",
              cube: aggregateCube(subset, request.pushdown.aggregateDimensions),
            };
      },
    },
  };
}

describe("backend-neutral query pushdown", () => {
  const all = { filter: true, project: true, aggregate: true };
  it.each(["sum", "average", "count"] as const)(
    "matches local %s with nulls, scalar grain and empty filters",
    async (operator) => {
      const data = source("m", populationRows, "m", operator);
      for (const dimensions of [[], ["time"], ["space"]]) {
        for (const selection of [
          undefined,
          filters,
          [{ dimensionId: "time", memberIds: [] }],
        ]) {
          const q: QuerySpec = {
            version: 1,
            dimensions,
            measures: [operator === "count" ? "m:count" : "m"],
            ...(selection ? { filters: selection } : {}),
          };
          const requests: SourcePushdownRequest[] = [];
          const provider = pushdownProvider([data], all, requests);
          expect(await executeQuery(plan(q, [data]), { provider })).toEqual(
            await run(q, [data]),
          );
          expect(requests[0].pushdown.aggregateDimensions).toEqual(dimensions);
        }
      }
    },
  );

  it("keeps full grain across mixed providers, joins, rollups and calculations", async () => {
    for (const q of [
      { ...ratioQuery, dimensions: ["time"], filters },
      { ...ratioQuery, filters, rollups },
      {
        ...base,
        measures: ["population", "gdp"],
        join: "full" as const,
        filters,
      },
    ]) {
      const cubes = [population, gdp];
      const requests: SourcePushdownRequest[] = [];
      const provider = pushdownProvider(cubes, all, requests);
      const adapter = provider.pushdown!;
      adapter.capabilities = (s) => (s.snapshot.datasetId === "gdp" ? all : {});
      expect(
        await executeQuery(plan(q, cubes), {
          provider,
          hierarchies: [hierarchy],
        }),
      ).toEqual(await run(q, cubes));
      expect(requests).toHaveLength(1);
      expect(requests[0].pushdown.aggregateDimensions).toBeUndefined();
    }
  });

  it("projects unused measures and preserves original source provenance", async () => {
    const extra = source("unused", populationRows, "unused", "none");
    const multi = {
      ...integrateCubes(population, extra),
      snapshots: population.snapshots,
    };
    const q = { ...base, filters };
    const requests: SourcePushdownRequest[] = [];
    const provider = pushdownProvider([multi], all, requests);
    expect(await executeQuery(plan(q, [multi]), { provider })).toEqual(
      await run(q, [multi]),
    );
    expect(requests[0].pushdown.measureIds).toEqual(["population"]);
  });

  it("does not aggregate before a residual filter or a hierarchy rollup", async () => {
    for (const [q, caps] of [
      [{ ...base, dimensions: ["time"], filters }, { aggregate: true }],
      [{ ...base, filters, rollups }, all],
    ] as const) {
      const requests: SourcePushdownRequest[] = [];
      const provider = pushdownProvider([population], caps, requests);
      expect(
        await executeQuery(plan(q), { provider, hierarchies: [hierarchy] }),
      ).toEqual(await run(q));
      expect(
        requests.every((r) => r.pushdown.aggregateDimensions === undefined),
      ).toBe(true);
    }
    const nonAdditive = source(
      "population",
      populationRows,
      "population",
      "none",
    );
    const q = { ...base, dimensions: [] };
    const requests: SourcePushdownRequest[] = [];
    await expect(
      executeQuery(plan(q, [nonAdditive]), {
        provider: pushdownProvider([nonAdditive], all, requests),
      }),
    ).rejects.toThrow(UdcError);
    expect(requests).toHaveLength(0);
  });

  it("falls back only on explicit unsupported and propagates actual failures", async () => {
    const memory = createInMemoryProvider([population]);
    const q = { ...base, filters };
    const p = plan(q);
    let fullLoads = 0;
    const provider: DataProvider = {
      ...memory,
      async loadSource(request) {
        fullLoads++;
        return memory.loadSource(request);
      },
      pushdown: {
        capabilities: () => all,
        async load() {
          return { kind: "unsupported" };
        },
      },
    };
    expect(await executeQuery(p, { provider })).toEqual(await run(q));
    expect(fullLoads).toBe(1);
    const error = new Error("backend unavailable");
    provider.pushdown!.load = async () => {
      throw error;
    };
    await expect(executeQuery(p, { provider })).rejects.toBe(error);
    expect(fullLoads).toBe(1);
  });

  it("rejects out-of-filter rows, wrong revisions, missing provenance and incorrect result kind", async () => {
    const q = { ...base, filters };
    const memory = createInMemoryProvider([population]);
    const first = population.observations[0];
    for (const cube of [
      population,
      {
        ...diceCube(population, filters),
        snapshots: [{ datasetId: "population", revision: "wrong" }],
      },
      { ...diceCube(population, filters), observations: [first, first] },
      {
        ...diceCube(population, filters),
        observations: [{ ...first, values: {} }],
      },
    ]) {
      const provider: DataProvider = {
        ...memory,
        pushdown: {
          capabilities: () => all,
          async load() {
            return { kind: "subset", cube };
          },
        },
      };
      await expect(executeQuery(plan(q), { provider })).rejects.toThrow(
        UdcError,
      );
    }
    const provider: DataProvider = {
      ...memory,
      pushdown: {
        capabilities: () => all,
        async load() {
          return { kind: "aggregate", cube: aggregateCube(population, []) };
        },
      },
    };
    await expect(executeQuery(plan(q), { provider })).rejects.toThrow(UdcError);
  });

  it("rejects invalid aggregate accumulators, duplicated groups and lineage", async () => {
    const q = { ...base, dimensions: [] };
    const valid = aggregateCube(population, []);
    const row = valid.observations[0];
    const value = row.values.population;
    const memory = createInMemoryProvider([population]);
    for (const cube of [
      { ...valid, observations: [row, row] },
      ...[
        { ...value, value: 999 },
        { ...value, state: { sum: 150, count: -1 } },
        { ...value, contributors: [] },
        {
          ...value,
          contributors: [...value.contributors, value.contributors[0]],
        },
        {
          ...value,
          contributors: value.contributors.map((p) => ({
            ...p,
            snapshot: { ...p.snapshot, revision: "wrong" },
          })),
        },
      ].map((v) => ({
        ...valid,
        observations: [{ ...row, values: { population: v } }],
      })),
    ]) {
      const provider: DataProvider = {
        ...memory,
        pushdown: {
          capabilities: () => all,
          async load() {
            return { kind: "aggregate", cube };
          },
        },
      };
      await expect(executeQuery(plan(q), { provider })).rejects.toThrow(
        UdcError,
      );
    }
  });

  it("matches randomized subsets and aggregates with residual sorting and limits", async () => {
    let state = 147;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let i = 0; i < 30; i++) {
      const rows: Row[] = Array.from({ length: 20 }, (_, j) => [
        "c" + (j % 5),
        "y" + Math.floor(j / 5),
        random() % 4 === 0 ? null : (random() % 201) - 100,
      ]);
      const operator = (["sum", "average", "count"] as const)[i % 3];
      const data = source("m", rows, "m", operator);
      const dimensions = i % 2 ? ["space"] : ["time"];
      const id = operator === "count" ? "m:count" : "m";
      const q: QuerySpec = {
        version: 1,
        dimensions,
        measures: [id],
        filters: [
          {
            dimensionId: "space",
            memberIds: ["c" + (random() % 5), "c" + (random() % 5)],
          },
        ],
        orderBy: [{ kind: "measure", measureId: id, direction: "desc" }],
        limit: random() % 5,
      };
      const provider = pushdownProvider([data], all, []);
      expect(await executeQuery(plan(q, [data]), { provider })).toEqual(
        await run(q, [data]),
      );
    }
  });
});
