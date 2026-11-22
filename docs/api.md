# Public API

All documented functions and types are exported from `@vizhub/udc` and `src/index.ts`. The source contains zero server/framework imports and no CSV/TSV parser. `createCube` accepts already-parsed records.

| Export                    | Signature / behavior                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `createCube`              | `(rows, semanticSchema, datasetSnapshot) => SourceCube`                                                                             |
| `validateSemanticSchema`  | `(schema: SemanticSchema, columns?: readonly string[]) => void`; validates IDs, field coverage, aggregation declarations and limits |
| `getCellKey`              | `(coordinate) => CellKey` with stable `udc-cell-v1:` prefix                                                                         |
| `codedRef`                | Create `CodedMemberRef` for dimension/codelist/revision/code                                                                        |
| `canonicalMember`         | Create canonical `Member` for dimension/member ID                                                                                   |
| `memberIdentity`          | `(member: MemberRef) => string`; canonical identity string used inside cell keys                                                    |
| `resolveConcordance`      | `(mappings, {revision, at?}) => Concordance`                                                                                        |
| `canonicalizeCube`        | `(source, concordance) => CanonicalCube`                                                                                            |
| `integrateCubes`          | `(a, b, {join:"inner"}) => CanonicalCube`; `left`/`right`/`full` return `SparseIntegratedCube`                                      |
| `aggregateCube`           | `(canonicalOrAggregatedCube, retainDimensionIds) => AggregatedCube`; explicitly reduce coordinates using declared measure policies  |
| `sliceCube`               | `(cube, member) => CanonicalCube or SparseIntegratedCube` (same stage as input)                                                     |
| `projectDatasetCoverage`  | `(singleCanonicalCubeOrCoordinateDataset, dimensionIds) => ProjectedDatasetCoverage` (one dataset)                                  |
| `countDatasetCoverage`    | `(projectedDatasets, outputDimensions) => DatasetCoverageSummary` (distinct dataset IDs at every observed coordinate)              |
| `UDC_LIMITS`              | Exported resource ceilings; see [limits](limitations.md)                                                                            |
| `UdcError`                | Typed exception with `code: UdcErrorCode`                                                                                           |
| `assertId`, `assertBound` | Low-level validators that throw `UdcError` on invalid identifiers or exhausted budgets                                              |

Exported types include `CanonicalCoordinateDataset`, `DatasetCoverageCoordinate`, `ProjectedDatasetCoverage`, `DatasetCoverageObservation`, `DatasetCoverageSummary`, `JoinMode`, `OuterJoinMode`, `SparseIntegratedObservation`, `SparseIntegratedCube`, `DatasetSnapshot`, `Dimension`, `Codelist`, `CodedMemberRef`, `Member`, `MemberRef`, `Coordinate`, `CellKey`, `DimensionFieldMapping`, `AggregationOperator`, `MeasureDefinition`, `MeasureFieldMapping`, `SemanticSchema`, `MeasureProvenance`, `MeasureValue`, `Observation`, `CubeBase`, `SourceCube`, `CanonicalCube`, `AggregateAccumulator`, `AggregatedMeasureValue`, `AggregatedObservation`, `AggregatedCube`, `Relationship`, `CodeMapping`, `Resolution`, `Concordance`, `ConcordanceContext`, `IntegrationOptions`, `UdcErrorCode`.

`SemanticSchema` maps input columns to explicit `DimensionFieldMapping` and `MeasureFieldMapping` definitions. `MeasureDefinition` carries an ID, name, mandatory canonical unit and mandatory `aggregation: "sum" | "count" | "average" | "none"` declaration; each field mapping carries a scale. UDC does not infer column semantics.

The `Resolution` result of a concordance has distinct `resolved`, `unresolved` and `conflict` statuses. Do not treat failure as an inferred match.

**Join result contract:** Omitted `join` and explicit `inner` still return a dense `CanonicalCube`. Other modes produce `SparseIntegratedCube` with `stage: "sparse-integrated"`, `join`, and per-coordinate `presence: {left, right}`. The `values` record omits all measures from an absent side. Use `Object.hasOwn(observation.values, measureId)` to distinguish absence from a present `MeasureValue` whose `value` is `null`. Only present measures carry source-row provenance; source snapshot/revision metadata is retained on the result. `sliceCube` preserves both sparse flags and omission. `aggregateCube` intentionally rejects sparse input until missingness and reduction policy are explicitly specified.

**Coverage contract:** `projectDatasetCoverage` accepts one `CanonicalCube` with exactly one source snapshot, or a `CanonicalCoordinateDataset` with canonical coordinates and no required measures. Its `retainDimensionIds` must be an explicitly selected subset of input axes. It returns distinct projected coordinates with `sourceCoordinateCount`, the selected dimension metadata, source snapshot identity, and source schema/concordance revisions. Empty dimensions are allowed: a nonempty dataset then contributes one global coordinate. Null-valued measures still count as *coordinate presence*, not a non-null-value claim.

`countDatasetCoverage` accepts only projected datasets sharing the *same* dimension IDs, and produces sorted `{ cellKey, coordinate, datasetCount, datasetIds }` observations plus the source snapshot list. Repeated visualization uses of the same dataset ID count once. Conflicting source or semantic revisions for the same dataset ID fail rather than silently combine. Dataset-only Country inputs cannot be promoted to Country × Year; no missing-axis fanout or Cartesian product is inferred. Limits include per-dataset 10,000 input coordinates, 1,000 projected inputs per summary, 100,000 contributions and 20,000 resulting coordinates. Overflow fails with `UdcError("LIMIT")`, never truncates.

**Compatibility:** The 2014 functions `getMember`, `getCell`, `createThesaurus`, `mergeCubes`, `Hierarchy`, and `mergeHierarchies` are **not** provided as drop-in aliases. See [migration notes](migration-from-2014.md). Public stable semantic contracts should be versioned before introducing additional joins, aggregation, loader APIs or manifest formats.
