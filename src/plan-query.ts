import { assertBound, assertId, UDC_LIMITS, UdcError } from "./limits";
import type { CanonicalCube } from "./types";
import { planCalculatedMeasures } from "./olap";
import type { MeasurePredicate } from "./advanced-olap";
import type {
  QueryCatalog,
  QueryPlan,
  QueryPlanSource,
  QuerySource,
  QuerySpec,
  QueryStep,
} from "./query-types";
import { validateQuery } from "./validate-query";

const sorted = (ids: readonly string[]) => [...ids].sort();
const same = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const fail = (
  code: ConstructorParameters<typeof UdcError>[0],
  message: string,
): never => {
  throw new UdcError(code, message);
};

function normalizeSource(source: QuerySource): QuerySource {
  assertId(source.snapshot.datasetId, "dataset");
  assertId(source.snapshot.revision, "snapshot revision");
  assertBound(
    source.dimensions.length,
    UDC_LIMITS.columns,
    "source dimensions",
  );
  assertBound(source.measures.length, UDC_LIMITS.columns, "source measures");
  const dimensions = sorted(source.dimensions);
  const measures = [...source.measures].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const id of dimensions) assertId(id, "dimension");
  for (const measure of measures) {
    assertId(measure.id, "measure");
    assertId(measure.unit, "unit");
    if (!["sum", "count", "average", "none"].includes(measure.aggregation))
      fail("INVALID", "Invalid aggregation");
  }
  if (
    new Set(dimensions).size !== dimensions.length ||
    new Set(measures.map((m) => m.id)).size !== measures.length
  )
    fail("DUPLICATE", "Duplicate source declarations");
  return {
    snapshot: { ...source.snapshot },
    dimensions,
    measures: measures.map((m) => ({ ...m })),
    schemaRevisions: sorted(source.schemaRevisions),
    concordanceRevisions: sorted(source.concordanceRevisions),
  };
}

/** Derive catalog metadata from a single immutable canonical source. */
export function describeQuerySource(cube: CanonicalCube): QuerySource {
  if (
    cube.stage !== "canonical" ||
    cube.snapshots.length !== 1 ||
    !cube.snapshots[0].revision
  )
    return fail(
      "INCOMPATIBLE",
      "Query source must have one revision-pinned canonical snapshot",
    );
  const snapshot = cube.snapshots[0];
  return normalizeSource({
    snapshot: { ...snapshot, revision: snapshot.revision! },
    dimensions: cube.dimensions.map((d) => d.id),
    measures: cube.measures,
    schemaRevisions: cube.schemaRevisions,
    concordanceRevisions: cube.concordanceRevisions,
  });
}

function predicateRefs(p: MeasurePredicate, refs: Set<string>): void {
  if (p.kind === "and" || p.kind === "or")
    for (const item of p.operands) predicateRefs(item, refs);
  else if (p.kind === "not") predicateRefs(p.operand, refs);
  else if ("measureId" in p) refs.add(p.measureId);
}

/** Resolve semantic dependencies against an authorized host-supplied catalog. */
export function planQuery(query: QuerySpec, catalog: QueryCatalog): QueryPlan {
  validateQuery(query);
  assertBound(
    catalog.sources.length,
    UDC_LIMITS.coverageDatasets,
    "catalog sources",
  );
  const sources = catalog.sources.map(normalizeSource);
  if (new Set(sources.map((s) => s.snapshot.datasetId)).size !== sources.length)
    fail("CONFLICT", "Multiple catalog snapshots for one dataset");
  const requiredAxes = new Set([
    ...query.dimensions,
    ...(query.filters ?? []).map((f) => f.dimensionId),
  ]);
  const hierarchyAxes = new Set<string>();
  for (const rollup of query.rollups ?? []) {
    const matches = (catalog.hierarchies ?? []).filter(
      (h) => h.key === rollup.hierarchyKey && h.revision === rollup.revision,
    );
    if (matches.length !== 1)
      fail(
        matches.length ? "CONFLICT" : "UNRESOLVED",
        "Hierarchy revision not uniquely resolved",
      );
    const axis = matches[0].dimensionId;
    if (!query.dimensions.includes(axis))
      fail("INCOMPATIBLE", "Rollup axis must be retained");
    if (hierarchyAxes.has(axis))
      fail("DUPLICATE", "Multiple rollups on one axis");
    hierarchyAxes.add(axis);
    requiredAxes.add(axis);
  }
  for (const dim of query.topN?.partitionBy ?? []) {
    if (!query.dimensions.includes(dim))
      fail("INCOMPATIBLE", "Ranking partition must be retained");
  }

  for (const order of query.orderBy ?? []) {
    const selected =
      order.kind === "dimension"
        ? query.dimensions.includes(order.dimensionId)
        : query.measures.includes(order.measureId);
    if (!selected)
      fail("INCOMPATIBLE", "Ordering field must be selected in the output");
  }

  const roots = new Set(query.measures);
  if (query.measureFilter) predicateRefs(query.measureFilter, roots);
  if (query.topN) roots.add(query.topN.measureId);
  const { order: calculations, baseRefs: refs } = planCalculatedMeasures(
    query.calculatedMeasures ?? [],
    [...roots],
  );
  const calculatedIds = new Set(calculations.map((d) => d.id));
  if (!refs.size) fail("UNRESOLVED", "Query needs at least one source measure");
  if (query.joinAnchor && !refs.has(query.joinAnchor))
    fail("INVALID", "Join anchor must be a required source measure");

  const selected = new Map<
    string,
    { source: QuerySource; measureIds: Set<string> }
  >();
  const providers = new Map<string, string>();
  for (const ref of sorted([...refs])) {
    const candidates = sources.flatMap((source) => {
      if ([...requiredAxes].some((axis) => !source.dimensions.includes(axis)))
        return [];
      const reduces =
        hierarchyAxes.size > 0 || !same(source.dimensions, query.dimensions);
      return source.measures
        .filter((m) => {
          const output =
            reduces && m.aggregation === "count" ? m.id + ":count" : m.id;
          return output === ref;
        })
        .map((m) => ({ source, measureId: m.id }));
    });
    if (candidates.length !== 1) {
      // A measure that exists but cannot be used at the requested grain is not missing data.
      const known = sources.some((s) =>
        s.measures.some((m) => m.id === ref || m.id + ":count" === ref),
      );
      fail(
        candidates.length ? "CONFLICT" : known ? "INCOMPATIBLE" : "UNRESOLVED",
        "Measure not uniquely resolved: " + ref,
      );
    }
    const { source, measureId } = candidates[0];
    const key = source.snapshot.datasetId;
    if (!selected.has(key))
      selected.set(key, { source, measureIds: new Set() });
    selected.get(key)!.measureIds.add(measureId);
    providers.set(ref, key);
  }
  assertBound(selected.size, UDC_LIMITS.cubes, "query sources");
  let planSources: QueryPlanSource[] = [...selected.values()]
    .map((s) => ({ source: s.source, measureIds: sorted([...s.measureIds]) }))
    .sort((a, b) =>
      a.source.snapshot.datasetId < b.source.snapshot.datasetId
        ? -1
        : a.source.snapshot.datasetId > b.source.snapshot.datasetId
          ? 1
          : 0,
    );
  const grain = planSources[0].source.dimensions;
  if (planSources.some((s) => !same(s.source.dimensions, grain)))
    fail("INCOMPATIBLE", "Sources must share identical canonical grain");
  const aggregate = !same(grain, query.dimensions);
  const rollup = hierarchyAxes.size > 0;
  const join = query.join ?? "inner";
  if (join !== "inner" && (planSources.length < 2 || aggregate || rollup))
    fail(
      "INCOMPATIBLE",
      "Outer joins require at least two sources and unchanged grain (no rollups)",
    );
  if (query.joinAnchor) {
    const anchor = providers.get(query.joinAnchor);
    const preserved = planSources.find(
      (s) => s.source.snapshot.datasetId === anchor,
    )!;
    const others = planSources.filter((s) => s !== preserved);
    planSources =
      join === "left" ? [preserved, ...others] : [...others, preserved];
  }
  const rawIds = planSources.flatMap((s) => s.measureIds);
  assertBound(rawIds.length, UDC_LIMITS.columns, "selected source measures");
  if (new Set(rawIds).size !== rawIds.length)
    fail("CONFLICT", "Duplicate source measure");
  if (rawIds.some((id) => calculatedIds.has(id)))
    fail("CONFLICT", "Calculated measure identity collision");
  const outputIds = planSources.flatMap((s) =>
    s.source.measures
      .filter((m) => s.measureIds.includes(m.id))
      .map((m) =>
        (aggregate || rollup) && m.aggregation === "count"
          ? m.id + ":count"
          : m.id,
      ),
  );
  if (
    new Set(outputIds).size !== outputIds.length ||
    outputIds.some((id) => calculatedIds.has(id))
  )
    fail("CONFLICT", "Derived measure identity collision");
  assertBound(
    outputIds.length + calculations.length,
    UDC_LIMITS.columns,
    "intermediate measures",
  );
  const steps: QueryStep[] = [];
  if (query.filters?.length) steps.push("filter-dimensions");
  if (planSources.length > 1) steps.push("integrate");
  if (rollup) steps.push("rollup");
  if (aggregate) steps.push("aggregate");
  if (calculations.length) steps.push("calculate");
  if (query.measureFilter) steps.push("filter-measures");
  if (query.topN) steps.push("top-n");
  if (query.orderBy?.length) steps.push("order");
  if (query.limit !== undefined) steps.push("limit");
  steps.push("project");
  // Detach from mutable caller objects; plans contain no executable functions.
  return JSON.parse(
    JSON.stringify({ version: 1, query, sources: planSources, steps }),
  ) as QueryPlan;
}
