import { describe, expect, it } from "vitest";
import {
  associateGeographicQuery,
  canonicalizeGeographicDataset,
  validateGeographicDatasetSchema,
  canonicalizeCube,
  canonicalMember,
  codedRef,
  createCube,
  createInMemoryProvider,
  describeQuerySource,
  executeQuery,
  planQuery,
  resolveConcordance,
  UDC_LIMITS,
  UdcError,
  type CodeMapping,
  type GeographicDatasetSchema,
  type QuerySpec,
  type SemanticSchema,
} from "../src/index";

const country = { id: "country", name: "Country" };
const year = { id: "year", name: "Year" };
const state = { id: "state", name: "State" };
const list = (id: string) => ({ id, revision: "v1" });
const snapshot = { datasetId: "boundaries", revision: "2020" };
const exact = (
  dimension: string,
  codelist: string,
  code: string,
  id: string,
): CodeMapping => ({
  source: codedRef(dimension, codelist, "v1", code),
  canonical: canonicalMember(dimension, id),
  relationship: "exact",
  verified: true,
  revision: "mapping-v1",
  provenance: "synthetic fixture",
});
const mappings = [
  ...[
    ["AU", "AUS", "036", "australia"],
    ["US", "USA", "840", "usa"],
    ["CA", "CAN", "124", "canada"],
    ["NZ", "NZL", "554", "new-zealand"],
  ].flatMap(([a2, a3, numeric, id]) => [
    exact("country", "alpha2", a2, id),
    exact("country", "alpha3", a3, id),
    exact("country", "numeric", numeric, id),
  ]),
  exact("state", "fips", "06", "california"),
  exact("year", "year", "2020", "2020"),
  exact("year", "year", "2021", "2021"),
];
const concordance = resolveConcordance(mappings, { revision: "concordance-v1" });
const geoSchema: GeographicDatasetSchema = {
  id: "geography-schema",
  revision: "v1",
  format: "geojson",
  collections: [
    {
      collection: "features",
      dimension: country,
      codelist: list("numeric"),
      identifier: { kind: "id" },
    },
  ],
};
const topoSchema: GeographicDatasetSchema = {
  ...geoSchema,
  format: "topojson",
  collections: [
    { ...geoSchema.collections[0], collection: "countries" },
    {
      collection: "states",
      dimension: state,
      codelist: list("fips"),
      identifier: { kind: "property", property: "fips" },
    },
  ],
};
// Small synthetic rectangles: not authoritative country boundaries.
const feature = (id?: unknown) => ({
  type: "Feature",
  ...(id === undefined ? {} : { id }),
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  },
  properties: {},
});
const geo = (...ids: unknown[]) => ({
  type: "FeatureCollection",
  features: ids.map(feature),
});
const topology = {
  type: "Topology",
  arcs: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  objects: {
    countries: {
      type: "GeometryCollection",
      geometries: ["036", 840, "554"].map((id) => ({
        type: "Polygon",
        id,
        arcs: [[0]],
      })),
    },
    states: {
      type: "Polygon",
      properties: { fips: "06" },
      arcs: [[0]],
    },
  },
};
const canonicalize = (document: unknown, schema = geoSchema) =>
  canonicalizeGeographicDataset(document, schema, snapshot, concordance);

function measureSchema(
  id: string,
  codelist: string,
  unit: string,
): SemanticSchema {
  return {
    id: "schema-" + id,
    revision: "v1",
    dimensions: [
      { field: "country", dimension: country, codelist: list(codelist) },
      { field: "year", dimension: year, codelist: list("year") },
    ],
    measures: [
      {
        field: "value",
        measure: { id, name: id, unit, aggregation: "sum" },
        scale: 1,
      },
    ],
  };
}

const population = [
  { country: "AU", year: "2020", value: "25" },
  { country: "AU", year: "2021", value: "26" },
  { country: "US", year: "2020", value: "100" },
  { country: "CA", year: "2020", value: "40" },
];
const gdp = [
  { country: "AUS", year: "2020", value: "1000" },
  { country: "AUS", year: "2021", value: "1300" },
  { country: "USA", year: "2020", value: "3000" },
  { country: "CAN", year: "2020", value: "800" },
];
const query: QuerySpec = {
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
        left: { kind: "measure", measureId: "gdp" },
        right: { kind: "measure", measureId: "population" },
      },
    },
  ],
};
async function run(spec = query) {
  const cubes = [
    canonicalizeCube(
      createCube(population, measureSchema("population", "alpha2", "persons"), {
        datasetId: "population",
        revision: "v1",
      }),
      concordance,
    ),
    canonicalizeCube(
      createCube(gdp, measureSchema("gdp", "alpha3", "USD"), {
        datasetId: "gdp",
        revision: "v1",
      }),
      concordance,
    ),
  ];
  return executeQuery(
    planQuery(spec, { sources: cubes.map(describeQuerySource) }),
    { provider: createInMemoryProvider(cubes) },
  );
}

describe("geographic dataset canonicalization", () => {
  it("preserves string codes, numeric IDs, revisions and source indices", () => {
    const result = canonicalize(geo("036", 840));
    expect(result).toMatchObject({
      snapshot,
      schemaId: geoSchema.id,
      schemaRevision: "v1",
      concordanceRevision: concordance.revision,
      format: "geojson",
      diagnostics: [],
      collections: [
        {
          collection: "features",
          dimension: country,
          geometries: [
            {
              collection: "features",
              index: 0,
              source: codedRef("country", "numeric", "v1", "036"),
              member: canonicalMember("country", "australia"),
              mappingRevisions: ["mapping-v1"],
            },
            {
              index: 1,
              source: codedRef("country", "numeric", "v1", "840"),
              member: canonicalMember("country", "usa"),
            },
          ],
        },
      ],
    });
    expect(canonicalize(geo(36)).diagnostics[0].kind).toBe("unmapped");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("maps TopoJSON named collections independently, including singleton objects", () => {
    const result = canonicalize(topology, topoSchema);
    expect(result.diagnostics).toEqual([]);
    expect(result.collections[0].geometries.map((g) => g.member)).toEqual(
      canonicalize(geo("036", 840, "554")).collections[0].geometries.map(
        (g) => g.member,
      ),
    );
    expect(result.collections[1].geometries[0]).toMatchObject({
      collection: "states",
      index: 0,
      source: codedRef("state", "fips", "v1", "06"),
      member: canonicalMember("state", "california"),
    });
  });

  it("reads named own properties rather than IDs or inherited properties", () => {
    const schema: GeographicDatasetSchema = {
      ...geoSchema,
      collections: [
        { ...geoSchema.collections[0], identifier: { kind: "property", property: "code" } },
      ],
    };
    const document = {
      type: "FeatureCollection",
      features: [
        { ...feature("840"), properties: { code: "036" } },
        { ...feature(), properties: Object.create({ code: "840" }) },
        { ...feature(), properties: null },
      ],
    };
    const result = canonicalize(document, schema);
    expect(result.collections[0].geometries[0].member.id).toBe("australia");
    expect(result.diagnostics.map((d) => [d.index, d.kind])).toEqual([
      [1, "missing-identifier"],
      [2, "missing-identifier"],
    ]);
  });

  it.each([undefined, null, ""])("diagnoses missing identifier %s", (id) => {
    expect(canonicalize(geo(id)).diagnostics).toMatchObject([
      { collection: "features", index: 0, kind: "missing-identifier" },
    ]);
  });

  it.each([true, {}, [], 3.14, Infinity, Number.MAX_SAFE_INTEGER + 1, "x\n", "x".repeat(257)])(
    "diagnoses invalid identifier %s",
    (id) => {
      const result = canonicalize(geo(id));
      expect(result.diagnostics[0].kind).toBe("invalid-identifier");
      expect(result.collections[0].geometries).toEqual([]);
    },
  );

  it("reports unresolved and conflicting codes without inventing identities", () => {
    const conflict = resolveConcordance(
      [...mappings, exact("country", "numeric", "036", "other")],
      { revision: "conflicting" },
    );
    const result = canonicalizeGeographicDataset(
      geo("036", "999", 840),
      geoSchema,
      snapshot,
      conflict,
    );
    expect(result.diagnostics.map((d) => [d.index, d.kind])).toEqual([
      [0, "conflict"],
      [1, "unmapped"],
    ]);
    expect(result.collections[0].geometries.map((g) => g.member.id)).toEqual(["usa"]);
  });

  it("does not accept unverified or approximate concordance edges", () => {
    const fuzzy = resolveConcordance(
      [
        { ...exact("country", "numeric", "036", "australia"), verified: false },
        { ...exact("country", "numeric", "840", "usa"), relationship: "close" },
      ],
      { revision: "fuzzy" },
    );
    const result = canonicalizeGeographicDataset(geo("036", 840), geoSchema, snapshot, fuzzy);
    expect(result.diagnostics.map((d) => d.kind)).toEqual(["unmapped", "unmapped"]);
  });

  it("retains repeated geometry references and diagnoses code and canonical collisions", () => {
    const alias = resolveConcordance(
      [...mappings, exact("country", "numeric", "001", "australia")],
      { revision: "alias" },
    );
    const result = canonicalizeGeographicDataset(
      geo("036", "036", "001"),
      geoSchema,
      snapshot,
      alias,
    );
    expect(result.collections[0].geometries.map((g) => g.index)).toEqual([0, 1, 2]);
    expect(result.diagnostics.map((d) => [d.index, d.kind])).toEqual([
      [1, "duplicate-code"],
      [1, "duplicate-member"],
      [2, "duplicate-member"],
    ]);
  });

  it("does not inspect coordinates or mutate the original documents", () => {
    const before = JSON.stringify(topology);
    expect(canonicalize(topology, topoSchema)).toEqual(canonicalize(topology, topoSchema));
    expect(JSON.stringify(topology)).toBe(before);
    const document = geo("036");
    Object.defineProperty(document.features[0], "geometry", {
      get() { throw new Error("must not inspect geometry"); },
    });
    expect(canonicalize(document).collections[0].geometries).toHaveLength(1);
  });

  it("supports empty collections", () => {
    expect(canonicalize(geo()).collections[0].geometries).toEqual([]);
  });

  it.each([
    null,
    {},
    { type: "FeatureCollection" },
    { type: "FeatureCollection", features: [null] },
    { type: "FeatureCollection", features: [{ type: "Point" }] },
    topology,
  ])("rejects invalid GeoJSON structure", (document) => {
    expect(() => canonicalize(document)).toThrow(UdcError);
  });

  it("rejects missing or malformed TopoJSON objects", () => {
    expect(() => canonicalize({ ...topology, objects: {} }, topoSchema)).toThrow(UdcError);
    expect(() => canonicalize({
      ...topology,
      objects: { countries: { type: "GeometryCollection" } },
    }, topoSchema)).toThrow(UdcError);
  });

  it("rejects invalid schema metadata and duplicate collection mappings", () => {
    const mapping = geoSchema.collections[0];
    for (const schema of [
      { ...geoSchema, id: "" },
      { ...geoSchema, revision: "" },
      { ...geoSchema, collections: [] },
      { ...geoSchema, collections: [mapping, mapping] },
      { ...geoSchema, collections: [{ ...mapping, collection: "wrong" }] },
      { ...geoSchema, collections: [{ ...mapping, codelist: { id: "numeric", revision: "" } }] },
      { ...geoSchema, collections: [{ ...mapping, identifier: { kind: "property", property: "" } }] },
    ] as GeographicDatasetSchema[]) {
      expect(() => validateGeographicDatasetSchema(schema)).toThrow(UdcError);
    }
    expect(() => canonicalizeGeographicDataset(geo("036"), geoSchema, { ...snapshot, revision: "" }, concordance)).toThrow(UdcError);
  });

  it("enforces the cumulative geometry entry limit before processing", () => {
    const document = {
      type: "FeatureCollection",
      features: Array(UDC_LIMITS.coverageContributions + 1).fill(feature("036")),
    };
    expect(() => canonicalize(document)).toThrow(/limit exceeded/);
  });
});

describe("golden UDC population × GDP × geometry integration", () => {
  it("associates equivalent GeoJSON and TopoJSON members across three code lists", async () => {
    const result = await run();
    const before = JSON.stringify(result);
    const expected = new Map([
      ["australia/2020", { value: 40, index: 0 }],
      ["australia/2021", { value: 50, index: 0 }],
      ["usa/2020", { value: 30, index: 1 }],
      ["canada/2020", { value: 20, index: undefined }],
    ]);
    for (const [geography, collection] of [
      [canonicalize(geo("036", 840, "554")), "features"],
      [canonicalize(topology, topoSchema), "countries"],
    ] as const) {
      const association = associateGeographicQuery(result, geography, collection);
      expect(association.rows).toHaveLength(expected.size);
      for (const row of association.rows) {
        const member = (dimension: string) =>
          row.observation.coordinate.members.find((m) => m.dimensionId === dimension)?.id;
        const e = expected.get(member("country") + "/" + member("year"))!;
        expect(e).toBeDefined();
        expect(row.observation.values["gdp-per-capita"]?.value).toBe(e.value);
        expect(row.geometries.map((g) => g.index)).toEqual(e.index === undefined ? [] : [e.index]);
        expect(row.observation.values["gdp-per-capita"]).toMatchObject({
          inputs: expect.arrayContaining([
            expect.objectContaining({ measureId: "population", contributors: expect.arrayContaining([expect.objectContaining({ snapshot: expect.objectContaining({ datasetId: "population" }) })]) }),
            expect.objectContaining({ measureId: "gdp", contributors: expect.arrayContaining([expect.objectContaining({ snapshot: expect.objectContaining({ datasetId: "gdp" }) })]) }),
          ]),
        });
      }
      expect(association.unmatchedGeometries.map((g) => g.member.id)).toEqual(["new-zealand"]);
      expect(association.geography.snapshot).toEqual(snapshot);
      expect(association.rows.map((row) => row.observation)).toEqual(result.observations);
    }
    expect(JSON.stringify(result)).toBe(before);
  });

  it("keeps all geometries for repeated canonical IDs without duplicating observations", async () => {
    const result = await run();
    const association = associateGeographicQuery(result, canonicalize(geo("036", "036")), "features");
    const matched = association.rows.filter((row) => row.geometries.length);
    expect(matched).toHaveLength(2);
    expect(matched.map((row) => row.geometries.map((g) => g.index))).toEqual([[0, 1], [0, 1]]);
    expect(association.rows).toHaveLength(result.observations.length);
  });

  it("rejects unknown collections and queries without the geographic axis", async () => {
    const result = await run();
    const geography = canonicalize(topology, topoSchema);
    expect(() => associateGeographicQuery(result, geography, "missing")).toThrow(UdcError);
    expect(() => associateGeographicQuery(result, geography, "states")).toThrow(UdcError);
    const rolled = await run({ ...query, dimensions: ["year"] });
    expect(() => associateGeographicQuery(rolled, geography, "countries")).toThrow(UdcError);
  });

  it("preserves rows with no geography and handles empty query results", async () => {
    const result = await run();
    const geography = canonicalize(geo("036", "840"));
    expect(associateGeographicQuery(result, canonicalize(geo()), "features").rows.every((row) => !row.geometries.length)).toBe(true);
    const empty = associateGeographicQuery({ ...result, observations: [] }, geography, "features");
    expect(empty.rows).toEqual([]);
    expect(empty.unmatchedGeometries).toEqual(geography.collections[0].geometries);
  });
});
