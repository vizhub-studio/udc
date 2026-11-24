import { describe, expect, it } from "vitest";
import {
  aggregateCube,
  calculateMeasure,
  canonicalMember,
  codedRef,
  createHierarchy,
  diceCube,
  drilldownCube,
  filterCube,
  rankCube,
  topNCube,
  type MeasurePredicate,
  type RankOptions,
  getCellKey,
  integrateCubes,
  rollupCube,
  UdcError,
  type AggregationOperator,
  type CanonicalCube,
  type CalculatedMeasureDefinition,
  type MeasureExpression,
} from "../src";

const space = { id: "space", name: "Space" };
const time = { id: "time", name: "Year" };
const rows = [
  ["a", "2020", 10],
  ["b", "2020", 30],
  ["c", "2020", 90],
  ["a", "2021", 20],
  ["b", "2021", null],
] as const;

function cube(
  id = "population",
  aggregation: AggregationOperator = "sum",
  input: readonly (readonly [string, string, number | null])[] = rows,
): CanonicalCube {
  const snapshot = { datasetId: id, revision: "v1" };
  return {
    stage: "canonical",
    dimensions: [space, time],
    measures: [{ id, name: id, unit: "units", aggregation }],
    snapshots: [snapshot],
    schemaRevisions: ["schema-v1"],
    concordanceRevisions: ["concordance-v1"],
    observations: input.map(([country, year, value], index) => {
      const coordinate = {
        members: [canonicalMember("space", country), canonicalMember("time", year)],
      };
      return {
        coordinate,
        cellKey: getCellKey(coordinate),
        values: {
          [id]: {
            value,
            provenance: {
              snapshot,
              sourceRow: index + 1,
              sourceCoordinate: {
                members: [
                  codedRef("space", "countries", "v1", country),
                  codedRef("time", "years", "v1", year),
                ],
              },
              schemaId: "schema",
              schemaRevision: "v1",
              measureId: id,
              unit: "units",
            },
          },
        },
      };
    }),
  };
}

const hierarchy = createHierarchy({
  key: "geography",
  dimensionId: "space",
  revision: "v1",
  edges: [
    ["a", "east"],
    ["b", "east"],
    ["c", "west"],
    ["east", "world"],
    ["west", "world"],
  ].map(([child, parent], index) => ({
    child: canonicalMember("space", child),
    parent: canonicalMember("space", parent),
    provenance: {
      snapshot: { datasetId: "geography", revision: "v1" },
      sourceRow: index + 1,
      mappingRevision: "v1",
    },
  })),
});

const expr = (measureId: string): MeasureExpression => ({ kind: "measure", measureId });
const constant = (value: number): MeasureExpression => ({ kind: "constant", value });
const binary = (
  operator: "+" | "-" | "*" | "/",
  left: MeasureExpression,
  right: MeasureExpression,
): MeasureExpression => ({ kind: "binary", operator, left, right });
const definition = (expression: MeasureExpression): CalculatedMeasureDefinition => ({
  id: "derived",
  name: "Derived",
  unit: "units",
  expression,
});
const select2020 = [{ dimensionId: "time", memberIds: ["2020"] }];
const region = (observation: { coordinate: { members: readonly { dimensionId: string; id: string }[] } }) =>
  observation.coordinate.members.find((member) => member.dimensionId === "space")?.id;

describe("diceCube", () => {
  it("uses OR within a dimension and AND across dimensions without removing axes", () => {
    const input = cube();
    const before = JSON.stringify(input);
    const result = diceCube(input, [
      { dimensionId: "space", memberIds: ["a", "b", "a"] },
      ...select2020,
    ]);
    expect(result.dimensions).toEqual(input.dimensions);
    expect(result.observations).toEqual(input.observations.slice(0, 2));
    expect(JSON.stringify(input)).toBe(before);
  });
  it("handles empty and nonmatching selections", () => {
    const input = cube();
    expect(diceCube(input, []).observations).toEqual(input.observations);
    expect(diceCube(input, [{ dimensionId: "time", memberIds: [] }]).observations).toEqual([]);
    expect(diceCube(input, [{ dimensionId: "space", memberIds: ["unknown"] }]).observations).toEqual([]);
  });
  it("rejects invalid dimensions and duplicate dimension selections", () => {
    expect(() => diceCube(cube(), [{ dimensionId: "other", memberIds: ["a"] }])).toThrow(UdcError);
    expect(() => diceCube(cube(), [...select2020, ...select2020])).toThrow(UdcError);
    expect(() => diceCube(cube(), [{ dimensionId: "time", memberIds: [""] }])).toThrow(UdcError);
  });
  it("preserves sparse presence and aggregated sufficient statistics", () => {
    const left = cube();
    const right = cube("gdp", "sum", [["a", "2020", 100]]);
    const sparse = integrateCubes(left, right, { join: "full" });
    const selected = diceCube(sparse, select2020);
    expect(selected.stage).toBe("sparse-integrated");
    expect(selected.observations).toEqual(sparse.observations.filter((o) => o.coordinate.members.some((m) => m.id === "2020")));
    const aggregated = rollupCube(left, hierarchy, ["east", "west"]);
    expect(diceCube(aggregated, select2020).hierarchyRollups).toEqual(aggregated.hierarchyRollups);
  });
});

describe("rollupCube", () => {
  it("retains axes and collects all numeric and hierarchy evidence", () => {
    const input = diceCube(cube(), select2020);
    const result = rollupCube(input, hierarchy, ["east", "west"]);
    expect(result.stage).toBe("aggregated");
    expect(result.dimensions).toEqual(input.dimensions);
    const east = result.observations.find((o) => region(o) === "east")!;
    expect(east.values.population.value).toBe(40);
    expect(east.values.population.contributors.map((p) => p.sourceRow).sort()).toEqual([1, 2]);
    expect(result.hierarchyRollups?.[0].edges.map((edge) => edge.child.id)).toEqual(["a", "b", "c"]);
    expect(result.hierarchyRollups?.[0].revision).toBe("v1");
    expect(aggregateCube(result, ["space"]).hierarchyRollups).toEqual(result.hierarchyRollups);
  });
  it("uses weighted averages rather than averages of averages", () => {
    const input = diceCube(cube("population", "average"), select2020);
    const direct = rollupCube(input, hierarchy, ["world"]);
    const repeated = rollupCube(rollupCube(input, hierarchy, ["east", "west"]), hierarchy, ["world"]);
    expect(direct.observations[0].values.population.value).toBe(130 / 3);
    expect(repeated.observations[0].values.population.state).toEqual({ sum: 130, count: 3 });
    expect(repeated.observations[0].values.population.value).toBe(130 / 3);
    expect(repeated.hierarchyRollups).toHaveLength(2);
  });
  it("handles null, count and non-additive measures explicitly", () => {
    const input = cube("population", "count");
    const result = rollupCube(input, hierarchy, ["world"]);
    const y2021 = result.observations.find((o) => o.coordinate.members.some((m) => m.id === "2021"))!;
    expect(y2021.values["population:count"].value).toBe(1);
    const nulls = cube("population", "sum", [["a", "2020", null], ["b", "2020", null]]);
    expect(rollupCube(nulls, hierarchy, ["east"]).observations[0].values.population.value).toBeNull();
    expect(() => rollupCube(cube("population", "none"), hierarchy, ["world"])).toThrow(UdcError);
  });
  it("rejects overlap, uncovered coordinates, duplicate targets and mixed grain", () => {
    const input = cube();
    for (const targets of [["world", "east"], ["east"], ["unknown"], ["world", "world"], []]) {
      expect(() => rollupCube(input, hierarchy, targets)).toThrow(UdcError);
    }
    const mixed = cube("population", "sum", [["a", "2020", 10], ["east", "2020", 40]]);
    expect(() => rollupCube(mixed, hierarchy, ["world"])).toThrow(UdcError);
  });
  it("is order independent across permutations of input and target order", () => {
    const input = cube();
    const result = rollupCube(input, hierarchy, ["east", "west"]);
    for (let i = 0; i < input.observations.length; i++) {
      const shuffled = [...input.observations.slice(i), ...input.observations.slice(0, i)].reverse();
      expect(rollupCube({ ...input, observations: shuffled }, hierarchy, ["west", "east"])).toEqual(result);
    }
  });
});

describe("calculateMeasure", () => {
  it("evaluates arithmetic and nested expressions, keeping source lineage", () => {
    const input = cube();
    const result = calculateMeasure(input, definition(binary("/", binary("*", binary("+", expr("population"), constant(2)), constant(3)), binary("-", constant(5), constant(2)))));
    expect(result.stage).toBe("calculated");
    expect(result.measures.at(-1)?.aggregation).toBe("none");
    expect(result.observations[0].values.derived).toEqual({
      value: 12,
      inputs: [{ measureId: "population", contributors: [input.observations[0].values.population.provenance] }],
    });
    expect(result.observations[4].values.derived?.value).toBeNull();
  });
  it("returns null for division by zero and omits missing sparse operands", () => {
    expect(calculateMeasure(cube(), definition(binary("/", expr("population"), constant(0)))).observations[0].values.derived?.value).toBeNull();
    const sparse = integrateCubes(cube(), cube("gdp", "sum", [["a", "2020", 100]]), { join: "full" });
    const result = calculateMeasure(sparse, definition(binary("/", expr("gdp"), expr("population"))));
    expect(result.observations.find((o) => o.presence?.right)?.values.derived?.value).toBe(10);
    expect(result.observations.filter((o) => !o.presence?.right).every((o) => !Object.hasOwn(o.values, "derived"))).toBe(true);
  });
  it("rejects unknown measures, collisions, overflow and oversized expressions", () => {
    expect(() => calculateMeasure(cube(), definition(expr("missing")))).toThrow(UdcError);
    expect(() => calculateMeasure(cube(), { ...definition(constant(1)), id: "population" })).toThrow(UdcError);
    expect(() => calculateMeasure(cube(), definition(constant(Infinity)))).toThrow(UdcError);
    expect(() => calculateMeasure(cube(), definition(binary("*", constant(1e308), constant(1e308))))).toThrow(UdcError);
    let deep = constant(1);
    for (let i = 0; i < 40; i++) deep = binary("+", deep, constant(1));
    expect(() => calculateMeasure(cube(), definition(deep))).toThrow(UdcError);
  });
});

it("golden workflow: integrate GDP and population, dice, roll up, calculate regional GDP per capita", () => {
  const gdp = cube("gdp", "sum", [
    ["a", "2020", 100],
    ["b", "2020", 900],
    ["c", "2020", 1800],
    ["a", "2021", 200],
  ]);
  const joined = integrateCubes(cube(), gdp, { join: "inner" });
  const rolled = rollupCube(diceCube(joined, select2020), hierarchy, ["east", "west"]);
  const result = calculateMeasure(rolled, {
    id: "gdp-per-capita",
    name: "GDP per capita",
    unit: "USD/person",
    expression: binary("/", expr("gdp"), expr("population")),
  });
  const east = result.observations.find((o) => region(o) === "east")!;
  const west = result.observations.find((o) => region(o) === "west")!;
  expect(east.values["gdp-per-capita"]?.value).toBe(25);
  expect(west.values["gdp-per-capita"]?.value).toBe(20);
  expect(east.values["gdp-per-capita"]).toMatchObject({
    inputs: [
      { measureId: "gdp", contributors: [{ sourceRow: 1 }, { sourceRow: 2 }] },
      { measureId: "population", contributors: [{ sourceRow: 1 }, { sourceRow: 2 }] },
    ],
  });
  expect(result.hierarchyRollups?.[0].edges).toHaveLength(3);
});

const comparison = (operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte", value: number, measureId = "population"): MeasurePredicate =>
  ({ kind: "compare", measureId, operator, value });

describe("hierarchical drill-down", () => {
  it("navigates children and breadth-first descendants deterministically", () => {
    expect(hierarchy.children("world").map((m) => m.id)).toEqual(["east", "west"]);
    expect(hierarchy.descendants("world").map((m) => m.id)).toEqual(["east", "west", "a", "b", "c"]);
    expect(hierarchy.children("a")).toEqual([]);
    expect(hierarchy.descendants("unknown")).toEqual([]);
    expect(() => hierarchy.children(canonicalMember("time", "2020"))).toThrow(UdcError);
  });

  it("expands world into regions and preserves all other axes and lineage", () => {
    const input = cube();
    expect(drilldownCube(input, hierarchy, "world")).toEqual(
      rollupCube(input, hierarchy, ["east", "west"]),
    );
    const east = drilldownCube(input, hierarchy, "east");
    expect(east.dimensions).toEqual(input.dimensions);
    expect(east.observations.map(region)).not.toContain("c");
    expect(east.observations).toHaveLength(4);
    expect(east.observations.find((row) => region(row) === "a" && row.coordinate.members.some((m) => m.id === "2020"))?.values.population.contributors).toEqual([input.observations[0].values.population.provenance]);
    expect(east.hierarchyRollups?.[0].revision).toBe("v1");
  });

  it("uses weighted statistics from finer aggregated input", () => {
    const input = cube("population", "average");
    const fine = aggregateCube(input, ["space"]);
    const drilled = drilldownCube(fine, hierarchy, "world");
    const east = drilled.observations.find((row) => region(row) === "east")!;
    expect(east.values.population.value).toBe(20);
    expect(east.values.population.state).toEqual({ sum: 60, count: 3 });
    expect(east.values.population.contributors).toHaveLength(4);
  });

  it("does not synthesize unobserved children or periods", () => {
    const result = drilldownCube(cube("population", "sum", [["a", "2020", 10]]), hierarchy, "world");
    expect(result.observations.map(region)).toEqual(["east"]);
    expect(drilldownCube(cube("population", "sum", []), hierarchy, "world").observations).toEqual([]);
    expect(drilldownCube(cube("population", "sum", [["c", "2020", 10]]), hierarchy, "east").observations).toEqual([]);
  });

  it("rejects leaves, unknown parents, incompatible axes, parent totals and mixed grain", () => {
    const input = cube();
    expect(() => drilldownCube(input, hierarchy, "a")).toThrow(UdcError);
    expect(() => drilldownCube(input, hierarchy, "unknown")).toThrow(UdcError);
    expect(() => drilldownCube(aggregateCube(input, ["time"]), hierarchy, "world")).toThrow(UdcError);
    expect(() => drilldownCube(rollupCube(input, hierarchy, ["world"]), hierarchy, "world")).toThrow(UdcError);
    expect(() => drilldownCube(rollupCube(input, hierarchy, ["world"]), hierarchy, "east")).toThrow(UdcError);
    expect(() => drilldownCube(cube("population", "sum", [["a", "2020", 10], ["east", "2020", 40]]), hierarchy, "world")).toThrow(UdcError);
    expect(() => drilldownCube(cube("population", "sum", [["unknown", "2020", 10]]), hierarchy, "world")).toThrow(UdcError);
    expect(() => drilldownCube(cube("population", "none"), hierarchy, "world")).toThrow(UdcError);
    const sparse = integrateCubes(input, cube("gdp"), { join: "full" });
    // @ts-expect-error Sparse drill-down has no implicit missingness policy.
    expect(() => drilldownCube(sparse, hierarchy, "world")).toThrow(UdcError);
  });

  it("handles an unbalanced forest without inventing finer observations", () => {
    const forest = createHierarchy({
      key: "forest", dimensionId: "space", revision: "v2",
      edges: [
        ["a", "east"], ["b", "world"], ["east", "world"], ["c", "other"],
      ].map(([child, parent], index) => ({
        child: canonicalMember("space", child), parent: canonicalMember("space", parent),
        provenance: { snapshot: { datasetId: "forest" }, sourceRow: index + 1, mappingRevision: "v2" },
      })),
    });
    expect(forest.descendants("world").map((m) => m.id)).toEqual(["b", "east", "a"]);
    expect(drilldownCube(diceCube(cube(), select2020), forest, "world").observations.map(region).sort()).toEqual(["b", "east"]);
  });

  it("rejects revision-mismatched aggregated input", () => {
    const input = rollupCube(cube(), hierarchy, ["east", "west"]);
    expect(() => drilldownCube(input, { ...hierarchy, revision: "v2" }, "world")).toThrow(UdcError);
  });
});

describe("measure predicates", () => {
  it.each([
    ["eq", 30, [30]], ["ne", 30, [10, 90, 20]],
    ["lt", 30, [10, 20]], ["lte", 30, [10, 30, 20]],
    ["gt", 30, [90]], ["gte", 30, [30, 90]],
  ] as const)("supports %s, excluding nulls", (operator, value, expected) => {
    expect(filterCube(cube(), comparison(operator, value)).observations.map((row) => row.values.population.value)).toEqual(expected);
  });

  it("supports inclusive ranges and boolean composition without mutating observations", () => {
    const input = cube();
    const before = JSON.stringify(input);
    const result = filterCube(input, {
      kind: "and", operands: [
        { kind: "range", measureId: "population", min: 10, max: 30 },
        { kind: "not", operand: comparison("eq", 20) },
        { kind: "or", operands: [comparison("eq", 10), comparison("eq", 30)] },
      ],
    });
    expect(result.observations).toEqual(input.observations.slice(0, 2));
    expect(result.stage).toBe(input.stage);
    expect(JSON.stringify(input)).toBe(before);
    expect(filterCube(input, { kind: "isNull", measureId: "population" }).observations).toEqual([input.observations[4]]);
    expect(filterCube(input, { kind: "isAbsent", measureId: "population" }).observations).toEqual([]);
  });

  it("distinguishes absent, null and zero, including NOT and sparse flags", () => {
    const sparse = integrateCubes(cube(), cube("gdp", "sum", [["a", "2020", 0], ["b", "2020", null]]), { join: "full" });
    expect(filterCube(sparse, { kind: "isAbsent", measureId: "gdp" }).observations).toHaveLength(3);
    expect(filterCube(sparse, { kind: "isNull", measureId: "gdp" }).observations).toHaveLength(1);
    expect(filterCube(sparse, comparison("eq", 0, "gdp")).observations).toHaveLength(1);
    expect(filterCube(sparse, { kind: "not", operand: comparison("eq", 0, "gdp") }).observations).toEqual([]);
    const selected = filterCube(sparse, { kind: "or", operands: [{ kind: "isAbsent", measureId: "gdp" }, comparison("eq", 0, "gdp")] });
    expect(selected.stage).toBe("sparse-integrated");
    expect(selected.observations).toHaveLength(4);
    expect(selected.observations.filter((row) => !row.presence.right)).toHaveLength(3);
    expect(filterCube(sparse, { kind: "not", operand: { kind: "and", operands: [comparison("eq", 1, "gdp"), comparison("lt", 0)] } }).observations).toHaveLength(4);
  });

  it("retains aggregate and calculated lineage and permits dice after calculation", () => {
    const rolled = rollupCube(cube(), hierarchy, ["east", "west"]);
    const result = filterCube(rolled, comparison("gt", 30));
    expect(result.hierarchyRollups).toEqual(rolled.hierarchyRollups);
    expect(result.observations).toEqual(rolled.observations.filter((row) => (row.values.population.value ?? 0) > 30));
    const calculated = calculateMeasure(rolled, definition(binary("/", expr("population"), constant(2))));
    const selected = diceCube(filterCube(calculated, comparison("gt", 15, "derived")), select2020);
    expect(selected.stage).toBe("calculated");
    expect(selected.observations).toHaveLength(2);
    expect(selected.hierarchyRollups).toEqual(rolled.hierarchyRollups);
    expect(selected.observations[0].values.derived).toEqual(calculated.observations.find((row) => row.cellKey === selected.observations[0].cellKey)?.values.derived);
    // @ts-expect-error A selected derived ratio is still terminal for aggregation.
    expect(() => aggregateCube(selected, ["time"])).toThrow(UdcError);
    // @ts-expect-error A selected derived ratio cannot be rolled up.
    expect(() => rollupCube(selected, hierarchy, ["world"])).toThrow(UdcError);
  });

  it("validates all branches even with empty input, and bounds expression complexity", () => {
    const input = cube("population", "sum", []);
    expect(() => filterCube(input, comparison("eq", 1, "unknown"))).toThrow(UdcError);
    expect(() => filterCube(input, comparison("eq", Infinity))).toThrow(UdcError);
    expect(() => filterCube(input, { kind: "range", measureId: "population", min: 2, max: 1 })).toThrow(UdcError);
    expect(() => filterCube(input, { kind: "and", operands: [] })).toThrow(UdcError);
    expect(() => filterCube(input, { kind: "or", operands: Array.from({ length: 101 }, () => comparison("eq", 1)) })).toThrow(UdcError);
    let deep: MeasurePredicate = comparison("eq", 1);
    for (let i = 0; i < 33; i++) deep = { kind: "not", operand: deep };
    expect(() => filterCube(input, deep)).toThrow(UdcError);
  });
});

const tiesCube = () => cube("population", "sum", [
  ["d", "2020", -5], ["c", "2020", 8], ["b", "2020", 8], ["a", "2020", 10],
  ["a", "2021", 1], ["b", "2021", 2], ["c", "2021", null],
]);
const byYear: RankOptions = { measureId: "population", partitionBy: ["time"] };

describe("ranking and top-N", () => {
  it.each([
    ["ordinal", [1, 2, 3, 4]], ["competition", [1, 2, 2, 4]], ["dense", [1, 2, 2, 3]],
  ] as const)("supports %s ranks", (method, expected) => {
    const input = diceCube(tiesCube(), select2020);
    const ranked = rankCube(input, { ...byYear, method });
    expect(ranked.map((row) => row.rank)).toEqual(expected);
    expect(ranked.map((row) => row.value)).toEqual([10, 8, 8, -5]);
    expect(ranked.map((row) => region(input.observations.find((o) => o.cellKey === row.cellKey)!))).toEqual(["a", "b", "c", "d"]);
    expect(input.measures).toHaveLength(1);
  });

  it("ranks per partition and supports ascending and global ranking", () => {
    const input = tiesCube();
    expect(rankCube(input, { ...byYear, direction: "asc" }).map((row) => row.value)).toEqual([-5, 8, 8, 10, 1, 2]);
    expect(rankCube(input, { ...byYear, direction: "asc" }).map((row) => row.rank)).toEqual([1, 2, 2, 4, 1, 2]);
    expect(rankCube(input, { measureId: "population" }).map((row) => row.value)).toEqual([10, 8, 8, 2, 1, -5]);
    const multi = { ...byYear, partitionBy: ["space", "time"] };
    expect(rankCube(input, multi).every((row) => row.rank === 1)).toBe(true);
    expect(rankCube(input, multi)).toEqual(rankCube(input, { ...multi, partitionBy: ["time", "space"] }));
  });

  it("supports exact and inclusive cutoff ties, bottom-N, zero and oversized N", () => {
    const input = tiesCube();
    expect(topNCube(input, { ...byYear, n: 2 }).observations.map((row) => row.values.population.value)).toEqual([10, 8, 2, 1]);
    expect(topNCube(input, { ...byYear, n: 2, ties: "include", method: "dense" }).observations.map((row) => row.values.population.value)).toEqual([10, 8, 8, 2, 1]);
    expect(topNCube(input, { ...byYear, n: 1, direction: "asc" }).observations.map((row) => row.values.population.value)).toEqual([-5, 1]);
    expect(topNCube(input, { ...byYear, n: 0, ties: "include" }).observations).toEqual([]);
    expect(topNCube(input, { ...byYear, n: 100 }).observations).toHaveLength(6);
    expect(rankCube(cube("population", "sum", []), byYear)).toEqual([]);
  });

  it("preserves sparse presence and calculated provenance while excluding absent and null ranks", () => {
    const sparse = integrateCubes(cube(), cube("gdp", "sum", [["a", "2020", 100], ["b", "2020", null]]), { join: "full" });
    const selected = topNCube(sparse, { measureId: "gdp", n: 10 });
    expect(selected.observations).toHaveLength(1);
    expect(selected.observations[0].presence).toEqual({ left: true, right: true });
    const calculated = calculateMeasure(sparse, definition(binary("/", expr("gdp"), expr("population"))));
    const ranked = rankCube(calculated, { measureId: "derived" });
    expect(ranked.map((row) => row.value)).toEqual([10]);
    const top = topNCube(calculated, { measureId: "derived", n: 1 });
    expect(top.stage).toBe("calculated");
    expect(top.observations[0]).toEqual(calculated.observations.find((row) => row.cellKey === ranked[0].cellKey));
  });

  it("rejects invalid options, coordinates, duplicates, and non-finite values", () => {
    const input = tiesCube();
    expect(() => rankCube(input, { measureId: "unknown" })).toThrow(UdcError);
    expect(() => rankCube(input, { ...byYear, partitionBy: ["unknown"] })).toThrow(UdcError);
    expect(() => rankCube(input, { ...byYear, partitionBy: ["time", "time"] })).toThrow(UdcError);
    for (const n of [-1, 1.5, Infinity, 10001]) expect(() => topNCube(input, { ...byYear, n })).toThrow(UdcError);
    expect(() => rankCube({ ...input, observations: [input.observations[0], input.observations[0]] }, byYear)).toThrow(UdcError);
    expect(() => rankCube({ ...input, observations: [{ ...input.observations[0], cellKey: "bad" }] }, byYear)).toThrow(UdcError);
    expect(() => rankCube(cube("population", "sum", [["a", "2020", Infinity]]), byYear)).toThrow(UdcError);
  });

  it("is invariant to seeded permutations, preserves inputs, and matches a reference top-N", () => {
    const input = cube("population", "sum", Array.from({ length: 48 }, (_, i) => ["c" + i, "2020", (i * 17) % 11 - 5] as const));
    const expected = rankCube(input, byYear);
    const expectedTop = topNCube(input, { ...byYear, n: 10, ties: "include" });
    const original = JSON.stringify(input);
    let seed = 41;
    for (let iteration = 0; iteration < 50; iteration++) {
      const observations = [...input.observations];
      for (let i = observations.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [observations[i], observations[j]] = [observations[j], observations[i]];
      }
      const shuffled = { ...input, observations };
      const before = JSON.stringify(shuffled);
      expect(rankCube(shuffled, byYear)).toEqual(expected);
      expect(topNCube(shuffled, { ...byYear, n: 10, ties: "include" })).toEqual(expectedTop);
      const reference = observations.map((row) => row.values.population.value!).sort((a, b) => b - a);
      expect(expectedTop.observations.map((row) => row.values.population.value)).toEqual(reference.filter((value) => value >= reference[9]));
      expect(JSON.stringify(shuffled)).toBe(before);
    }
    expect(JSON.stringify(input)).toBe(original);
  });
});

it("golden workflow: GDP per capita, drill down to countries, filter and rank within each region and year", () => {
  const population = cube("population", "sum", [
    ["a", "2020", 2], ["b", "2020", 4], ["c", "2020", 1],
    ["a", "2021", 2], ["b", "2021", 4], ["c", "2021", 2],
  ]);
  const gdp = cube("gdp", "sum", [
    ["a", "2020", 20], ["b", "2020", 80], ["c", "2020", 90],
    ["a", "2021", 60], ["b", "2021", 80], ["c", "2021", 100],
  ]);
  const joined = integrateCubes(population, gdp);
  const before = JSON.stringify(joined);
  const outputs = ["east", "west"].map((parent) => {
    const countries = drilldownCube(joined, hierarchy, parent);
    const ratios = calculateMeasure(countries, definition(binary("/", expr("gdp"), expr("population"))));
    const filtered = filterCube(ratios, comparison("gte", 2));
    return topNCube(filtered, { measureId: "derived", partitionBy: ["time"], n: 10 });
  });
  expect(outputs.map((output) => output.observations.map((row) => [region(row), row.values.derived?.value]))).toEqual([
    [["b", 20], ["a", 10], ["a", 30], ["b", 20]], [["c", 50]],
  ]);
  expect(outputs[0].observations[0].values.derived).toMatchObject({
    inputs: [
      { measureId: "gdp", contributors: [{ sourceRow: 2 }] },
      { measureId: "population", contributors: [{ sourceRow: 2 }] },
    ],
  });
  expect(outputs[0].hierarchyRollups?.[0].revision).toBe("v1");
  expect(JSON.stringify(joined)).toBe(before);
});
