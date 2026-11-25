import type {
  CanonicalCube,
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
export type QueryInputs = {
  cubes: readonly CanonicalCube[];
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
    presence?: { left: boolean; right: boolean };
  }[];
  snapshots: AnalyticalCube["snapshots"];
  schemaRevisions: AnalyticalCube["schemaRevisions"];
  concordanceRevisions: AnalyticalCube["concordanceRevisions"];
  hierarchyRollups?: import("./types").AggregatedCube["hierarchyRollups"];
  join?: JoinMode;
  definition?: CalculatedMeasureDefinition;
}

// Keep the public expression contract identical to the existing operator.
export type QueryExpression = MeasureExpression;
