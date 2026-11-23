# Data model and semantics

UDC treats **dimensions** as identifying axes (e.g., Country, Year), **measures** as typed quantitative properties (e.g., Population in persons), and **observations** as measure values at an order-independent coordinate.

## Declared measure aggregation

Each measure declares a mandatory canonical `unit` and `aggregation`: `sum`, `count`, `average`, or `none`. `none` prohibits roll-up instead of silently choosing an operation. `count` means counting non-null observations (not summing a count-valued measure). The unit of a derived count is observations, unlike the input physical unit. `sum` and `average` work on values in the declared unit. This release records policy only: integration and slicing do not implicitly aggregate. Change the schema revision when these definitions change.

## Source versus canonical cubes

A `SourceCube` stores `CodedMemberRef` values containing a dimension ID, code-list ID and revision, and literal source code. A `CanonicalCube` stores stable `Member` identities. A code such as UN M49 `156` and ISO alpha-3 `CHN` cannot be joined merely because they look compatible. Reviewed exact mappings can resolve both to one canonical `country:china` identity.

Coordinates use a stable, version-prefixed `udc-cell-v1:` key. They do not depend on process-local incrementing IDs or input member ordering.

## Directed member hierarchies

`createHierarchy` constructs a pure, in-memory graph from explicit canonical
member edges. The graph is a single-parent, acyclic forest for one named
hierarchy within a dimension. Thus `space`, `time`, and `industry` use the
same semantics, and alternate administrative/statistical hierarchies remain
separate by hierarchy key and revision. No canonical members are stored by UDC
or inferred from unreviewed source labels.

Each edge carries the source dataset snapshot, one-based source row, approved
mapping revision, and optional versioned source codes for both endpoints.
Duplicate edges are collapsed without discarding distinct provenance;
conflicting parents and cycles are rejected. A root or unknown member has no
parent; ancestors are traversed nearest-parent first.

Classification `edition`, the graph `revision`, and individual mapping
revisions are independent provenance concepts. The host must supply resolved,
stable canonical identities for every endpoint and authorize source access
before calling UDC. The hierarchy API only constructs and traverses a graph:
it does not join datasets, load a table, aggregate cube measures or infer a
transitive concordance.

## Reproducibility and provenance

Each `MeasureValue` retains a `MeasureProvenance` record: source `DatasetSnapshot`, original row index, source-coded coordinate, schema revision, measure ID, unit, and (after canonicalization) concordance and mapping revisions.

For standalone callers, the required `DatasetSnapshot` field is `datasetId`. `revision` and `sourceId` are optional generic identifiers. `vizId`, `commitId`, and `sourceKey` are optional fields for existing VizHub integration. These are identities and provenance, **not authorization grants**. IDs use bounded safe identifier syntax, not arbitrary URLs.

## Concordance policy

Only exact, verified edges form equivalence classes. A class requires one unambiguous canonical assignment. Unverified, close, related, broader and narrower mappings are deliberately excluded. Effective-dated mappings require an explicit query date. Contradictions yield conflict or unresolved results.

## Explicit aggregation

`aggregateCube(cube, retainDimensionIds)` is an explicit roll-up over canonical coordinates. It does not infer dimension hierarchies or silently run during integration/slicing. A measure's required `aggregation` declaration controls reduction: `sum`, `average`, `count`, or `none`. `none` rejects groups containing multiple observations. Nulls are excluded from arithmetic; empty sums and averages yield null, whereas count yields zero. Zero is never treated as missing.

The result is an `AggregatedCube`, distinct from a `CanonicalCube`; its values retain all contributing original source-row provenance and sufficient `sum`/`count` state for a later roll-up. Averages of unequal-sized groups are recomputed using that state, not averaged as unweighted means. A `count` operation creates a derived `:count` measure in `observations` units whose later roll-ups use `sum`. All resulting measure metadata and coordinates are deterministic. Runtime row and output limits still apply.

No hierarchy lookup, source-unit conversion, weighted rate calculation, implicit roll-up, or SQL is performed by this operation.

## Integration and slicing

`integrateCubes` defaults to an **inner join** between canonical cubes with the same dimension set and granularity; it also accepts `left`, `right`, and `full` join modes. It refuses duplicate measure IDs, collisions, or incompatible grain. Only the inner join returns a fully populated `CanonicalCube`.

Non-inner joins return a distinct `SparseIntegratedCube` stage. A joined coordinate carries `presence.left` and `presence.right` flags, and its `values` object omits all keys belonging to an absent side. This differs from an observed coordinate with a present `MeasureValue` whose `value` is `null`. Never synthesize missing-value provenance. Source snapshots, schema/concordance revisions, and present measure provenance remain intact.

`sliceCube` selects observations at one canonical member and removes the selected axis, preserving measure lineage and sparse presence. Neither operation implicitly aggregates, fills missing values, projects across unequal axes, nor equates approximate mappings with exact equivalence. Sparse results are deliberately ineligible for `aggregateCube` until reduction semantics are explicitly defined.

## Coordinate presence and dataset coverage

Coverage asks _whether a dataset has a canonical observation at a coordinate_, not how numeric values should be combined. `projectDatasetCoverage` projects a single dataset's canonical coordinates onto requested dimensions and collapses repeated projected keys. A dataset at Country × Year × Sex can therefore claim Country × Year coverage without summing a population count or averaging a percentage. An observed row whose measure is null still establishes coordinate presence. A dimension-only dataset uses `CanonicalCoordinateDataset` with approved, canonical members and requires no artificial measure.

`countDatasetCoverage` combines projected per-dataset results, counting unique `datasetId` contributors at each observed coordinate and returning those IDs alongside the counts. Repeated rows, measures, or use records never inflate the total; snapshots and semantic revisions remain traceable. Each input must support _all_ requested output dimensions. Country-only data cannot claim every year. The result includes only observed coordinates, not a complete Cartesian grid of possible countries and years.

These primitives consume explicitly canonicalized coordinates; they do not approve geographic equivalences, infer axes, fetch datasets, or perform authorization. The VizHub backend must select and authorize each source _before_ passing it to this package.

See [the full API reference](api.md) and [documented limits](limitations.md).
