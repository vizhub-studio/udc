/** Pure, version-pinned semantic observation model. No IO or server imports. */
/** Dataset identity independent of any particular catalog or hosting platform. */
export interface DatasetSnapshot {
  datasetId: string;
  /** Optional immutable revision of the source. */
  revision?: string;
  /** Optional namespaced identity of the origin, not a fetch URL. */
  sourceId?: string;
  /** VizHub-provenance fields retained for existing integrations. */
  vizId?: string;
  commitId?: string;
  sourceKey?: string;
}
export interface Dimension {
  id: string;
  name: string;
}
export interface Codelist {
  id: string;
  revision: string;
}
export interface CodedMemberRef {
  kind: "coded";
  dimensionId: string;
  codelistId: string;
  codelistRevision: string;
  code: string;
}
export interface Member {
  kind: "canonical";
  dimensionId: string;
  id: string;
}
export type MemberRef = CodedMemberRef | Member;
export interface Coordinate<T extends MemberRef> {
  members: readonly T[];
}
export type CellKey = string;
export interface DimensionFieldMapping {
  field: string;
  dimension: Dimension;
  codelist: Codelist;
}
/** An explicit roll-up rule for non-null measure values. */
export type AggregationOperator = "sum" | "count" | "average" | "none";

export interface MeasureDefinition {
  id: string;
  name: string;
  /** Canonical unit at the declared observation grain. */
  unit: string;
  /** Required; none means roll-up is explicitly prohibited. */
  aggregation: AggregationOperator;
}
export interface MeasureFieldMapping {
  field: string;
  measure: MeasureDefinition;
  scale: number;
}
export interface SemanticSchema {
  id: string;
  revision: string;
  dimensions: readonly DimensionFieldMapping[];
  measures: readonly MeasureFieldMapping[];
}
export interface MeasureProvenance {
  snapshot: DatasetSnapshot;
  sourceRow: number; // 1-based data row; header excluded
  sourceCoordinate: Coordinate<CodedMemberRef>;
  schemaId: string;
  schemaRevision: string;
  measureId: string;
  unit: string;
  concordanceRevision?: string;
  mappingRevisions?: readonly string[];
}
export interface MeasureValue {
  value: number | null;
  provenance: MeasureProvenance;
}
export interface Observation<T extends MemberRef> {
  coordinate: Coordinate<T>;
  cellKey: CellKey;
  values: Readonly<Record<string, MeasureValue>>;
}
export interface CubeBase<T extends MemberRef> {
  dimensions: readonly Dimension[];
  measures: readonly MeasureDefinition[];
  observations: readonly Observation<T>[];
  snapshots: readonly DatasetSnapshot[];
  schemaRevisions: readonly string[];
  concordanceRevisions: readonly string[];
}
export interface SourceCube extends CubeBase<CodedMemberRef> {
  stage: "source";
}
export interface CanonicalCube extends CubeBase<Member> {
  stage: "canonical";
}

/**
 * A non-inner join deliberately has a distinct stage. Missing measure keys mean
 * that the source has no observation at this coordinate; a present MeasureValue
 * with value: null means the source observed the coordinate but reported null.
 * No synthetic value or provenance is created for an absent observation.
 */
export interface SparseIntegratedObservation {
  coordinate: Coordinate<Member>;
  cellKey: CellKey;
  values: Readonly<Partial<Record<string, MeasureValue>>>;
  presence: Readonly<{ left: boolean; right: boolean }>;
}

/** Outer-join outputs cannot masquerade as complete CanonicalCubes. */
export interface SparseIntegratedCube extends Omit<
  CubeBase<Member>,
  "observations"
> {
  stage: "sparse-integrated";
  join: "left" | "right" | "full";
  observations: readonly SparseIntegratedObservation[];
}
/**
 * A single dataset of already-canonical coordinates. Unlike SourceCube,
 * this may contain no measures and may repeat coordinates (e.g. source rows
 * that differ on an axis not retained by the coverage query).
 * Callers must use explicitly reviewed, exact canonical mappings.
 */
export interface CanonicalCoordinateDataset {
  stage: "coordinate-dataset";
  snapshot: DatasetSnapshot;
  dimensions: readonly Dimension[];
  coordinates: readonly Coordinate<Member>[];
  schemaRevisions?: readonly string[];
  concordanceRevisions?: readonly string[];
}

/** One unique projected coordinate from a single dataset. */
export interface DatasetCoverageCoordinate {
  coordinate: Coordinate<Member>;
  cellKey: CellKey;
  /** Number of source observations collapsing to this coordinate. */
  sourceCoordinateCount: number;
}

/** Coordinate presence is neither a measure nor a numeric aggregation. */
export interface ProjectedDatasetCoverage {
  stage: "dataset-coverage";
  snapshot: DatasetSnapshot;
  dimensions: readonly Dimension[];
  coordinates: readonly DatasetCoverageCoordinate[];
  schemaRevisions: readonly string[];
  concordanceRevisions: readonly string[];
}

/** A cell in the union of selected, authorized dataset coordinates. */
export interface DatasetCoverageObservation {
  coordinate: Coordinate<Member>;
  cellKey: CellKey;
  datasetCount: number;
  /** Sorted distinct dataset identities, never repeated source rows. */
  datasetIds: readonly string[];
}

/** Not a CanonicalCube; no numeric value or synthetic observation is created. */
export interface DatasetCoverageSummary {
  stage: "coverage-summary";
  dimensions: readonly Dimension[];
  observations: readonly DatasetCoverageObservation[];
  snapshots: readonly DatasetSnapshot[];
}

/** Reusable sufficient statistics for compositional roll-ups. */
export interface AggregateAccumulator {
  sum: number;
  count: number;
}
/** Versioned hierarchy evidence actually used by one roll-up. */
export interface HierarchyRollupEvidence {
  key: string;
  dimensionId: string;
  revision: string;
  edition?: string;
  edges: readonly import("./hierarchy").HierarchyEdge[];
}
/** Aggregated observations never masquerade as single-source observations. */
export interface AggregatedMeasureValue {
  value: number | null;
  state: AggregateAccumulator;
  contributors: readonly MeasureProvenance[];
}
export interface AggregatedObservation {
  coordinate: Coordinate<Member>;
  cellKey: CellKey;
  values: Readonly<Record<string, AggregatedMeasureValue>>;
}
export interface AggregatedCube {
  stage: "aggregated";
  hierarchyRollups?: readonly HierarchyRollupEvidence[];
  dimensions: readonly Dimension[];
  measures: readonly MeasureDefinition[];
  observations: readonly AggregatedObservation[];
  snapshots: readonly DatasetSnapshot[];
  schemaRevisions: readonly string[];
  concordanceRevisions: readonly string[];
}

export type Relationship =
  "exact" | "close" | "broader" | "narrower" | "related";
export interface CodeMapping {
  source: CodedMemberRef;
  target?: CodedMemberRef;
  canonical?: Member;
  relationship: Relationship;
  verified: boolean;
  revision: string;
  provenance: string;
  effectiveFrom?: string; // inclusive ISO date YYYY-MM-DD
  effectiveTo?: string;
}
export type Resolution =
  | { status: "resolved"; member: Member; mappingRevisions: readonly string[] }
  | { status: "unresolved"; reason: string }
  | { status: "conflict"; reason: string };
export interface Concordance {
  revision: string;
  resolve(ref: CodedMemberRef): Resolution;
}
