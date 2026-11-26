import { describe, expect, it } from "vitest";
import {
  aggregateCube,
  canonicalMember,
  codedRef,
  getCellKey,
  UdcError,
  type CanonicalCube,
  type MeasureDefinition,
  type MeasureProvenance,
  type Observation,
  type Member,
} from "../src/index";

const dimensions = [
  { id: "country", name: "Country" },
  { id: "year", name: "Year" },
];
const measures: MeasureDefinition[] = [
  { id: "revenue", name: "Revenue", unit: "USD", aggregation: "sum" },
  {
    id: "temperature",
    name: "Temperature",
    unit: "celsius",
    aggregation: "average",
  },
  { id: "flag", name: "Flag", unit: "dimensionless", aggregation: "count" },
];
const snapshot = { datasetId: "fixture" };
function row(
  country: string,
  year: string,
  index: number,
  revenue: number | null,
  temperature: number | null,
  flag: number | null,
): Observation<Member> {
  const coordinate = {
    members: [
      canonicalMember("country", "country:" + country),
      canonicalMember("year", "year:" + year),
    ],
  };
  const provenance = (measureId: string): MeasureProvenance => ({
    snapshot,
    sourceRow: index,
    sourceCoordinate: {
      members: [
        codedRef("country", "iso", "1", country),
        codedRef("year", "calendar", "1", year),
      ],
    },
    schemaId: "schema",
    schemaRevision: "v1",
    measureId,
    unit: measureId === "revenue" ? "USD" : "dimensionless",
  });
  return {
    coordinate,
    cellKey: getCellKey(coordinate),
    values: {
      revenue: { value: revenue, provenance: provenance("revenue") },
      temperature: {
        value: temperature,
        provenance: provenance("temperature"),
      },
      flag: { value: flag, provenance: provenance("flag") },
    },
  };
}
const source: CanonicalCube = {
  stage: "canonical",
  dimensions,
  measures,
  observations: [
    row("us", "2023", 1, 10, 10, 1),
    row("us", "2024", 2, 30, 30, null),
    row("eu", "2023", 3, 50, 50, null),
    row("ca", "2023", 4, null, null, null),
  ],
  snapshots: [snapshot],
  schemaRevisions: ["v1"],
  concordanceRevisions: ["c1"],
};

describe("explicit cube aggregation", () => {
  it("sums, counts, averages and retains all original source-row lineage", () => {
    const result = aggregateCube(source, []);
    expect(result.stage).toBe("aggregated");
    expect(result.observations).toHaveLength(1);
    const values = result.observations[0].values;
    expect(values.revenue.value).toBe(90);
    expect(values.temperature.value).toBe(30);
    expect(values["flag:count"].value).toBe(1);
    expect(values.revenue.contributors).toHaveLength(4);
    expect(values.revenue.contributors.map((p) => p.sourceRow)).toEqual([
      4, 3, 1, 2,
    ]);
    expect(result.measures.find((m) => m.id === "flag:count")).toMatchObject({
      unit: "observations",
      aggregation: "sum",
    });
    expect(result.snapshots).toEqual([snapshot]);
  });

  it("preserves sufficient statistics across repeated rollups", () => {
    const byCountry = aggregateCube(source, ["country"]);
    expect(byCountry.observations).toHaveLength(3);
    const empty = byCountry.observations.find((o) =>
      o.coordinate.members.some((m) => m.id === "country:ca"),
    );
    expect(empty!.values.revenue.value).toBeNull();
    expect(empty!.values["flag:count"].value).toBe(0);
    const rolled = aggregateCube(byCountry, []);
    const direct = aggregateCube(source, []);
    expect(rolled.observations[0].values.temperature.value).toBe(
      direct.observations[0].values.temperature.value,
    );
    expect(rolled.observations[0].values.revenue.value).toBe(90);
    expect(rolled.observations[0].values["flag:count"].value).toBe(1);
    expect(rolled.observations[0].values.temperature.state).toEqual({
      sum: 90,
      count: 3,
    });
  });

  it("does not infer a policy for non-additive measures", () => {
    const incompatible: CanonicalCube = {
      ...source,
      measures: source.measures.map((measure) =>
        measure.id === "temperature"
          ? { ...measure, aggregation: "none" }
          : measure,
      ),
    };
    expect(() => aggregateCube(incompatible, ["country"])).toThrow(UdcError);
    expect(
      aggregateCube(incompatible, ["country", "year"]).observations,
    ).toHaveLength(4);
  });

  it("rejects undeclared dimensions and duplicate coordinates", () => {
    expect(() => aggregateCube(source, ["unknown"])).toThrow(UdcError);
    expect(() => aggregateCube(source, ["country", "country"])).toThrow(
      UdcError,
    );
    const duplicate: CanonicalCube = {
      ...source,
      observations: [...source.observations, source.observations[0]],
    };
    expect(() => aggregateCube(duplicate, [])).toThrow(UdcError);
  });
});

describe("mergeable extrema", () => {
  it.each(["min", "max"] as const)(
    "matches direct and repeated %s with nulls and lineage",
    (aggregation) => {
      const data = {
        ...source,
        measures: source.measures.map((m) =>
          m.id === "revenue" ? { ...m, aggregation } : m,
        ),
      };
      const direct = aggregateCube(data, []);
      const repeated = aggregateCube(aggregateCube(data, ["country"]), []);
      const expected = aggregation === "min" ? 10 : 50;
      for (const cube of [direct, repeated]) {
        const value = cube.observations[0].values.revenue;
        expect(value.value).toBe(expected);
        expect(value.state).toEqual({ sum: 0, count: 3, extremum: expected });
        expect(value.contributors.map((p) => p.sourceRow).sort()).toEqual([
          1, 2, 3, 4,
        ]);
      }
      const allNull = aggregateCube(
        { ...data, observations: [data.observations[3]] },
        [],
      );
      expect(allNull.observations[0].values.revenue).toMatchObject({
        value: null,
        state: { sum: 0, count: 0, extremum: null },
      });
    },
  );

  it.each(["min", "max"] as const)(
    "handles huge values without an irrelevant sum overflow (%s)",
    (aggregation) => {
      const data = {
        ...source,
        measures: source.measures.map((m) =>
          m.id === "revenue" ? { ...m, aggregation } : m,
        ),
        observations: source.observations.map((o) => ({
          ...o,
          values: {
            ...o.values,
            revenue: { ...o.values.revenue, value: Number.MAX_VALUE },
          },
        })),
      };
      expect(aggregateCube(data, []).observations[0].values.revenue.value).toBe(
        Number.MAX_VALUE,
      );
    },
  );

  it("matches seeded independent extrema across random groups and ordering", () => {
    let seed = 1234567;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let trial = 0; trial < 40; trial++) {
      const numbers = Array.from({ length: 20 }, () =>
        next() % 5 === 0 ? null : (next() % 200) - 100,
      );
      const observations = numbers.map((n, i) =>
        row("c" + (i % 3), String(i), i + 1, n, 0, null),
      );
      const valid = numbers.filter((n): n is number => n !== null);
      for (const aggregation of ["min", "max"] as const) {
        const data = {
          ...source,
          measures: source.measures.map((m) =>
            m.id === "revenue" ? { ...m, aggregation } : m,
          ),
          observations,
        };
        const expected = !valid.length
          ? null
          : aggregation === "min"
            ? Math.min(...valid)
            : Math.max(...valid);
        expect(
          aggregateCube(data, []).observations[0].values.revenue.value,
        ).toBe(expected);
        expect(
          aggregateCube(
            aggregateCube(
              { ...data, observations: [...observations].reverse() },
              ["country"],
            ),
            [],
          ).observations[0].values.revenue.value,
        ).toBe(expected);
      }
    }
  });
});
