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
| `createHierarchy`         | `(definition: HierarchyDefinition) => Hierarchy`; deterministic, validated canonical parent/ancestor traversal without IO            |
| `sliceCube`               | `(cube, member) => CanonicalCube                                                                                                    | SparseIntegratedCube` (same stage as input) |
| `UDC_LIMITS`              | Exported resource ceilings; see [limits](limitations.md)                                                                            |
| `UdcError`                | Typed exception with `code: UdcErrorCode`                                                                                           |
| `assertId`, `assertBound` | Low-level validators that throw `UdcError` on invalid identifiers or exhausted budgets                                              |

Exported types include `JoinMode`, `OuterJoinMode`, `SparseIntegratedObservation`, `SparseIntegratedCube`, `DatasetSnapshot`, `Dimension`, `Codelist`, `CodedMemberRef`, `Member`, `MemberRef`, `Coordinate`, `CellKey`, `DimensionFieldMapping`, `AggregationOperator`, `MeasureDefinition`, `MeasureFieldMapping`, `SemanticSchema`, `MeasureProvenance`, `MeasureValue`, `Observation`, `CubeBase`, `SourceCube`, `CanonicalCube`, `AggregateAccumulator`, `AggregatedMeasureValue`, `AggregatedObservation`, `AggregatedCube`, `Relationship`, `CodeMapping`, `Resolution`, `Concordance`, `ConcordanceContext`, `IntegrationOptions`, `UdcErrorCode`, `HierarchyDefinition`, `HierarchyEdgeInput`, `HierarchyEdge`, `HierarchyProvenance`, and `Hierarchy`.

`SemanticSchema` maps input columns to explicit `DimensionFieldMapping` and `MeasureFieldMapping` definitions. `MeasureDefinition` carries an ID, name, mandatory canonical unit and mandatory `aggregation: "sum" | "count" | "average" | "none"` declaration; each field mapping carries a scale. UDC does not infer column semantics.

The `Resolution` result of a concordance has distinct `resolved`, `unresolved` and `conflict` statuses. Do not treat failure as an inferred match.

**Join result contract:** Omitted `join` and explicit `inner` still return a dense `CanonicalCube`. Other modes produce `SparseIntegratedCube` with `stage: "sparse-integrated"`, `join`, and per-coordinate `presence: {left, right}`. The `values` record omits all measures from an absent side. Use `Object.hasOwn(observation.values, measureId)` to distinguish absence from a present `MeasureValue` whose `value` is `null`. Only present measures carry source-row provenance; source snapshot/revision metadata is retained on the result. `sliceCube` preserves both sparse flags and omission. `aggregateCube` intentionally rejects sparse input until missingness and reduction policy are explicitly specified.

**Hierarchy contract:** The input specifies a `key`, `dimensionId`,
`revision`, optional classification `edition`, and row-level directed
`edges`. Each edge has canonical `child`/`parent` values and required
`provenance: { snapshot, sourceRow, mappingRevision }`; optionally include
both versioned `childSource` and `parentSource` coded references. The output
exposes deterministic, deduplicated `edges` with all distinct evidence,
`parent(memberOrId)` and `ancestors(memberOrId)`. Ancestors are nearest-first
and exclude the member itself. One child may have only one parent in a given
hierarchy revision, but multiple independent hierarchies may be constructed.
Cycles, self-parenting and cross-dimension edges throw `UdcError`.
Unrecognized members have no parent and no ancestors. Source row indices are
one-based. Input edge counts are bounded by `UDC_LIMITS.rows`.
The caller is responsible for resolving and approving canonical identities and
pinning revisions; this is not a row-to-member resolver, provenance authority,
hierarchy editor, or cube aggregation operation.

**Compatibility:** The 2014 functions `getMember`, `getCell`, `createThesaurus`, `mergeCubes`, `Hierarchy`, and `mergeHierarchies` are **not** provided as drop-in aliases. See [migration notes](migration-from-2014.md). Public stable semantic contracts should be versioned before introducing additional joins, aggregation, loader APIs or manifest formats.
