import { describe, expect, it } from "vitest";
import {
  aggregateCube, calculateMeasure, canonicalMember, codedRef, createHierarchy,
  describeQuerySource, diceCube, executeQuery, filterCube, getCellKey,
  integrateCubes, planQuery, rollupCube, topNCube, UdcError, validateQuery,
  type AggregationOperator, type CanonicalCube, type QuerySpec,
} from "../src";

type Row = readonly [string, string, number | null];
const populationRows: readonly Row[] = [
  ["a", "2020", 10], ["b", "2020", 30], ["c", "2020", 90],
  ["a", "2021", 20], ["b", "2021", null],
];
const gdpRows: readonly Row[] = [
  ["a", "2020", 100], ["b", "2020", 600], ["c", "2020", 900],
  ["a", "2021", 600], ["b", "2021", 700],
];
function source(
  id: string, rows: readonly Row[] = populationRows,
  datasetId = id, aggregation: AggregationOperator = "sum",
): CanonicalCube {
  const snapshot = { datasetId, revision: "v1" };
  return {
    stage: "canonical",
    dimensions: [{id: "space", name: "Space"}, {id: "time", name: "Year"}],
    measures: [{id, name: id, unit: "units", aggregation}],
    snapshots: [snapshot], schemaRevisions: ["schema-v1"], concordanceRevisions: ["concordance-v1"],
    observations: rows.map(([country, year, value], i) => {
      const coordinate = {members: [canonicalMember("space", country), canonicalMember("time", year)]};
      return {coordinate, cellKey: getCellKey(coordinate), values: {
        [id]: {value, provenance: {
          snapshot, sourceRow: i + 1, schemaId: "schema", schemaRevision: "v1",
          measureId: id, unit: "units", sourceCoordinate: {members: [
            codedRef("space", "countries", "v1", country),
            codedRef("time", "years", "v1", year),
          ]},
        }},
      }};
    }),
  };
}
const population = source("population");
const gdp = source("gdp", gdpRows);
const hierarchy = createHierarchy({
  key: "geography", dimensionId: "space", revision: "v1",
  edges: [["a", "east"], ["b", "east"], ["c", "west"]].map(([child, parent], i) => ({
    child: canonicalMember("space", child), parent: canonicalMember("space", parent),
    provenance: {snapshot: {datasetId: "geography", revision: "v1"}, sourceRow: i+1, mappingRevision: "v1"},
  })),
});
const base: QuerySpec = {version: 1, dimensions: ["space", "time"], measures: ["population"]};
const ratio = {
  id: "ratio", name: "GDP per capita", unit: "USD/person",
  expression: {kind: "binary", operator: "/", left: {kind: "measure", measureId: "gdp"},
    right: {kind: "measure", measureId: "population"}} as const,
};
const ratioQuery: QuerySpec = {...base, measures: ["ratio"], calculatedMeasures: [ratio]};
const filters = [{dimensionId: "time", memberIds: ["2020"]}];
const rollups = [{hierarchyKey: "geography", revision: "v1", targetMembers: ["east", "west"]}];
function plan(q: QuerySpec, cubes: readonly CanonicalCube[] = [population]) {
  return planQuery(q, {sources: cubes.map(describeQuerySource), hierarchies: [hierarchy]});
}
function run(q: QuerySpec, cubes: readonly CanonicalCube[] = [population]) {
  return executeQuery(plan(q, cubes), {cubes, hierarchies: [hierarchy]});
}

describe("declarative query validation", () => {
  it("accepts round-tripped JSON and rejects string expressions", () => {
    const decoded: unknown = JSON.parse(JSON.stringify(ratioQuery));
    expect(() => validateQuery(decoded)).not.toThrow();
    expect(() => validateQuery({...ratioQuery, calculatedMeasures: [{...ratio, expression: "gdp / population"}]})).toThrow(UdcError);
  });
  it.each([
    null, {}, {...base, version: 2}, {...base, measures: []},
    {...base, dimensions: ["time", "time"]}, {...base, measures: ["population", "population"]},
    {...base, filters: [null]}, {...base, filters: [...filters, ...filters]},
    {...base, unknown: true}, {...base, join: "cross"}, {...base, join: "left"},
    {...base, joinAnchor: "population"}, {...base, topN: {measureId: "population", n: -1}},
    {...base, topN: {measureId: "population", n: 10001}},
    {...base, topN: {measureId: "population", n: 1, ties: "random"}},
    {...base, measureFilter: {kind: "and", operands: []}},
    {...base, measureFilter: {kind: "range", measureId: "population", min: 10, max: 1}},
    {...base, measureFilter: {kind: "compare", measureId: "population", operator: "gt", value: Infinity}},
    {...base, rollups: [{...rollups[0], targetMembers: []}]},
    {...ratioQuery, calculatedMeasures: [ratio, ratio]},
  ])("rejects malformed or unsupported query %#", (value) => {
    expect(() => validateQuery(value)).toThrow(UdcError);
  });
  it("bounds nested expression and predicate trees", () => {
    let expression: unknown = {kind: "constant", value: 1};
    let predicate: unknown = {kind: "isNull", measureId: "population"};
    for (let i = 0; i < 40; i++) {
      expression = {kind: "binary", operator: "+", left: expression, right: {kind: "constant", value: 1}};
      predicate = {kind: "not", operand: predicate};
    }
    expect(() => validateQuery({...ratioQuery, calculatedMeasures: [{...ratio, expression}]})).toThrow(UdcError);
    expect(() => validateQuery({...base, measureFilter: predicate})).toThrow(UdcError);
  });
});

describe("query planning", () => {
  it("plans hidden operands, deterministic source order and a JSON round trip", () => {
    const a = plan({...ratioQuery, filters, topN: {measureId: "ratio", n: 1}}, [gdp, population]);
    const b = plan(a.query, [population, gdp]);
    expect(a).toEqual(b);
    expect(a.sources.map(s => s.measureIds)).toEqual([["gdp"], ["population"]]);
    expect(a.steps).toEqual(["filter-dimensions", "integrate", "calculate", "top-n", "project"]);
    expect(executeQuery(JSON.parse(JSON.stringify(a)), {cubes: [population, gdp]})).toEqual(executeQuery(b, {cubes: [gdp, population]}));
  });
  it("fails closed on competing providers, unknown measures and dimensions", () => {
    expect(() => plan(base, [population, source("population", populationRows, "alternative")])).toThrow(UdcError);
    expect(() => plan({...base, measures: ["unknown"]})).toThrow(UdcError);
    expect(() => plan({...base, dimensions: ["unknown"]})).toThrow(UdcError);
    expect(() => plan({...base, topN: {measureId: "unknown", n: 1}})).toThrow(UdcError);
  });
  it("rejects unpinned snapshots, duplicate dataset identities and incompatible source grain", () => {
    expect(() => describeQuerySource({...population, snapshots: [{datasetId: "population"}]})).toThrow(UdcError);
    expect(() => plan(base, [population, population])).toThrow(UdcError);
    const other = {...gdp, dimensions: [...gdp.dimensions, {id: "extra", name: "Extra"}]};
    expect(() => plan(ratioQuery, [population, other])).toThrow(UdcError);
  });
  it("rejects more than the existing two-source operator budget", () => {
    const third = source("third");
    expect(() => plan({...base, measures: ["population", "gdp", "third"]}, [population, gdp, third])).toThrow(UdcError);
  });
  it("rejects missing hierarchy versions and invalid partition dimensions", () => {
    expect(() => plan({...base, rollups: [{...rollups[0], revision: "v2"}]})).toThrow(UdcError);
    expect(() => plan({...base, dimensions: ["space"], topN: {measureId: "population", n: 2, partitionBy: ["time"]}})).toThrow(UdcError);
  });
  it("rejects cycles and unreferenced calculations", () => {
    expect(() => plan({...ratioQuery, calculatedMeasures: [{...ratio, expression: {kind: "measure", measureId: "ratio"}}]})).toThrow(UdcError);
    expect(() => plan({...base, calculatedMeasures: [ratio]})).toThrow(UdcError);
  });
  it("does not accept tampered plans or changed snapshots and metadata", () => {
    const p = plan(base);
    expect(() => executeQuery({...p, steps: []}, {cubes: [population]})).toThrow(UdcError);
    const changed = {...population, snapshots: [{datasetId: "population", revision: "v2"}]};
    expect(() => executeQuery(p, {cubes: [changed]})).toThrow(UdcError);
    expect(() => executeQuery(p, {cubes: [{...population, concordanceRevisions: ["v2"]}]})).toThrow(UdcError);
    expect(() => executeQuery(p, {cubes: [population, gdp]})).toThrow(UdcError);
    expect(() => executeQuery(p, {cubes: []})).toThrow(UdcError);
  });
});

describe("query execution", () => {
  it("selects dimensions, projects measures and preserves atomic lineage", () => {
    const input = integrateCubes(population, gdp);
    // A single source may have multiple measures but must carry a single snapshot.
    const multi = {...input, snapshots: population.snapshots};
    const result = run({...base, dimensions: ["time", "space"], filters}, [multi]);
    expect(result.dimensions.map(d => d.id)).toEqual(["time", "space"]);
    expect(result.observations).toHaveLength(3);
    for (const row of result.observations) {
      expect(Object.keys(row.values)).toEqual(["population"]);
      expect(row.values.population).toEqual(population.observations.find(o => o.cellKey === row.cellKey)?.values.population);
    }
  });
  it("golden GDP-per-capita query matches manual operator composition", () => {
    const q: QuerySpec = {...ratioQuery, filters, rollups, measureFilter: {kind: "compare", measureId: "ratio", operator: "gt", value: 0},
      topN: {measureId: "ratio", n: 1, partitionBy: ["time"]}};
    const actual = run(q, [population, gdp]);
    const joined = integrateCubes(diceCube(gdp, filters), diceCube(population, filters));
    const manual = topNCube(filterCube(calculateMeasure(rollupCube(joined, hierarchy, rollups[0].targetMembers), ratio), q.measureFilter!), q.topN!);
    expect(actual.observations.map(o => o.cellKey)).toEqual(manual.observations.map(o => o.cellKey));
    expect(actual.observations[0].values.ratio).toEqual(manual.observations[0].values.ratio);
    expect(actual.observations[0].values.ratio?.value).toBe(17.5);
    expect(Object.keys(actual.observations[0].values)).toEqual(["ratio"]);
    expect(actual.hierarchyRollups).toEqual(manual.hierarchyRollups);
  });
  it("aggregates before calculating and retains operand provenance", () => {
    const actual = run({...ratioQuery, dimensions: ["time"], filters}, [population, gdp]);
    const manual = calculateMeasure(aggregateCube(diceCube(integrateCubes(gdp, population), filters), ["time"]), ratio);
    expect(actual.observations[0].values.ratio).toEqual(manual.observations[0].values.ratio);
    expect(actual.observations[0].values.ratio?.value).toBe(1600 / 130);
  });
  it("uses explicit derived count identity on aggregation", () => {
    const count = source("countable", populationRows, "countable", "count");
    const result = run({...base, dimensions: [], measures: ["countable:count"]}, [count]);
    expect(result.observations[0].values["countable:count"]?.value).toBe(4);
    expect(() => run({...base, dimensions: [], measures: ["countable"]}, [count])).toThrow(UdcError);
  });
  it("does not aggregate an unused non-additive measure", () => {
    const other = source("unused", populationRows, "unused", "none");
    const combined = {...integrateCubes(population, other), snapshots: population.snapshots};
    const result = run({...base, dimensions: [], filters}, [combined]);
    expect(result.observations[0].values.population?.value).toBe(130);
    expect(() => run({...base, dimensions: [], measures: ["unused"]}, [combined])).toThrow(UdcError);
  });
  it("supports scalar output, empty filters and hidden predicate dependencies", () => {
    expect(run({...base, dimensions: []}).observations[0].values.population?.value).toBe(150);
    expect(run({...base, filters: [{dimensionId: "time", memberIds: []}]}).observations).toEqual([]);
    const result = run({...base, measureFilter: {kind: "compare", measureId: "gdp", operator: "gt", value: 500}}, [population, gdp]);
    expect(result.observations).toHaveLength(4);
    expect(result.measures.map(m => m.id)).toEqual(["population"]);
  });
  it("preserves sparse absence versus present null and honors directional anchor", () => {
    const sparse = source("gdp", [["a", "2020", null], ["d", "2020", 1]]);
    const query: QuerySpec = {...base, measures: ["population", "gdp"], join: "full"};
    const result = run(query, [population, sparse]);
    expect(result.inputStage).toBe("sparse-integrated");
    expect(result.observations).toHaveLength(6);
    expect(result.observations.filter(o => !Object.hasOwn(o.values, "gdp"))).toHaveLength(4);
    expect(result.observations.filter(o => o.values.gdp?.value === null)).toHaveLength(1);
    const left = run({...query, join: "left", joinAnchor: "population"}, [population, sparse]);
    const right = run({...query, join: "right", joinAnchor: "population"}, [population, sparse]);
    expect(left.observations.map(o => o.cellKey)).toEqual(right.observations.map(o => o.cellKey));
    expect(left.observations).toHaveLength(5);
    expect(() => run({...query, dimensions: ["time"]}, [population, sparse])).toThrow(UdcError);
    expect(() => run({...query, rollups}, [population, sparse])).toThrow(UdcError);
  });
  it("keeps null ratios unranked and supports partitioned ties", () => {
    const result = run({...ratioQuery, topN: {measureId: "ratio", n: 1, partitionBy: ["time"], ties: "include"}}, [population, gdp]);
    expect(result.observations.map(o => o.values.ratio?.value)).toEqual([20, 30]);
    expect(run({...ratioQuery, topN: {measureId: "ratio", n: 0}}, [population, gdp]).observations).toEqual([]);
  });
  it("rejects malformed source rows before filtering", () => {
    const malformed = {...population, observations: [...population.observations, population.observations[0]]};
    expect(() => run({...base, filters: [{dimensionId: "time", memberIds: []}]}, [malformed])).toThrow(UdcError);
  });
  it("is invariant to reversed source and row order and does not mutate inputs", () => {
    const before = JSON.stringify([population, gdp, ratioQuery]);
    const reverse = (cube: CanonicalCube) => ({...cube, observations: [...cube.observations].reverse()});
    expect(run(ratioQuery, [reverse(gdp), reverse(population)])).toEqual(run(ratioQuery, [population, gdp]));
    expect(JSON.stringify([population, gdp, ratioQuery])).toBe(before);
  });
});
