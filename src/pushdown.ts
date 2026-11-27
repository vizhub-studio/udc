import type {
  QueryPlan,
  QueryPlanSource,
  SourcePushdownCapabilities,
  SourcePushdownPlan,
} from "./query-types";

/** Plan only source-local operations that commute with residual execution. */
export function planSourcePushdown(
  plan: QueryPlan,
  selected: QueryPlanSource,
  capabilities: SourcePushdownCapabilities,
): SourcePushdownPlan | undefined {
  const allMeasures = selected.source.measures.map((m) => m.id);
  const filters =
    capabilities.filter === true ? (plan.query.filters ?? []) : [];
  const measureIds =
    capabilities.project === true ? selected.measureIds : allMeasures;
  const canAggregate =
    capabilities.aggregate === true &&
    !plan.query.aggregationOverrides?.length &&
    plan.sources.length === 1 &&
    plan.steps.includes("aggregate") &&
    !plan.steps.includes("rollup") &&
    !plan.steps.includes("drilldown") &&
    filters.length === (plan.query.filters ?? []).length &&
    measureIds.length === selected.measureIds.length &&
    selected.source.measures
      .filter((m) => measureIds.includes(m.id))
      .every(
        (m) =>
          m.aggregation !== "none" &&
          (
            capabilities.aggregateOperators ?? ["sum", "count", "average"]
          ).includes(m.aggregation),
      );
  if (
    !canAggregate &&
    !filters.length &&
    measureIds.length === allMeasures.length
  )
    return undefined;
  return {
    filters,
    measureIds,
    ...(canAggregate ? { aggregateDimensions: plan.query.dimensions } : {}),
  };
}
