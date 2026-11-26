import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { csvParse } from "d3-dsv";
import {
  createCube,
  canonicalizeCube,
  integrateCubes,
  sliceCube,
  resolveConcordance,
  codedRef,
  canonicalMember,
  getCellKey,
  createHierarchy,
  describeQuerySource,
  planQuery,
  executeQuery,
  createInMemoryProvider,
  validateQuery,
  UdcError,
  type CanonicalCube,
  type QuerySpec,
  type SemanticSchema,
  type CodeMapping,
  type DatasetSnapshot,
} from "../src/index";

const fixture = (name: string) =>
  readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
const population = fixture("total_population.csv");
const gdp = fixture("GDP_current_USD.csv");
const location = fixture("locations.csv");
const country = { id: "country", name: "Country" };
const year = { id: "year", name: "Year" };
const yearCodes = { id: "calendar-year", revision: "2014" };
const popSchema: SemanticSchema = {
  id: "schema:un-population",
  revision: "v1",
  dimensions: [
    {
      field: "countryCode",
      dimension: country,
      codelist: { id: "un-m49", revision: "2014" },
    },
    { field: "year", dimension: year, codelist: yearCodes },
  ],
  measures: [
    {
      field: "population",
      measure: {
        id: "population",
        name: "Population",
        unit: "persons",
        aggregation: "sum",
      },
      scale: 1000,
    },
  ],
};
const gdpSchema: SemanticSchema = {
  id: "schema:wb-gdp",
  revision: "v1",
  dimensions: [
    {
      field: "countryCode",
      dimension: country,
      codelist: { id: "iso-alpha3", revision: "2014" },
    },
    { field: "year", dimension: year, codelist: yearCodes },
  ],
  measures: [
    {
      field: "gdp",
      measure: {
        id: "gdp-current-usd",
        name: "GDP (current US$)",
        unit: "USD",
        aggregation: "sum",
      },
      scale: 1,
    },
  ],
};
const snapshot = (text: string, vizId: string): DatasetSnapshot => ({
  datasetId: "ds_c_" + createHash("sha256").update(text).digest("hex"),
  vizId,
  commitId: "commit:original-2014",
  revision: "fixture:2014",
  sourceKey: "source:" + vizId,
});
const un = snapshot(population, "viz:un");
const wb = snapshot(gdp, "viz:wb");
function exact(
  source: ReturnType<typeof codedRef>,
  canonical: ReturnType<typeof canonicalMember>,
): CodeMapping {
  return {
    source,
    canonical,
    relationship: "exact",
    verified: true,
    revision: "map:2014",
    provenance: "2014 UDC locations.csv / fixture",
  };
}
const mappings: CodeMapping[] = [];
for (const row of csvParse(location)) {
  const id =
    row.countryName === "United States of America"
      ? "usa"
      : row.countryName.toLowerCase();
  const canonical = canonicalMember("country", "country:" + id);
  mappings.push(
    exact(codedRef("country", "un-m49", "2014", row.unCountryCode), canonical),
  );
  mappings.push(
    exact(codedRef("country", "iso-alpha3", "2014", row.alphaCode), canonical),
  );
}
for (const code of ["1960", "2010"])
  mappings.push(
    exact(
      codedRef("year", "calendar-year", "2014", code),
      canonicalMember("year", "year:" + code),
    ),
  );
function integrated() {
  const concordance = resolveConcordance(mappings, {
    revision: "concordance:fixtures-v1",
  });
  const a = canonicalizeCube(
    createCube(csvParse(population), popSchema, un),
    concordance,
  );
  const b = canonicalizeCube(
    createCube(csvParse(gdp), gdpSchema, wb),
    concordance,
  );
  return { cube: integrateCubes(a, b), concordance };
}
describe("2014 UDC UN population × World Bank GDP acceptance", () => {
  it("resolves UN M49 156 and ISO CHN to the same canonical country", () => {
    const { concordance } = integrated();
    expect(
      concordance.resolve(codedRef("country", "un-m49", "2014", "156")),
    ).toMatchObject({
      status: "resolved",
      member: canonicalMember("country", "country:china"),
    });
    expect(
      concordance.resolve(codedRef("country", "iso-alpha3", "2014", "CHN")),
    ).toMatchObject({
      status: "resolved",
      member: canonicalMember("country", "country:china"),
    });
  });
  it("integrates China 1960 with unit scaling and both source histories", () => {
    const { cube } = integrated();
    expect(cube.observations).toHaveLength(6);
    const key = getCellKey({
      members: [
        canonicalMember("year", "year:1960"),
        canonicalMember("country", "country:china"),
      ],
    });
    const obs = cube.observations.find((x) => x.cellKey === key);
    expect(obs).toBeDefined();
    expect(obs!.values.population.value).toBeCloseTo(650680114, 3);
    expect(obs!.values["gdp-current-usd"].value).toBeCloseTo(
      61377930682.0013,
      3,
    );
    expect(obs!.values.population.provenance).toMatchObject({
      snapshot: un,
      sourceRow: 3,
      schemaId: popSchema.id,
      schemaRevision: "v1",
      measureId: "population",
      unit: "persons",
      concordanceRevision: "concordance:fixtures-v1",
      mappingRevisions: ["map:2014"],
    });
    expect(obs!.values["gdp-current-usd"].provenance).toMatchObject({
      snapshot: wb,
      sourceRow: 3,
      schemaId: gdpSchema.id,
      schemaRevision: "v1",
      measureId: "gdp-current-usd",
      unit: "USD",
      concordanceRevision: "concordance:fixtures-v1",
      mappingRevisions: ["map:2014"],
    });
    expect(
      obs!.values.population.provenance.sourceCoordinate.members[0].code,
    ).toBe("156");
    expect(
      obs!.values["gdp-current-usd"].provenance.sourceCoordinate.members[0]
        .code,
    ).toBe("CHN");
    expect(cube.concordanceRevisions).toEqual(["concordance:fixtures-v1"]);
    expect(cube.snapshots).toEqual([un, wb]);
  });
  it("replays identically and slices Year 1960 to Country-only observations", () => {
    const first = integrated().cube,
      second = integrated().cube;
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    const sliced = sliceCube(first, canonicalMember("year", "year:1960"));
    expect(sliced.dimensions).toEqual([country]);
    expect(sliced.observations).toHaveLength(3);
    const china = sliced.observations.find(
      (x) =>
        x.cellKey ===
        getCellKey({ members: [canonicalMember("country", "country:china")] }),
    );
    expect(china?.values.population.value).toBeCloseTo(650680114);
    expect(china?.values["gdp-current-usd"].provenance.snapshot).toEqual(wb);
  });
});

describe("real-world declarative queries over historical CSV fixtures", () => {
  const popRows = csvParse(population);
  const gdpRows = csvParse(gdp);
  const places = csvParse(location);
  const concordance = resolveConcordance(mappings, {
    revision: "concordance:fixtures-v1",
  });

  function sources(
    p: readonly Record<string, string>[] = popRows,
    g: readonly Record<string, string>[] = gdpRows,
  ): CanonicalCube[] {
    return [
      canonicalizeCube(
        createCube(
          p,
          popSchema,
          p === popRows
            ? un
            : {
                datasetId: un.datasetId,
                revision:
                  "fixture:synthetic-" +
                  createHash("sha256").update(JSON.stringify(p)).digest("hex"),
              },
        ),
        concordance,
      ),
      canonicalizeCube(
        createCube(
          g,
          gdpSchema,
          g === gdpRows
            ? wb
            : {
                datasetId: wb.datasetId,
                revision:
                  "fixture:synthetic-" +
                  createHash("sha256").update(JSON.stringify(g)).digest("hex"),
              },
        ),
        concordance,
      ),
    ];
  }

  const ratioQuery: QuerySpec = {
    version: 1,
    dimensions: ["country", "year"],
    measures: ["gdp-per-capita"],
    calculatedMeasures: [
      {
        id: "gdp-per-capita",
        name: "GDP per capita",
        unit: "USD/person",
        expression: {
          kind: "binary",
          operator: "/",
          left: { kind: "measure", measureId: "gdp-current-usd" },
          right: { kind: "measure", measureId: "population" },
        },
      },
    ],
  };
  const countryId = (name: string) =>
    "country:" +
    (name === "United States of America" ? "usa" : name.toLowerCase());
  const key = (id: string, yr: string) =>
    getCellKey({
      members: [
        canonicalMember("country", id),
        canonicalMember("year", "year:" + yr),
      ],
    });

  // Independent numeric oracle: join original CSV records by the concordance,
  // not by UDC coordinates or low-level operators.
  const expected = places.flatMap((place) =>
    popRows
      .filter((p) => p.countryCode === place.unCountryCode)
      .map((p) => {
        const g = gdpRows.find(
          (row) => row.countryCode === place.alphaCode && row.year === p.year,
        )!;
        return {
          id: countryId(place.countryName),
          year: p.year,
          population: Number(p.population) * 1000,
          gdp: Number(g.gdp),
          popRow: popRows.indexOf(p) + 1,
          gdpRow: gdpRows.indexOf(g) + 1,
          m49: p.countryCode,
          iso: g.countryCode,
        };
      }),
  );

  async function run(query: QuerySpec, cubes = sources()) {
    const decoded: unknown = JSON.parse(JSON.stringify(query));
    validateQuery(decoded);
    const plan = planQuery(decoded, {
      sources: cubes.map(describeQuerySource),
    });
    return executeQuery(JSON.parse(JSON.stringify(plan)), {
      provider: createInMemoryProvider(cubes),
    });
  }

  it("discovers both hidden operands and matches every independently joined CSV observation and source row", async () => {
    const cubes = sources();
    const plan = planQuery(ratioQuery, {
      sources: cubes.map(describeQuerySource),
    });
    expect(plan.sources.flatMap((s) => s.measureIds).sort()).toEqual([
      "gdp-current-usd",
      "population",
    ]);
    expect(plan.steps).toEqual(["integrate", "calculate", "project"]);
    expect(expected).toHaveLength(6);
    const result = await run(ratioQuery, cubes);
    expect(result.observations).toHaveLength(expected.length);
    expect(result.measures).toMatchObject([
      { id: "gdp-per-capita", unit: "USD/person", aggregation: "none" },
    ]);
    for (const e of expected) {
      const row = result.observations.find(
        (r) => r.cellKey === key(e.id, e.year),
      );
      expect(row).toBeDefined();
      expect(Object.keys(row!.values)).toEqual(["gdp-per-capita"]);
      const value = row!.values["gdp-per-capita"];
      expect(value?.value).toBeCloseTo(e.gdp / e.population, 8);
      expect(value).toMatchObject({
        inputs: [
          {
            measureId: "gdp-current-usd",
            contributors: [
              {
                snapshot: wb,
                sourceRow: e.gdpRow,
                unit: "USD",
                sourceCoordinate: {
                  members: [
                    expect.objectContaining({ code: e.iso }),
                    expect.objectContaining({ code: e.year }),
                  ],
                },
                concordanceRevision: "concordance:fixtures-v1",
              },
            ],
          },
          {
            measureId: "population",
            contributors: [
              {
                snapshot: un,
                sourceRow: e.popRow,
                unit: "persons",
                sourceCoordinate: {
                  members: [
                    expect.objectContaining({ code: e.m49 }),
                    expect.objectContaining({ code: e.year }),
                  ],
                },
                concordanceRevision: "concordance:fixtures-v1",
              },
            ],
          },
        ],
      });
    }
    const china = result.observations.find(
      (r) => r.cellKey === key("country:china", "1960"),
    );
    expect(china?.values["gdp-per-capita"]?.value).toBeCloseTo(
      61377930682.0013 / 650680114,
      8,
    );
    expect(result.snapshots).toEqual(expect.arrayContaining([un, wb]));
  });

  it("selects only the required source from a multi-source catalog", async () => {
    const cubes = sources();
    const query: QuerySpec = {
      version: 1,
      dimensions: ["year"],
      measures: ["population"],
    };
    const plan = planQuery(query, { sources: cubes.map(describeQuerySource) });
    expect(plan.sources.map((s) => s.source.snapshot)).toEqual([un]);
    const result = await executeQuery(plan, {
      provider: createInMemoryProvider([cubes[0]]),
    });
    expect(result.observations).toHaveLength(2);
    for (const row of result.observations) {
      const year = row.coordinate.members[0].id;
      const total = expected
        .filter((e) => "year:" + e.year === year)
        .reduce((sum, e) => sum + e.population, 0);
      expect(row.values.population?.value).toBeCloseTo(total, 4);
    }
    await expect(
      executeQuery(plan, { provider: createInMemoryProvider(cubes) }),
    ).rejects.toThrow(UdcError);
  });

  it("calculates regional ratios of totals with explicit hierarchy and contributor evidence", async () => {
    // This is a fixture hierarchy, not an imported official classification.
    const hierarchy = createHierarchy({
      key: "fixture-geography",
      dimensionId: "country",
      revision: "v1",
      edges: [
        ["country:india", "asia"],
        ["country:china", "asia"],
        ["country:usa", "north-america"],
      ].map(([child, parent], index) => ({
        child: canonicalMember("country", child),
        parent: canonicalMember("country", parent),
        provenance: {
          snapshot: { datasetId: "fixture-geography", revision: "v1" },
          sourceRow: index + 1,
          mappingRevision: "v1",
        },
      })),
    });
    const query: QuerySpec = {
      ...ratioQuery,
      rollups: [
        {
          hierarchyKey: hierarchy.key,
          revision: hierarchy.revision,
          targetMembers: ["asia", "north-america"],
        },
      ],
    };
    const cubes = sources();
    const plan = planQuery(query, {
      sources: cubes.map(describeQuerySource),
      hierarchies: [hierarchy],
    });
    const result = await executeQuery(plan, {
      provider: createInMemoryProvider(cubes),
      hierarchies: [hierarchy],
    });
    expect(result.observations).toHaveLength(4);
    expect(result.hierarchyRollups).toHaveLength(1);
    for (const row of result.observations) {
      const region = row.coordinate.members.find(
        (m) => m.dimensionId === "country",
      )!.id;
      const yr = row.coordinate.members.find(
        (m) => m.dimensionId === "year",
      )!.id;
      const group = expected.filter(
        (e) =>
          "year:" + e.year === yr &&
          (region === "asia" ? e.id !== "country:usa" : e.id === "country:usa"),
      );
      const totalGDP = group.reduce((sum, e) => sum + e.gdp, 0);
      const totalPop = group.reduce((sum, e) => sum + e.population, 0);
      const value = row.values["gdp-per-capita"];
      expect(value?.value).toBeCloseTo(totalGDP / totalPop, 8);
      expect(value).toMatchObject({
        inputs: [
          {
            measureId: "gdp-current-usd",
            contributors: expect.arrayContaining(
              group.map((e) =>
                expect.objectContaining({ snapshot: wb, sourceRow: e.gdpRow }),
              ),
            ),
          },
          {
            measureId: "population",
            contributors: expect.arrayContaining(
              group.map((e) =>
                expect.objectContaining({ snapshot: un, sourceRow: e.popRow }),
              ),
            ),
          },
        ],
      });
      if (region === "asia") {
        const mean =
          group.reduce((sum, e) => sum + e.gdp / e.population, 0) /
          group.length;
        expect(value?.value).not.toBeCloseTo(mean, 4);
      }
    }
  });

  it("filters by year and hidden population before selecting top countries per year", async () => {
    const query: QuerySpec = {
      ...ratioQuery,
      filters: [{ dimensionId: "year", memberIds: ["year:1960", "year:2010"] }],
      measureFilter: {
        kind: "compare",
        measureId: "population",
        operator: "gte",
        value: 300000000,
      },
      topN: {
        measureId: "gdp-per-capita",
        direction: "desc",
        n: 1,
        partitionBy: ["year"],
        ties: "exact",
      },
    };
    const result = await run(query);
    const winners = ["1960", "2010"].map(
      (yr) =>
        expected
          .filter((e) => e.year === yr && e.population >= 300000000)
          .sort((a, b) => b.gdp / b.population - a.gdp / a.population)[0],
    );
    expect(result.observations.map((r) => r.cellKey).sort()).toEqual(
      winners.map((e) => key(e.id, e.year)).sort(),
    );
    const sliced = await run({
      ...query,
      filters: [{ dimensionId: "year", memberIds: ["year:1960"] }],
    });
    expect(sliced.observations.map((r) => r.cellKey)).toEqual([
      key(winners[0].id, "1960"),
    ]);
  });

  it("distinguishes absent, null, and zero operands using explicitly perturbed fixture rows", async () => {
    const p = popRows.map((row) =>
      row.countryCode === "156" && row.year === "1960"
        ? { ...row, population: "0" }
        : row,
    );
    const g = gdpRows
      .filter((row) => !(row.countryCode === "USA" && row.year === "2010"))
      .map((row) =>
        row.countryCode === "IND" && row.year === "1960"
          ? { ...row, gdp: "" }
          : row,
      );
    const cubes = sources(p, g);
    const query: QuerySpec = {
      ...ratioQuery,
      join: "full",
      measures: ["population", "gdp-current-usd", "gdp-per-capita"],
    };
    const result = await run(query, cubes);
    expect(result.observations).toHaveLength(6);
    const at = (id: string, yr: string) =>
      result.observations.find((r) => r.cellKey === key(id, yr))!;
    expect(at("country:china", "1960").values.population?.value).toBe(0);
    expect(
      at("country:china", "1960").values["gdp-per-capita"]?.value,
    ).toBeNull();
    expect(
      at("country:india", "1960").values["gdp-current-usd"]?.value,
    ).toBeNull();
    expect(
      at("country:india", "1960").values["gdp-per-capita"]?.value,
    ).toBeNull();
    const missing = at("country:usa", "2010");
    expect(Object.hasOwn(missing.values, "gdp-current-usd")).toBe(false);
    expect(Object.hasOwn(missing.values, "gdp-per-capita")).toBe(false);
    expect(missing.presence).toBeDefined();
    expect((await run(ratioQuery, cubes)).observations).toHaveLength(5);
    await expect(
      run({ ...query, dimensions: ["year"] }, cubes),
    ).rejects.toThrow(UdcError);
  });

  it("round-trips JSON, is deterministic for reordered canonical observations, and rejects stale revisions", async () => {
    const cubes = sources();
    const before = JSON.stringify(cubes);
    const plan = planQuery(ratioQuery, {
      sources: cubes.map(describeQuerySource),
    });
    const reordered = [...cubes].reverse().map((cube) => ({
      ...cube,
      observations: [...cube.observations].reverse(),
    }));
    expect(
      planQuery(ratioQuery, { sources: reordered.map(describeQuerySource) }),
    ).toEqual(plan);
    const result = await executeQuery(plan, {
      provider: createInMemoryProvider(cubes),
    });
    expect(
      await executeQuery(JSON.parse(JSON.stringify(plan)), {
        provider: createInMemoryProvider(reordered),
      }),
    ).toEqual(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.stringify(cubes)).toBe(before);
    const revised = sources(
      popRows.map((row) => ({ ...row })),
      gdpRows,
    );
    await expect(
      executeQuery(plan, { provider: createInMemoryProvider(revised) }),
    ).rejects.toThrow(UdcError);
  });
});
