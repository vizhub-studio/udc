import { readFileSync } from "node:fs";
import { csvParse } from "d3-dsv";
import {
  createCube,
  resolveConcordance,
  codedRef,
  canonicalMember,
  canonicalizeCube,
  describeQuerySource,
  validateQuery,
  planQuery,
  executeQuery,
  createInMemoryProvider,
} from "../dist/index.js";

const read = (file) =>
  csvParse(
    readFileSync(new URL("../test/fixtures/" + file, import.meta.url), "utf8"),
  );
const population = read("total_population.csv");
const gdp = read("GDP_current_USD.csv");
const locations = read("locations.csv");
const country = { id: "country", name: "Country" };
const year = { id: "year", name: "Year" };
const years = { id: "calendar-year", revision: "2014" };
const dimensions = (countryCodelist) => [
  { field: "countryCode", dimension: country, codelist: countryCodelist },
  { field: "year", dimension: year, codelist: years },
];
const popSchema = {
  id: "un-population",
  revision: "2014",
  dimensions: dimensions({ id: "un-m49", revision: "2014" }),
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
const gdpSchema = {
  id: "world-bank-gdp",
  revision: "2014",
  dimensions: dimensions({ id: "iso-alpha3", revision: "2014" }),
  measures: [
    {
      field: "gdp",
      measure: {
        id: "gdp-usd",
        name: "GDP (current US$)",
        unit: "USD",
        aggregation: "sum",
      },
      scale: 1,
    },
  ],
};
const exact = (source, canonical) => ({
  source,
  canonical,
  relationship: "exact",
  verified: true,
  revision: "2014-mapping",
  provenance: "2014 sample concordance, review for real-world reuse",
});
const mappings = locations.flatMap((row) => {
  const id =
    row.countryName === "United States of America"
      ? "country:usa"
      : "country:" + row.countryName.toLowerCase();
  const canonical = canonicalMember("country", id);
  return [
    exact(codedRef("country", "un-m49", "2014", row.unCountryCode), canonical),
    exact(codedRef("country", "iso-alpha3", "2014", row.alphaCode), canonical),
  ];
});
for (const value of new Set([...population, ...gdp].map((row) => row.year))) {
  mappings.push(
    exact(
      codedRef("year", "calendar-year", "2014", value),
      canonicalMember("year", "year:" + value),
    ),
  );
}
const concordance = resolveConcordance(mappings, { revision: "2014-fixture" });
const toCanonical = (rows, schema, id) =>
  canonicalizeCube(
    createCube(rows, schema, { datasetId: id, revision: "2014" }),
    concordance,
  );
const cubes = [
  toCanonical(population, popSchema, "un-population"),
  toCanonical(gdp, gdpSchema, "world-bank-gdp"),
];
const catalog = { sources: cubes.map(describeQuerySource) };
const query = async (spec) => {
  validateQuery(spec);
  const plan = planQuery(spec, catalog);
  const selected = cubes.filter((cube) =>
    plan.sources.some(
      (source) =>
        source.source.snapshot.datasetId === cube.snapshots[0].datasetId,
    ),
  );
  return executeQuery(plan, { provider: createInMemoryProvider(selected) });
};
const queryDimensions = ["country", "year"];
const filters = [{ dimensionId: "year", memberIds: ["year:1960"] }];
const countryOf = (row) =>
  row.coordinate.members.find((m) => m.dimensionId === "country")?.id;

const joined = await query({
  version: 1,
  dimensions: queryDimensions,
  measures: ["population", "gdp-usd"],
  filters,
});
console.log(
  joined.observations.map((row) => ({
    country: countryOf(row),
    population: row.values.population.value,
    gdp: row.values["gdp-usd"].value,
  })),
);

const top = await query({
  version: 1,
  dimensions: queryDimensions,
  measures: ["gdp-per-capita"],
  filters,
  calculatedMeasures: [
    {
      id: "gdp-per-capita",
      name: "GDP per capita",
      unit: "USD/person",
      expression: {
        kind: "binary",
        operator: "/",
        left: { kind: "measure", measureId: "gdp-usd" },
        right: { kind: "measure", measureId: "population" },
      },
    },
  ],
  measureFilter: {
    kind: "compare",
    measureId: "population",
    operator: "gte",
    value: 1000000,
  },
  topN: {
    measureId: "gdp-per-capita",
    direction: "desc",
    n: 10,
    ties: "include",
  },
});
console.log("Top observed GDP per capita in 1960 (population >= 1 million)");
console.log(
  top.observations.map((row) => ({
    country: countryOf(row),
    gdpPerCapita: row.values["gdp-per-capita"].value,
  })),
);
