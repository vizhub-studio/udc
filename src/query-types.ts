import type {
  CanonicalCube,
  AggregatedCube,
  DatasetSnapshot,
  Dimension,
  MeasureDefinition,
} from "./types";
import type { Hierarchy } from "./hierarchy";
import type { JoinMode } from "./integrate-cubes";
import type {
  CalculatedMeasureDefinition,
  DiceSelection,
  MeasureExpression,
} from "./olap";
import type {
  AnalyticalCube,
  MeasurePredicate,
  TopNOptions,
} from "./advanced-olap";

export interface QueryRollup {
  hierarchyKey: string;
  revision: string;
  targetMembers: readonly string[];
}

/** Ordered output field; earlier entries take precedence. */
export type QueryOrder =
  | { kind: "dimension"; dimensionId: string; direction: "asc" | "desc" }
  | { kind: "measure"; measureId: string; direction: "asc" | "desc" };

/** A JSON-only semantic request. No physical source names or executable code. */
export interface QuerySpec {
  version: 1;
  dimensions: readonly string[];
  measures: readonly string[];
  filters?: readonly DiceSelection[];
  rollups?: readonly QueryRollup[];
  calculatedMeasures?: readonly CalculatedMeasureDefinition[];
  measureFilter?: MeasurePredicate;
  join?: JoinMode;
  /** Required for left/right joins: identifies the preserved source semantically. */
  joinAnchor?: string;
  topN?: TopNOptions;
  orderBy?: readonly QueryOrder[];
  limit?: number;
}

/** Metadata for one immutable, canonical source; no rows or loader. */
export interface QuerySource {
  snapshot: DatasetSnapshot & { revision: string };
  dimensions: readonly string[];
  measures: readonly MeasureDefinition[];
  schemaRevisions: readonly string[];
  concordanceRevisions: readonly string[];
}
export interface QueryCatalog {
  sources: readonly QuerySource[];
  hierarchies?: readonly Hierarchy[];
}
export interface QueryPlanSource {
  source: QuerySource;
  measureIds: readonly string[];
}
export type QueryStep =
  | "filter-dimensions"
  | "integrate"
  | "rollup"
  | "aggregate"
  | "calculate"
  | "filter-measures"
  | "top-n"
  | "order"
  | "limit"
  | "project";
export interface QueryPlan {
  version: 1;
  query: QuerySpec;
  sources: readonly QueryPlanSource[];
  steps: readonly QueryStep[];
}
/** Full-snapshot acquisition request; selections are informational hints. */
export interface QuerySourceRequest extends QueryPlanSource {
  filters: readonly DiceSelection[];
}

/**
 * Host-owned, revision-pinned data acquisition. Supply exactly the sources
 * selected by the plan. A load must return the complete canonical cube at its
 * original grain, with every declared measure and provenance; no truncation,
 * filtering, projection or aggregation is permitted in loadSource.
 */
export interface DataProvider {
  readonly sources: readonly QuerySource[];
  loadSource(request: QuerySourceRequest): Promise<CanonicalCube>;
  /** Optional, per-source optimization. The full loader remains the fallback. */
  pushdown?: SourcePushdownProvider;
}

/** Opt in only to operations with exactly equivalent canonical semantics. */
export interface SourcePushdownCapabilities {
  filter?: boolean;
  project?: boolean;
  aggregate?: boolean;
}

/** Exact source operation contract; no physical names or backend syntax. */
export interface SourcePushdownPlan {
  filters: readonly DiceSelection[];
  measureIds: readonly string[];
  /** Absent means original grain; [] means scalar aggregation. */
  aggregateDimensions?: readonly string[];
}

export interface SourcePushdownRequest extends QuerySourceRequest {
  pushdown: SourcePushdownPlan;
}

export type SourcePushdownResult =
  | { kind: "unsupported" }
  | { kind: "subset"; cube: CanonicalCube }
  | { kind: "aggregate"; cube: AggregatedCube };

/**
 * Trusted host adapter. Results must be complete for the requested operation,
 * at the pinned revision, with original provenance and deterministic semantics.
 * Only an explicit unsupported result triggers full-snapshot fallback.
 */
export interface SourcePushdownProvider {
  capabilities(source: QuerySource): SourcePushdownCapabilities;
  load(request: SourcePushdownRequest): Promise<SourcePushdownResult>;
}

export type QueryInputs = {
  provider: DataProvider;
  hierarchies?: readonly Hierarchy[];
};
type QueryObservation = AnalyticalCube["observations"][number];
type QueryValue = QueryObservation["values"][string];

/** Terminal result, not a cube that may be implicitly re-aggregated. */
export interface QueryResult {
  stage: "query-result";
  inputStage: AnalyticalCube["stage"];
  dimensions: readonly Dimension[];
  measures: readonly MeasureDefinition[];
  observations: readonly {
    coordinate: QueryObservation["coordinate"];
    cellKey: string;
    values: Readonly<Partial<Record<string, QueryValue>>>;
    presence?: import("./types").JoinPresence;
  }[];
  snapshots: AnalyticalCube["snapshots"];
  schemaRevisions: AnalyticalCube["schemaRevisions"];
  concordanceRevisions: AnalyticalCube["concordanceRevisions"];
  hierarchyRollups?: import("./types").AggregatedCube["hierarchyRollups"];
  join?: JoinMode;
  /** Legacy single-calculation metadata. */
  definition?: CalculatedMeasureDefinition;
  /** Multiple calculations in deterministic dependency order. */
  definitions?: readonly CalculatedMeasureDefinition[];
}

// Keep the public expression contract identical to the existing operator.
export type QueryExpression = MeasureExpression;
