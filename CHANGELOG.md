# Change log

## 3.1.0 — 2026-11-26

Version recorded in the package manifest and lockfile. Registry publication is
not tracked by this changelog.

### Six-dataset development acceptance

- Exercise five country-grain sources and a separate fictional US state-grain dataset, including real historical population, GDP and rounded CO2 observations.
- Check independent numerical references, transitive provenance, hierarchy drill-down and reconciliation, extrema overrides, missingness and filter/project provider parity.
- Document fixture attribution and limitations; the fixtures are development evidence, not live registry data. No production dependencies.

### Explicit aggregation overrides and extrema

- Add query-local base-measure aggregation overrides and min/max default policies.
- Merge extrema across rollups with null handling and provenance; preserve existing accumulator shapes.
- Negotiate extrema pushdown explicitly; keep overrides local while retaining safe filter/project pushdown.
- Extend validation, docs and regression tests without production dependencies.

### Composable calculated measures

- Resolve multiple structured calculated measures, including hidden intermediates, forward references and acyclic dependencies.
- Evaluate in deterministic dependency order after aggregation, with transitive source-row provenance and explicit sparse/null semantics.
- Preserve single-calculation APIs and metadata; expose ordered definitions for multi-calculation results.
- Bound total expression complexity, intermediate columns, evaluation work and contributor expansion; add graph, randomized reference, OLAP and provider parity regression tests. No production dependencies.

### N-way semantic integration

- Resolve multiple revision-pinned sources and integrate at identical canonical grain with inner, full and anchored directional joins.
- Add `integrateManyCubes` and per-source sparse presence while preserving binary results and provenance.
- Bound cumulative input rows and measure values, selected measures and output observations; retain source-local pushdown and prevent premature aggregation.
- Add seeded reference-join, five-source OLAP, provider-parity, revision and resource-bound regression tests. No production dependencies.

## 3.0.0 — asynchronous data providers

The following sections record capabilities present in the 3.0.0 source baseline;
they do not assert the first npm version in which each capability appeared.

- Breaking: `executeQuery` returns `Promise<QueryResult>` and accepts `{ provider, hierarchies? }` instead of `{ cubes, hierarchies? }`.
- Add `DataProvider`, `QuerySourceRequest`, and `createInMemoryProvider`. Metadata-only planning and pure OLAP operations remain synchronous; there is no legacy synchronous executor.
- Verify the exact plan before acquisition and recheck the returned source metadata before applying existing operators. Preserve revision pins, row limits and lineage.
- Add optional source capability negotiation, dimension filter and measure projection pushdown, and guarded single-source aggregation with validated metadata and lineage. No SQL, driver or authentication implementation.

### Declarative JSON queries

- Add a versioned semantic QuerySpec, bounded JSON validation, deterministic source planning, and execution through existing OLAP operators.
- Preserve lineage, revision pins and explicit sparse join semantics; reject ambiguous providers and incompatible grains.
- Add golden workflows, regression tests, and a query language reference. No application integration.

### Advanced OLAP queries

- Add provenance-preserving drill-down from explicitly supplied finer-grained data and deterministic hierarchy children/descendants navigation.
- Add bounded measure predicates with three-valued numeric logic and separate null and absence checks.
- Add partitioned ranking metadata (ordinal, competition, dense) and top/bottom-N with deterministic cutoff ties.
- Allow dice, filtering and ranking on calculated results while retaining the aggregation barrier.
- Include extensive regression, seeded permutation, resource-limit and end-to-end GDP-per-capita tests.
- No production dependencies or application integration.

### Coordinate projection and dataset coverage

- Add `projectDatasetCoverage` to deduplicate the projection of a single canonical dataset's observed coordinates, independently of measures or aggregation policies.
- Support measure-less `CanonicalCoordinateDataset` sources and retain dataset snapshots and semantic revision pins.
- Add `countDatasetCoverage` for deterministic distinct-dataset counts and contributing dataset IDs across different input grains sharing the selected output axes.
- Reject incompatible, uncanonicalized, duplicate, over-budget or revision-conflicting inputs without silently truncating or inventing coordinate coverage.
- No changes to existing joins or HTTP/MCP query endpoints.

### Explicit sparse outer joins

- Add left, right, and full joins to `integrateCubes`, retaining the default dense inner-join return contract.
- Introduce distinct `SparseIntegratedCube` and `SparseIntegratedObservation` results with left/right coordinate-presence flags and absent measure keys, preserving observed nulls and source-row provenance.
- Allow `sliceCube` to retain sparse join semantics; no outer-join aggregation, cross-grain joining, or coverage query is introduced.

### Breaking removal of CSV/TSV parser

- Remove `parseTabular`, `TabularRows`, and the parser-only `UDC_LIMITS.fileBytes` from the public API. Callers now pass pre-parsed records to `createCube`.
- Move `d3-dsv` to development-only use in tests and the example; UDC has zero production dependencies.
- **Migration note:** Removing public exports is a breaking change; callers must provide pre-parsed records.

## 1.2.0 — historical source milestone (breaking aggregation metadata)

- Declare `aggregation` mandatory on every measure; existing `1.0.0` consumers need explicit migrations.
- Add explicit, provenance-preserving `aggregateCube` with composable averages and derived counts.
- Add `AggregatedCube` as a distinct result stage with original per-value lineage and sufficient statistics.
- Require a measure aggregation policy: `sum`, `count`, `average`, or `none`; reject undeclared or unsupported operators without silently aggregating.
- Keep canonical measure `unit` mandatory; changing schemas is required for consumers.
- Build `dist/` during `prepublishOnly` so the published tarball always matches the verified source.
- Update package release metadata and add a reproducible manual/tag release workflow.

## 1.1.0 — Published

- Published package metadata update. The published artifact did not include the aggregation-aware API; later source baselines include these features.

## 1.0.0 — Published

- First standalone npm release of the modern TypeScript ESM core.

## 0.1.0 — Unreleased

- Modern TypeScript ESM reimplementation of Universal Data Cube extracted from VizHub AI Studio.
- Typed SourceCube/CanonicalCube, versioned concordance, deterministic cell keys, strict inner join, slicing, and measure provenance.
- Record-aware CSV and TSV parsing using d3-dsv with bounded inputs.
- Ported golden UN population and World Bank GDP tests and integration edge suites.
- Provider-neutral dataset snapshot support and standalone package tooling.
- This is **not** backward source-compatible with the 2014 AMD implementation.
