import { aggregateCube } from "./aggregate-cube";
import { integrateCubes } from "./integrate-cubes";
import { calculateMeasure, diceCube, rollupCube } from "./olap";
import { filterCube, topNCube, type AnalyticalCube } from "./advanced-olap";
import { getCellKey } from "./coordinate";
import { assertBound, UDC_LIMITS, UdcError } from "./limits";
import { describeQuerySource, planQuery } from "./plan-query";
import type {
  QueryInputs,
  QueryOrder,
  QueryPlan,
  QueryResult,
  QueryPlanSource,
  QuerySourceRequest,
} from "./query-types";
import type { CanonicalCube } from "./types";

// Canonical object key order for JSON round-tripped plans and metadata.
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      );
    }
    return item;
  });
}

function projectSource(
  cube: CanonicalCube,
  selected: QueryPlanSource,
): CanonicalCube {
  const ids = new Set(selected.measureIds);
  const declared = new Set(cube.measures.map((m) => m.id));
  const axes = new Set(cube.dimensions.map((d) => d.id));
  const seen = new Set<string>();
  assertBound(cube.observations.length, UDC_LIMITS.rows, "query source rows");
  return {
    ...cube,
    measures: cube.measures
      .filter((m) => ids.has(m.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    observations: cube.observations.map((row) => {
      if (getCellKey(row.coordinate) !== row.cellKey || seen.has(row.cellKey))
        throw new UdcError("INVALID", "Invalid or duplicate source coordinate");
      seen.add(row.cellKey);
      const actual = row.coordinate.members.map((m) => m.dimensionId);
      if (
        actual.length !== axes.size ||
        new Set(actual).size !== axes.size ||
        row.coordinate.members.some(
          (m) => m.kind !== "canonical" || !axes.has(m.dimensionId),
        )
      )
        throw new UdcError("INCOMPATIBLE", "Invalid source coordinate grain");
      if (
        Object.keys(row.values).length !== declared.size ||
        Object.keys(row.values).some((id) => !declared.has(id))
      )
        throw new UdcError("INCOMPATIBLE", "Invalid source measure set");
      for (const id of ids) {
        const value = row.values[id];
        if (
          !value ||
          (value.value !== null && !Number.isFinite(value.value)) ||
          !value.provenance
        )
          throw new UdcError("INVALID", "Invalid source measure value");
      }
      return {
        ...row,
        values: Object.fromEntries(
          Object.entries(row.values).filter(([id]) => ids.has(id)),
        ),
      };
    }),
  };
}

type Observation = AnalyticalCube["observations"][number];

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareObservations(
  a: Observation,
  b: Observation,
  orderBy: readonly QueryOrder[],
): number {
  for (const order of orderBy) {
    const direction = order.direction === "asc" ? 1 : -1;
    if (order.kind === "dimension") {
      const left = a.coordinate.members.find(
        (m) => m.dimensionId === order.dimensionId,
      )!;
      const right = b.coordinate.members.find(
        (m) => m.dimensionId === order.dimensionId,
      )!;
      const comparison = compareKey(left.id, right.id) * direction;
      if (comparison) return comparison;
    } else {
      const left = a.values[order.measureId]?.value;
      const right = b.values[order.measureId]?.value;
      // Numbers first, then explicit null, then absent, in either direction.
      const category = (value: number | null | undefined) =>
        value === undefined ? 2 : value === null ? 1 : 0;
      const missing = category(left) - category(right);
      if (missing) return missing;
      if (typeof left === "number" && typeof right === "number") {
        const comparison =
          (left < right ? -1 : left > right ? 1 : 0) * direction;
        if (comparison) return comparison;
      }
    }
  }
  return compareKey(a.cellKey, b.cellKey);
}

/** Execute only against the revision-pinned inputs in the validated plan. */
export async function executeQuery(
  plan: QueryPlan,
  inputs: QueryInputs,
): Promise<QueryResult> {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.sources))
    throw new UdcError("INVALID", "Invalid query plan");
  const { provider, hierarchies } = inputs;
  assertBound(provider.sources.length, UDC_LIMITS.cubes, "query input cubes");
  // Validate against declared metadata before starting any provider I/O.
  const fresh = planQuery(plan.query, {
    sources: provider.sources,
    hierarchies,
  });
  if (
    stableJson(fresh) !== stableJson(plan) ||
    provider.sources.length !== fresh.sources.length
  )
    throw new UdcError(
      "CONFLICT",
      "Query plan does not match supplied source revisions or steps",
    );

  const query = fresh.query;
  const sources: CanonicalCube[] = [];
  // Preserve plan order and the existing source bounds. Providers must return
  // complete canonical snapshots; only this engine applies semantic operators.
  for (const selected of fresh.sources) {
    const request = JSON.parse(
      JSON.stringify({ ...selected, filters: query.filters ?? [] }),
    ) as QuerySourceRequest;
    const cube = await provider.loadSource(request);
    if (stableJson(describeQuerySource(cube)) !== stableJson(selected.source))
      throw new UdcError(
        "CONFLICT",
        "Provider returned different source metadata",
      );
    sources.push(diceCube(projectSource(cube, selected), query.filters ?? []));
  }
  let cube: AnalyticalCube =
    sources.length === 1
      ? sources[0]
      : integrateCubes(sources[0], sources[1], { join: query.join ?? "inner" });
  for (const rollup of query.rollups ?? []) {
    if (cube.stage !== "canonical" && cube.stage !== "aggregated")
      throw new UdcError("INCOMPATIBLE", "Rollup requires dense input");
    const hierarchy = hierarchies!.find(
      (h) => h.key === rollup.hierarchyKey && h.revision === rollup.revision,
    )!;
    cube = rollupCube(cube, hierarchy, rollup.targetMembers);
  }
  if (fresh.steps.includes("aggregate")) {
    if (cube.stage !== "canonical" && cube.stage !== "aggregated")
      throw new UdcError("INCOMPATIBLE", "Aggregation requires dense input");
    cube = aggregateCube(cube, query.dimensions);
  }
  const calculation = query.calculatedMeasures?.[0];
  if (calculation) cube = calculateMeasure(cube, calculation);
  if (query.measureFilter) cube = filterCube(cube, query.measureFilter);
  if (query.topN) cube = topNCube(cube, query.topN);
  const measures = query.measures.map((id) => {
    const measure = cube.measures.find((m) => m.id === id);
    if (!measure)
      throw new UdcError(
        "INCOMPATIBLE",
        "Missing planned output measure: " + id,
      );
    return measure;
  });
  const orderBy = query.orderBy ?? [];
  const ordered = orderBy.length
    ? [...cube.observations].sort((a, b) => compareObservations(a, b, orderBy))
    : query.topN
      ? cube.observations
      : [...cube.observations].sort((a, b) => compareKey(a.cellKey, b.cellKey));
  const rows =
    query.limit === undefined ? ordered : ordered.slice(0, query.limit);
  return {
    stage: "query-result",
    inputStage: cube.stage,
    dimensions: query.dimensions.map((id) =>
      cube.dimensions.find((d) => d.id === id)!,
    ),
    measures,
    observations: rows.map((row) => ({
      coordinate: {
        members: query.dimensions.map((id) =>
          row.coordinate.members.find((m) => m.dimensionId === id)!,
        ),
      },
      cellKey: row.cellKey,
      values: Object.fromEntries(
        query.measures
          .filter((id) => Object.hasOwn(row.values, id))
          .map((id) => [id, row.values[id]]),
      ),
      ...("presence" in row && row.presence ? { presence: row.presence } : {}),
    })),
    snapshots: cube.snapshots,
    schemaRevisions: cube.schemaRevisions,
    concordanceRevisions: cube.concordanceRevisions,
    ...("hierarchyRollups" in cube
      ? { hierarchyRollups: cube.hierarchyRollups }
      : {}),
    ...("join" in cube ? { join: cube.join } : {}),
    ...(cube.stage === "calculated" ? { definition: cube.definition } : {}),
  };
}
