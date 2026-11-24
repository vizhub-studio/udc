import { describe, expect, it } from "vitest";
import {
  aggregateCube,
  calculateMeasure,
  canonicalMember,
  codedRef,
  createHierarchy,
  diceCube,
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
