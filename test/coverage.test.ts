import { describe, expect, it } from "vitest";
import {
  UDC_LIMITS,
  UdcError,
  canonicalMember,
  canonicalizeCube,
  codedRef,
  countDatasetCoverage,
  createCube,
  getCellKey,
  projectDatasetCoverage,
  resolveConcordance,
  type CanonicalCoordinateDataset,
  type CodeMapping,
  type Dimension,
  type ProjectedDatasetCoverage,
  type SemanticSchema,
} from "../src/index";

const country = { id: "country", name: "Country" };
const year = { id: "year", name: "Year" };
const sex = { id: "sex", name: "Sex" };
const dimensions = [country, year, sex];
const exact = (dimensionId: string, code: string): CodeMapping => ({
  source: codedRef(dimensionId, dimensionId + "-codes", "v1", code),
  canonical: canonicalMember(dimensionId, dimensionId + ":" + code),
  relationship: "exact",
  verified: true,
  revision: "mapping-v1",
  provenance: "fixture",
});
const concordance = resolveConcordance(
  [
    ...["US", "CN", "IN"].map((code) => exact("country", code)),
    ...["2020", "2021"].map((code) => exact("year", code)),
    ...["F", "M"].map((code) => exact("sex", code)),
  ],
  { revision: "mapping-set-v1" },
);
const coordinate = (c: string, y: string, s?: string) => ({
  members: [
    canonicalMember("year", "year:" + y),
    ...(s ? [canonicalMember("sex", "sex:" + s)] : []),
    canonicalMember("country", "country:" + c),
  ],
});
const key = (c: string, y: string) => getCellKey(coordinate(c, y));

function cube(
  datasetId: string,
  rows: Record<string, string>[],
  sourceDimensions: readonly Dimension[] = dimensions,
) {
  const schema: SemanticSchema = {
    id: "schema:" + datasetId,
    revision: "v1",
    dimensions: sourceDimensions.map((dimension) => ({
      field: dimension.id,
      dimension,
      codelist: { id: dimension.id + "-codes", revision: "v1" },
    })),
    measures: [
      {
        field: "value",
        measure: {
          id: "quantity:" + datasetId,
          name: "Example",
          unit: "persons",
          aggregation: "none",
        },
        scale: 1,
      },
    ],
  };
  return canonicalizeCube(
    createCube(rows, schema, { datasetId, revision: "rev-1" }),
    concordance,
  );
}

function countryYearDataset(
  datasetId: string,
  entries: Array<[string, string]>,
): CanonicalCoordinateDataset {
  return {
    stage: "coordinate-dataset",
    snapshot: { datasetId, revision: "rev-1" },
    dimensions: [year, country],
    coordinates: entries.map(([c, y]) => coordinate(c, y)),
    concordanceRevisions: ["mapping-set-v1"],
    schemaRevisions: ["coordinate-schema-v1"],
  };
}

function fail(fn: () => unknown, expected: UdcError["code"]) {
  try {
    fn();
    throw new Error("Expected UdcError");
  } catch (error) {
    expect(error).toBeInstanceOf(UdcError);
    expect((error as UdcError).code).toBe(expected);
  }
}

describe("coordinate-only dataset coverage", () => {
  it("projects three-dimensional observations onto country-year, ignoring measure nulls and aggregation policy", () => {
    const population = cube("population", [
      { country: "US", year: "2020", sex: "F", value: "" },
      { country: "US", year: "2020", sex: "M", value: "0" },
      { country: "CN", year: "2021", sex: "F", value: "10" },
    ]);
    const before = JSON.stringify(population);
    const result = projectDatasetCoverage(population, ["year", "country"]);
    expect(result.stage).toBe("dataset-coverage");
    expect(result.dimensions).toEqual([country, year]);
    expect(result.snapshot).toEqual({
      datasetId: "population",
      revision: "rev-1",
    });
    expect(result.schemaRevisions).toEqual(["v1"]);
    expect(result.concordanceRevisions).toEqual(["mapping-set-v1"]);
    expect(result.coordinates.map((o) => o.cellKey)).toEqual(
      [key("CN", "2021"), key("US", "2020")].sort(),
    );
    expect(
      result.coordinates.find((o) => o.cellKey === key("US", "2020"))
        ?.sourceCoordinateCount,
    ).toBe(2);
    expect(
      result.coordinates.every((o) => o.coordinate.members.length === 2),
    ).toBe(true);
    expect(JSON.stringify(population)).toBe(before);
  });

  it("accepts measure-less coordinates with repeats and without manufacturing values", () => {
    const source = countryYearDataset("locations", [
      ["US", "2020"],
      ["US", "2020"],
      ["IN", "2021"],
    ]);
    const result = projectDatasetCoverage(source, ["country", "year"]);
    expect(result.coordinates).toHaveLength(2);
    expect(
      result.coordinates.find((o) => o.cellKey === key("US", "2020"))
        ?.sourceCoordinateCount,
    ).toBe(2);
    expect("measures" in result).toBe(false);
    expect("values" in result.coordinates[0]).toBe(false);
  });

  it("counts each dataset ID once per coordinate across different grains", () => {
    const population = projectDatasetCoverage(
      cube("population", [
        { country: "US", year: "2020", sex: "F", value: "" },
        { country: "US", year: "2020", sex: "M", value: "3" },
        { country: "CN", year: "2021", sex: "F", value: "4" },
      ]),
      ["country", "year"],
    );
    const gdp = projectDatasetCoverage(
      cube(
        "gdp",
        [
          { country: "US", year: "2020", value: "0" },
          { country: "IN", year: "2021", value: "" },
        ],
        [country, year],
      ),
      ["country", "year"],
    );
    const locations = projectDatasetCoverage(
      countryYearDataset("locations", [
        ["US", "2020"],
        ["CN", "2021"],
        ["US", "2020"],
      ]),
      ["country", "year"],
    );
    const summary = countDatasetCoverage(
      [locations, gdp, population],
      [year, country],
    );
    expect(summary.stage).toBe("coverage-summary");
    expect(summary.dimensions).toEqual([country, year]);
    expect(summary.observations.map((o) => o.cellKey)).toEqual(
      [key("CN", "2021"), key("US", "2020"), key("IN", "2021")].sort(),
    );
    const byKey = new Map(summary.observations.map((o) => [o.cellKey, o]));
    expect(byKey.get(key("US", "2020"))).toMatchObject({
      datasetCount: 3,
      datasetIds: ["gdp", "locations", "population"],
    });
    expect(byKey.get(key("CN", "2021"))).toMatchObject({
      datasetCount: 2,
      datasetIds: ["locations", "population"],
    });
    expect(byKey.get(key("IN", "2021"))).toMatchObject({
      datasetCount: 1,
      datasetIds: ["gdp"],
    });
    expect(
      countDatasetCoverage([gdp, population, locations], [country, year]),
    ).toEqual(summary);
  });

  it("deduplicates repeated uses of the same dataset while preserving snapshots", () => {
    const base = countryYearDataset("shared-hash", [["US", "2020"]]);
    const first = projectDatasetCoverage(
      { ...base, snapshot: { ...base.snapshot, vizId: "first" } },
      ["country", "year"],
    );
    const second = projectDatasetCoverage(
      { ...base, snapshot: { ...base.snapshot, vizId: "second" } },
      ["country", "year"],
    );
    const result = countDatasetCoverage([second, first], [country, year]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].datasetCount).toBe(1);
    expect(result.observations[0].datasetIds).toEqual(["shared-hash"]);
    expect(result.snapshots).toEqual([
      { datasetId: "shared-hash", revision: "rev-1", vizId: "first" },
      { datasetId: "shared-hash", revision: "rev-1", vizId: "second" },
    ]);
    fail(
      () =>
        countDatasetCoverage(
          [
            first,
            { ...second, snapshot: { ...second.snapshot, revision: "rev-2" } },
          ],
          [country, year],
        ),
      "CONFLICT",
    );
    fail(
      () =>
        countDatasetCoverage(
          [first, { ...second, concordanceRevisions: ["different-map"] }],
          [country, year],
        ),
      "CONFLICT",
    );
  });

  it("does not infer missing dimensions, cartesian products or approximate mappings", () => {
    const countryOnly: CanonicalCoordinateDataset = {
      stage: "coordinate-dataset",
      snapshot: { datasetId: "country-only" },
      dimensions: [country],
      coordinates: [{ members: [canonicalMember("country", "country:US")] }],
    };
    fail(
      () => projectDatasetCoverage(countryOnly, ["country", "year"]),
      "INCOMPATIBLE",
    );
    const countryProjected = projectDatasetCoverage(countryOnly, ["country"]);
    fail(
      () => countDatasetCoverage([countryProjected], [country, year]),
      "INCOMPATIBLE",
    );
    const none = countDatasetCoverage([], [country, year]);
    expect(none).toMatchObject({
      stage: "coverage-summary",
      observations: [],
      snapshots: [],
    });
    const projectedEmpty = projectDatasetCoverage(
      countryYearDataset("empty", []),
      ["country", "year"],
    );
    expect(projectedEmpty.coordinates).toEqual([]);
    expect(
      countDatasetCoverage([projectedEmpty], [country, year]).observations,
    ).toEqual([]);
  });

  it("supports a zero-dimension projection as one existence cell per nonempty dataset", () => {
    const first = projectDatasetCoverage(
      countryYearDataset("first", [
        ["US", "2020"],
        ["IN", "2021"],
      ]),
      [],
    );
    const second = projectDatasetCoverage(
      countryYearDataset("second", [["CN", "2021"]]),
      [],
    );
    expect(first.coordinates).toEqual([
      {
        coordinate: { members: [] },
        cellKey: getCellKey({ members: [] }),
        sourceCoordinateCount: 2,
      },
    ]);
    const summary = countDatasetCoverage([first, second], []);
    expect(summary.observations[0]).toMatchObject({
      datasetCount: 2,
      datasetIds: ["first", "second"],
    });
  });

  it("rejects integrated cubes, uncanonicalized coordinates, duplicate axes and invalid keys", () => {
    const source = cube("population", [
      { country: "US", year: "2020", sex: "F", value: "1" },
    ]);
    fail(
      () =>
        projectDatasetCoverage(
          {
            ...source,
            snapshots: [...source.snapshots, { datasetId: "other" }],
          },
          ["country", "year"],
        ),
      "INCOMPATIBLE",
    );
    fail(
      () => projectDatasetCoverage(source, ["country", "country"]),
      "DUPLICATE",
    );
    fail(() => projectDatasetCoverage(source, ["unknown"]), "INCOMPATIBLE");
    const invalidCoded = {
      ...countryYearDataset("bad", [["US", "2020"]]),
      coordinates: [
        {
          members: [
            codedRef("country", "country-codes", "v1", "US"),
            canonicalMember("year", "year:2020"),
          ],
        },
      ],
    };
    fail(
      () =>
        projectDatasetCoverage(
          invalidCoded as unknown as CanonicalCoordinateDataset,
          ["country", "year"],
        ),
      "INCOMPATIBLE",
    );
    const repeated = {
      ...source,
      observations: [...source.observations, ...source.observations],
    };
    fail(
      () => projectDatasetCoverage(repeated, ["country", "year"]),
      "DUPLICATE",
    );
    const projected = projectDatasetCoverage(
      countryYearDataset("good", [["US", "2020"]]),
      ["country", "year"],
    );
    fail(
      () =>
        countDatasetCoverage(
          [
            {
              ...projected,
              coordinates: [...projected.coordinates, ...projected.coordinates],
            },
          ],
          [country, year],
        ),
      "DUPLICATE",
    );
    fail(
      () =>
        countDatasetCoverage(
          [
            {
              ...projected,
              coordinates: [
                { ...projected.coordinates[0], cellKey: "invalid" },
              ],
            },
          ],
          [country, year],
        ),
      "DUPLICATE",
    );
    fail(
      () =>
        countDatasetCoverage(
          [
            projected,
            {
              ...projected,
              stage: "canonical",
            } as unknown as ProjectedDatasetCoverage,
          ],
          [country, year],
        ),
      "INCOMPATIBLE",
    );
  });

  it("fails closed at dataset and output budgets without truncation", () => {
    const source = projectDatasetCoverage(
      countryYearDataset("one", [["US", "2020"]]),
      ["country", "year"],
    );
    fail(
      () =>
        countDatasetCoverage(
          Array(UDC_LIMITS.coverageDatasets + 1).fill(source),
          [country, year],
        ),
      "LIMIT",
    );
    const make = (
      datasetId: string,
      from: number,
      count: number,
    ): ProjectedDatasetCoverage => ({
      stage: "dataset-coverage",
      snapshot: { datasetId },
      dimensions: [country, year],
      schemaRevisions: [],
      concordanceRevisions: [],
      coordinates: Array.from({ length: count }, (_, index) => {
        const c = {
          members: [
            canonicalMember("country", "country:" + (from + index)),
            canonicalMember("year", "year:2020"),
          ],
        };
        return {
          coordinate: c,
          cellKey: getCellKey(c),
          sourceCoordinateCount: 1,
        };
      }),
    });
    const a = make("a", 0, 10_000);
    const b = make("b", 10_000, 10_000);
    const c = make("c", 20_000, 1);
    expect(
      countDatasetCoverage([a, b], [country, year]).observations,
    ).toHaveLength(UDC_LIMITS.coverageOutputCoordinates);
    fail(() => countDatasetCoverage([a, b, c], [country, year]), "LIMIT");
  });
});
