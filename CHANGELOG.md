# Change log

## Unreleased — N-way semantic integration

- Resolve multiple revision-pinned sources and integrate at identical canonical grain with inner, full and anchored directional joins.
- Add `integrateManyCubes` and per-source sparse presence while preserving binary results and provenance.
- Bound cumulative input rows and measure values, selected measures and output observations; retain source-local pushdown and prevent premature aggregation.
- Add seeded reference-join, five-source OLAP, provider-parity, revision and resource-bound regression tests. No production dependencies or publication.

## 3.0.0 — asynchronous data providers (unreleased)

- Breaking: `executeQuery` returns `Promise<QueryResult>` and accepts `{ provider, hierarchies? }` instead of `{ cubes, hierarchies? }`.
- Add `DataProvider`, `QuerySourceRequest`, and `createInMemoryProvider`. Metadata-only planning and pure OLAP operations remain synchronous; there is no legacy synchronous executor.
- Verify the exact plan before acquisition and recheck the returned source metadata before applying existing operators. Preserve revision pins, row limits and lineage.
- Add optional source capability negotiation, dimension filter and measure projection pushdown, and guarded single-source aggregation with validated metadata and lineage. No SQL, driver, authentication or npm publication in this PR.

## Unreleased — declarative JSON queries

- Add a versioned semantic QuerySpec, bounded JSON validation, deterministic source planning, and execution through existing OLAP operators.
- Preserve lineage, revision pins and explicit sparse join semantics; reject ambiguous providers and incompatible grains.
- Add golden workflows, regression tests, and a query language reference. No publication or application integration.

## Unreleased — advanced OLAP queries

- Add provenance-preserving drill-down from explicitly supplied finer-grained data and deterministic hierarchy children/descendants navigation.
- Add bounded measure predicates with three-valued numeric logic and separate null and absence checks.
- Add partitioned ranking metadata (ordinal, competition, dense) and top/bottom-N with deterministic cutoff ties.
- Allow dice, filtering and ranking on calculated results while retaining the aggregation barrier.
- Include extensive regression, seeded permutation, resource-limit and end-to-end GDP-per-capita tests.
- No production dependencies, application integration or package publication.

## Unreleased — coordinate projection and dataset coverage

- Add `projectDatasetCoverage` to deduplicate the projection of a single canonical dataset's observed coordinates, independently of measures or aggregation policies.
- Support measure-less `CanonicalCoordinateDataset` sources and retain dataset snapshots and semantic revision pins.
- Add `countDatasetCoverage` for deterministic distinct-dataset counts and contributing dataset IDs across different input grains sharing the selected output axes.
- Reject incompatible, uncanonicalized, duplicate, over-budget or revision-conflicting inputs without silently truncating or inventing coordinate coverage.
- This work does not publish an npm release, alter any existing joins, or add an HTTP/MCP query endpoint.

## Unreleased — explicit sparse outer joins

- Add left, right, and full joins to `integrateCubes`, retaining the default dense inner-join return contract.
- Introduce distinct `SparseIntegratedCube` and `SparseIntegratedObservation` results with left/right coordinate-presence flags and absent measure keys, preserving observed nulls and source-row provenance.
- Allow `sliceCube` to retain sparse join semantics; no outer-join aggregation, cross-grain joining, or coverage query is introduced.
- This is unreleased source work; do not claim that the published `@vizhub/udc@2.0.0` includes outer joins.

## Unreleased — breaking removal of CSV/TSV parser

- Remove `parseTabular`, `TabularRows`, and the parser-only `UDC_LIMITS.fileBytes` from the public API. Callers now pass pre-parsed records to `createCube`.
- Move `d3-dsv` to development-only use in tests and the example; UDC has zero production dependencies.
- **Release note:** Removing public exports is a breaking change and requires a new major version on publication.

## 1.2.0 — Unreleased (breaking aggregation metadata)

- Declare `aggregation` mandatory on every measure; existing `1.0.0` consumers need explicit migrations.
- Add explicit, provenance-preserving `aggregateCube` with composable averages and derived counts.
- Add `AggregatedCube` as a distinct result stage with original per-value lineage and sufficient statistics.
- Require a measure aggregation policy: `sum`, `count`, `average`, or `none`; reject undeclared or unsupported operators without silently aggregating.
- Keep canonical measure `unit` mandatory; changing schemas is required for consumers.
- Build `dist/` during `prepublishOnly` so the published tarball always matches the verified source.
- Update package release metadata and add a reproducible manual/tag release workflow.

## 1.1.0 — Published

- Published package metadata update. The published artifact did not include the aggregation-aware API; use `1.2.0` for those features.

## 1.0.0 — Published

- First standalone npm release of the modern TypeScript ESM core.

## 0.1.0 — Unreleased

- Modern TypeScript ESM reimplementation of Universal Data Cube extracted from VizHub AI Studio.
- Typed SourceCube/CanonicalCube, versioned concordance, deterministic cell keys, strict inner join, slicing, and measure provenance.
- Record-aware CSV and TSV parsing using d3-dsv with bounded inputs.
- Ported golden UN population and World Bank GDP tests and integration edge suites.
- Provider-neutral dataset snapshot support and standalone package tooling.
- This is **not** backward source-compatible with the 2014 AMD implementation.
