import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { csvParse } from "d3-dsv";
import { describe, expect, it } from "vitest";
import {
  canonicalizeCube,
  canonicalMember,
  codedRef,
  createCube,
  createHierarchy,
  createInMemoryProvider,
  describeQuerySource,
  drilldownCube,
  getCellKey,
  executeQuery,
  planQuery,
  resolveConcordance,
  rollupCube,
  UdcError,
  validateQuery,
  type CanonicalCube,
  type CodeMapping,
  type DataProvider,
  type MeasureFieldMapping,
  type QuerySpec,
  type SemanticSchema,
} from "../src/index";

const read = (name: string) =>
  csvParse(readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8"));

type Row = Record<string, string>;
const places = [
  { id: "india", m49: "356", iso: "IND", name: "India", custom: "C-17" },
  { id: "china", m49: "156", iso: "CHN", name: "China", custom: "C-42" },
  { id: "usa", m49: "840", iso: "USA", name: "United States", custom: "C-99" },
];
const years = ["1960", "2010"];
const population = read("total_population.csv");
const gdp = read("GDP_current_USD.csv");
const carbon = read("development-co2.csv");
const energy = places.flatMap((p, i) =>
  years.map((year, j) => ({
    geo: p.name,
    year,
    capacity: String((i + 1) * (j + 1) * 100),
    generation: String((i + 1) * (j + 1) * 250),
  })),
);
const investment = places.flatMap((p, i) =>
  years.map((year, j) => ({
    geo: p.custom,
    year,
    public: String((i + 1) * (j + 1) * 10),
    private: String((i + 1) * (j + 1) * 20),
  })),
);
const states =
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  );

const mappings: CodeMapping[] = [];
function map(list: string, code: string, id: string, axis = "geo") {
  mappings.push({
    source: codedRef(axis, list, "v1", code),
    canonical: canonicalMember(axis, id),
    relationship: "exact",
    verified: true,
    revision: "fixture-v1",
    provenance: "Explicit development fixture mapping",
  });
}
for (const p of places) {
  map("m49", p.m49, p.id);
  map("iso", p.iso, p.id);
  map("names", p.name, p.id);
  map("custom", p.custom, p.id);
}
for (const code of states) map("state", code, "state:" + code);
for (const year of years) map("year", year, year, "year");
const concordance = resolveConcordance(mappings, { revision: "fixture-v1" });

function measure(
  field: string,
  id: string,
  unit: string,
  scale = 1,
): MeasureFieldMapping {
  return { field, measure: { id, name: id, unit, aggregation: "sum" }, scale };
}

function cube(
  id: string,
  list: string,
  field: string,
  rows: readonly Row[],
  measures: readonly MeasureFieldMapping[],
): CanonicalCube {
  const schema: SemanticSchema = {
    id: id + "-schema",
    revision: "v1",
    dimensions: [
      {
        field,
        dimension: { id: "geo", name: "Geography" },
        codelist: { id: list, revision: "v1" },
      },
      {
        field: "year",
        dimension: { id: "year", name: "Year" },
        codelist: { id: "year", revision: "v1" },
      },
    ],
    measures,
  };
  return canonicalizeCube(
    createCube(rows, schema, {
      datasetId: id,
      revision: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    }),
    concordance,
  );
}
const pop = measure("population", "population", "persons", 1000);
const dollars = measure("gdp", "gdp", "USD");
const co2 = measure("mt", "co2", "tonnes", 1000000);
const capacity = measure("capacity", "capacity", "MW");
const generation = measure("generation", "generation", "MWh", 1000);
const publicSpend = measure("public", "public", "USD", 1000);
const privateSpend = measure("private", "private", "USD", 1000);
function countryCubes(spend: readonly Row[] = investment) {
  return [
    cube("un-population", "m49", "countryCode", population, [pop]),
    cube("wb-gdp", "iso", "countryCode", gdp, [dollars]),
    cube("gcp-co2", "iso", "countryCode", carbon, [co2]),
    cube("fictional-energy", "names", "geo", energy, [capacity, generation]),
    cube("fictional-investment", "custom", "geo", spend, [
      publicSpend,
      privateSpend,
    ]),
  ];
}

const hierarchy = createHierarchy({
  key: "development-geography",
  dimensionId: "geo",
  revision: "v1",
  edges: [
    ["india", "asia"],
    ["china", "asia"],
    ["usa", "north-america"],
    ["asia", "world"],
    ["north-america", "world"],
    ...states.map((s) => ["state:" + s, "usa"]),
  ].map(([child, parent], index) => ({
    child: canonicalMember("geo", child),
    parent: canonicalMember("geo", parent),
    provenance: {
      snapshot: { datasetId: "fixture-geography", revision: "v1" },
      sourceRow: index + 1,
      mappingRevision: "v1",
    },
  })),
});

const binary = (
  id: string,
  left: string,
  right: string,
  unit: string,
  operator: "+" | "/",
): NonNullable<QuerySpec["calculatedMeasures"]>[number] => ({
  id,
  name: id,
  unit,
  expression: {
    kind: "binary",
    operator,
    left: { kind: "measure", measureId: left },
    right: { kind: "measure", measureId: right },
  },
});
const spec: QuerySpec = {
  version: 1,
  dimensions: ["geo", "year"],
  measures: ["gdp-per-person", "co2-per-dollar", "investment-per-person", "yield"],
  calculatedMeasures: [
    binary("investment-per-person", "investment", "population", "USD/person", "/"),
    binary("gdp-per-person", "gdp", "population", "USD/person", "/"),
    binary("co2-per-dollar", "co2", "gdp", "tonnes/USD", "/"),
    binary("yield", "generation", "capacity", "hours", "/"),
    binary("investment", "public", "private", "USD", "+"),
  ],
};
const member = (
  row: CanonicalCube["observations"][number] | Awaited<ReturnType<typeof executeQuery>>["observations"][number],
  axis: string,
) => row.coordinate.members.find((m) => m.dimensionId === axis)!.id;

function plan(query: QuerySpec, cubes: CanonicalCube[]) {
  const decoded: unknown = JSON.parse(JSON.stringify(query));
  validateQuery(decoded);
  return planQuery(decoded, {
    sources: cubes.map(describeQuerySource),
    hierarchies: [hierarchy],
  });
}
async function run(query: QuerySpec, cubes = countryCubes()) {
  const p = plan(query, cubes);
  const selected = cubes.filter((c) =>
    p.sources.some((s) => s.source.snapshot.datasetId === c.snapshots[0].datasetId),
  );
  return executeQuery(p, {
    provider: createInMemoryProvider(selected),
    hierarchies: [hierarchy],
  });
}

// Raw-record oracle deliberately does not use cube operators or cell keys.
const expected = places.flatMap((p) =>
  years.map((year) => {
    const pr = population.find((r) => r.countryCode === p.m49 && r.year === year)!;
    const gr = gdp.find((r) => r.countryCode === p.iso && r.year === year)!;
    const cr = carbon.find((r) => r.countryCode === p.iso && r.year === year)!;
    const er = energy.find((r) => r.geo === p.name && r.year === year)!;
    const ir = investment.find((r) => r.geo === p.custom && r.year === year)!;
    return {
      geo: p.id,
      year,
      pop: Number(pr.population) * 1000,
      gdp: Number(gr.gdp),
      co2: Number(cr.mt) * 1000000,
      capacity: Number(er.capacity),
      generation: Number(er.generation) * 1000,
      investment: (Number(ir.public) + Number(ir.private)) * 1000,
      rows: {
        "un-population": population.indexOf(pr) + 1,
        "wb-gdp": gdp.indexOf(gr) + 1,
        "gcp-co2": carbon.indexOf(cr) + 1,
        "fictional-energy": energy.indexOf(er) + 1,
        "fictional-investment": investment.indexOf(ir) + 1,
      },
    };
  }),
);

describe("development cube: five country sources", () => {
  it("resolves all five sources and checks all six raw-record joins and lineage", async () => {
    const cubes = countryCubes();
    const p = plan(spec, cubes);
    expect(p.sources).toHaveLength(5);
    const result = await run(spec, cubes);
    expect(result.observations).toHaveLength(6);
    for (const e of expected) {
      const row = result.observations.find(
        (r) => member(r, "geo") === e.geo && member(r, "year") === e.year,
      )!;
      expect(row.values["gdp-per-person"]?.value).toBeCloseTo(e.gdp / e.pop);
      expect(row.values["co2-per-dollar"]?.value).toBeCloseTo(e.co2 / e.gdp, 10);
      expect(row.values["investment-per-person"]?.value).toBeCloseTo(
        e.investment / e.pop,
        10,
      );
      expect(row.values.yield?.value).toBeCloseTo(e.generation / e.capacity);
      const derived = row.values["investment-per-person"];
      expect(derived).toHaveProperty("inputs");
      if (!derived || !("inputs" in derived)) throw Error("Missing lineage");
      const contributors = derived.inputs.flatMap((input) => input.contributors);
      expect(contributors).toHaveLength(3);
      for (const c of contributors) {
        expect(c.sourceRow).toBe(e.rows[c.snapshot.datasetId as keyof typeof e.rows]);
        expect(c.snapshot).toEqual(
          cubes.find((s) => s.snapshots[0].datasetId === c.snapshot.datasetId)!.snapshots[0],
        );
      }
      expect(contributors.map((c) => c.measureId).sort()).toEqual([
        "population", "private", "public",
      ]);
    }
    expect(await run(spec, [...cubes].reverse())).toEqual(result);
  });

  it("rolls up ratios of totals, honors extrema overrides, and ranks after reduction", async () => {
    const q: QuerySpec = {
      ...spec,
      measures: [...spec.measures, "capacity"],
      aggregationOverrides: [{ measureId: "capacity", operator: "max" }],
      rollups: [{
        hierarchyKey: hierarchy.key,
        revision: hierarchy.revision,
        targetMembers: ["asia", "north-america"],
      }],
    };
    const result = await run(q);
    expect(result.observations).toHaveLength(4);
    for (const row of result.observations) {
      const group = expected.filter((e) => e.year === member(row, "year") &&
        (e.geo === "usa" ? "north-america" : "asia") === member(row, "geo"));
      const total = (key: "pop" | "gdp" | "generation") =>
        group.reduce((n, e) => n + e[key], 0);
      const max = Math.max(...group.map((e) => e.capacity));
      expect(row.values["gdp-per-person"]?.value).toBeCloseTo(total("gdp") / total("pop"));
      expect(row.values.capacity?.value).toBe(max);
      expect(row.values.yield?.value).toBeCloseTo(total("generation") / max);
    }
    expect(result.hierarchyRollups).toHaveLength(1);
    const top = await run({
      ...q,
      topN: { measureId: "gdp-per-person", n: 1, partitionBy: ["year"] },
      orderBy: [{ kind: "dimension", dimensionId: "year", direction: "asc" }],
      limit: 2,
    });
    expect(top.observations.map((r) => member(r, "year"))).toEqual(years);
    expect(top.observations.map((r) => member(r, "geo"))).toEqual([
      "north-america", "north-america",
    ]);
  });

  it("distinguishes absent, null and zero and prohibits sparse rollups", async () => {
    const modified = investment.slice(1).map((r, i) =>
      i === 0 ? { ...r, public: "" } : i === 1 ? { ...r, public: "0" } : r,
    );
    const cubes = countryCubes(modified);
    const q: QuerySpec = {
      version: 1, dimensions: spec.dimensions,
      measures: ["population", "gdp", "co2", "capacity", "public"],
      join: "full",
    };
    const result = await run(q, cubes);
    const at = (geo: string, year: string) => result.observations.find(
      (r) => member(r, "geo") === geo && member(r, "year") === year,
    )!;
    expect(at("india", "1960").values.public).toBeUndefined();
    expect(at("india", "1960").presence?.sources).toContainEqual({
      datasetId: "fictional-investment", present: false,
    });
    expect(at("india", "2010").values.public?.value).toBeNull();
    expect(at("china", "1960").values.public?.value).toBe(0);
    await expect(run({ ...q, dimensions: ["year"] }, cubes)).rejects.toThrow(UdcError);
    expect(() => plan(spec, [...countryCubes(), stateCube()])).toThrow(UdcError);
  });

  it("compares independently filtered/projected provider responses to full loading", async () => {
    const cubes = countryCubes();
    const q: QuerySpec = {
      ...spec,
      filters: [{ dimensionId: "year", memberIds: ["2010"] }],
    };
    const p = plan(q, cubes);
    const calls: string[] = [];
    const provider: DataProvider = {
      ...createInMemoryProvider(cubes),
      async loadSource() { throw Error("Unexpected fallback"); },
      pushdown: {
        capabilities: () => ({ filter: true, project: true, aggregate: true }),
        async load(request) {
          const source = cubes.find((c) => c.snapshots[0].datasetId === request.source.snapshot.datasetId)!;
          calls.push(source.snapshots[0].datasetId);
          expect(request.pushdown.aggregateDimensions).toBeUndefined();
          const ids = request.pushdown.measureIds;
          return {
            kind: "subset",
            cube: {
              ...source,
              measures: source.measures.filter((m) => ids.includes(m.id)),
              observations: source.observations
                .filter((row) => member(row, "year") === "2010")
                .map((row) => ({
                  ...row,
                  values: Object.fromEntries(Object.entries(row.values).filter(([id]) => ids.includes(id))),
                })),
            },
          };
        },
      },
    };
    expect(await executeQuery(p, { provider, hierarchies: [hierarchy] })).toEqual(await run(q, cubes));
    expect(calls.sort()).toEqual(cubes.map((c) => c.snapshots[0].datasetId).sort());
    const stale = countryCubes(investment.slice(1));
    await expect(executeQuery(p, { provider: createInMemoryProvider(stale), hierarchies: [hierarchy] })).rejects.toThrow(UdcError);
  });
});

// Fictional allocation, not observed state statistics. Divide each national
// total into integer shares; the final state receives the exact remainder.
function share(total: number, i: number) {
  const base = Math.floor(total / states.length);
  return i === states.length - 1 ? total - base * i : base;
}
const stateRows = years.flatMap((year) => {
  const us = expected.find((e) => e.geo === "usa" && e.year === year)!;
  return states.map((geo, i) => ({
    geo, year,
    population: String(share(us.pop, i)),
    gdp: String(share(us.gdp, i)),
    co2: String(share(us.co2, i)),
    capacity: String(share(us.capacity, i)),
    investment: String(share(us.investment, i)),
  }));
});
function stateCube(rows: readonly Row[] = stateRows) {
  return cube("fictional-us-states", "state", "geo", rows, [
    measure("population", "population", "persons"),
    dollars,
    measure("co2", "co2", "tonnes"),
    capacity,
    measure("investment", "investment", "USD"),
  ]);
}

describe("development cube: US state drill-down", () => {
  it("expands all 50 states from fine data and reconciles each year's national totals", () => {
    const fine = stateCube();
    const drilled = drilldownCube(fine, hierarchy, "usa");
    expect(drilled.observations).toHaveLength(100);
    for (const r of drilled.observations) {
      const code = r.coordinate.members.find((m) => m.dimensionId === "geo")!.id.slice(6);
      const yr = r.coordinate.members.find((m) => m.dimensionId === "year")!.id;
      const index = stateRows.findIndex((s) => s.geo === code && s.year === yr);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(r.values.population.value).toBe(Number(stateRows[index].population));
      expect(r.values.population.contributors.map((p) => p.sourceRow)).toEqual([index + 1]);
    }
    const national = rollupCube(fine, hierarchy, ["usa"]);
    const continental = rollupCube(national, hierarchy, ["north-america"]);
    const world = rollupCube(continental, hierarchy, ["world"]);
    for (const r of world.observations) {
      const year = r.coordinate.members.find((m) => m.dimensionId === "year")!.id;
      const us = expected.find((e) => e.geo === "usa" && e.year === year)!;
      for (const [id, value] of Object.entries({
        population: us.pop, gdp: us.gdp, co2: us.co2,
        capacity: us.capacity, investment: us.investment,
      })) {
        expect(r.values[id].value).toBeCloseTo(value, 3);
        expect(r.values[id].contributors).toHaveLength(50);
        expect(new Set(r.values[id].contributors.map((p) => p.sourceRow)).size).toBe(50);
      }
    }
    expect(() => drilldownCube(national, hierarchy, "usa")).toThrow(UdcError);
    const mixed: CanonicalCube = {
      ...fine,
      observations: [...fine.observations, {
        ...fine.observations[0],
        coordinate: { members: [canonicalMember("geo", "usa"), canonicalMember("year", "1960")] },
        cellKey: getCellKey({ members: [canonicalMember("geo", "usa"), canonicalMember("year", "1960")] }),
      }],
    };
    expect(() => rollupCube(mixed, hierarchy, ["usa"])).toThrow(UdcError);
  });

  it("does not fabricate a missing state; exposes a national reconciliation gap", () => {
    const missing = stateCube(stateRows.filter((r) => r.geo !== "NY"));
    const drilled = drilldownCube(missing, hierarchy, "usa");
    expect(drilled.observations).toHaveLength(98);
    for (const r of rollupCube(missing, hierarchy, ["usa"]).observations) {
      const year = r.coordinate.members.find((m) => m.dimensionId === "year")!.id;
      const us = expected.find((e) => e.geo === "usa" && e.year === year)!;
      expect(r.values.population.value).toBeCloseTo(us.pop - Number(stateRows.find((s) => s.geo === "NY" && s.year === year)!.population), 3);
      expect(r.values.population.contributors).toHaveLength(49);
    }
  });
});
