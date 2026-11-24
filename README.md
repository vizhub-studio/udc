# Universal Data Cube (UDC)

A small, framework-independent TypeScript library for **semantic integration of tabular datasets**. UDC represents observations as measures at coordinates, reconciles coded dimension members through explicit, versioned concordances, and preserves per-measure source provenance.

This is the modern continuation of [Curran Kelleher's original 2014 Universal Data Cube project](https://github.com/curran/udc/tree/gh-pages). The previous AMD/RequireJS version, tests, and annotated documentation are preserved on the historical `gh-pages` branch. The new implementation imports the typed in-memory core and pure golden tests developed in VizHub AI Studio, with provider-neutral snapshot identifiers.

> **Release boundary:** Package versions published to npm are independent of this repository's unreleased source. This PR adds a coordinate coverage API that must be published in a later release before application consumers can install it. The package contains **no network loader, database, UI, backend API, or VizHub authentication logic**.

## Watch the presentation

[![Watch the Universal Data Cube (UDC) presentation on YouTube](https://img.youtube.com/vi/69E7t4gpCzk/hqdefault.jpg)](https://youtu.be/69E7t4gpCzk?is=WfK5nyU5v2Ml90Ev)

[**Watch the UDC presentation on YouTube**](https://youtu.be/69E7t4gpCzk?is=WfK5nyU5v2Ml90Ev)

## Start developing

Requires Node.js 22 or newer.

```bash
npm install
npm run check
npm run example
```

The example loads bundled sample CSVs for UN population, World Bank GDP, and country-code concordances and prints joined observations. No VizHub server or credentials are required.

After npm publication, application consumers can install `@vizhub/udc` and import its named functions.

## Quick start

UDC accepts structured rows, not raw CSV/TSV files. Parsing is the caller's responsibility; the published library has no production dependencies.

```ts
import { createCube } from "@vizhub/udc";

// The host application supplies already-parsed rows.
const rows = [{ country: "CHN", year: "1960", population: "650680114" }];

const cube = createCube(
  rows,
  {
    id: "population-schema",
    revision: "v1",
    dimensions: [
      {
        field: "country",
        dimension: { id: "country", name: "Country" },
        codelist: { id: "iso-alpha3", revision: "v1" },
      },
      {
        field: "year",
        dimension: { id: "year", name: "Year" },
        codelist: { id: "calendar-year", revision: "v1" },
      },
    ],
    measures: [
      {
        field: "population",
        measure: {
          id: "population",
          name: "Population",
          unit: "persons",
          aggregation: "sum",
        },
        scale: 1,
      },
    ],
  },
  { datasetId: "population-1960", revision: "v1" },
);
```

`createCube` produces a **SourceCube** with coded coordinates; `canonicalizeCube` yields a **CanonicalCube**; and `aggregateCube` yields a distinct **AggregatedCube** stage that cannot be mistaken for single-source data. To combine sources, build a concordance from explicitly verified exact mappings, call `canonicalizeCube` on both source cubes, then `integrateCubes`. See [the runnable population/GDP example](examples/population-gdp.mjs) for the complete workflow.

## Operations

| Function                                                      | Purpose                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `createCube(rows, schema, snapshot)`                          | Create a typed SourceCube with measure provenance                               |
| `codedRef`, `canonicalMember`, `memberIdentity`, `getCellKey` | Portable and order-invariant coordinate identities                              |
| `validateSemanticSchema(schema, columns?)`                    | Validate schema mappings, IDs, and field coverage                               |
| `resolveConcordance(mappings, context)`                       | Verified exact-equivalence closure with conflicts                               |
| `canonicalizeCube(source, concordance)`                       | Translate coded coordinates to canonical member identities                      |
| `integrateCubes(a, b, { join })`                              | Inner (default), left, right, or full joins at identical canonical grain        |
| `aggregateCube(cube, retainDimensionIds)`                     | Explicit roll-ups honoring each measure's `sum`/`count`/`average`/`none` policy |
| `sliceCube(cube, member)`                                     | Select a member and remove its dimension                                        |
| `projectDatasetCoverage(source, dimensions)`                  | Project and deduplicate canonical coordinates for one dataset                   |
| `countDatasetCoverage(datasets, dimensions)`                  | Count distinct dataset IDs at projected coordinates across bounded inputs       |
| `createHierarchy(definition)`                                 | Validate a named, versioned canonical member forest; find parents/ancestors     |

### OLAP query operators

- `diceCube(cube, selections)` filters by canonical member sets (OR within an axis, AND across axes), retaining dimensions and provenance. Empty selections match all; an empty member set matches none.
- `rollupCube(cube, hierarchy, targetMembers)` replaces members on one axis with their selected ancestors and aggregates using the existing measure policies. Targets must be disjoint and cover all observed members. Sparse inputs and mixed ancestor/descendant grains are rejected.
- `calculateMeasure(cube, definition)` evaluates a bounded arithmetic expression at each coordinate. The result is a distinct, terminal calculated stage with operand provenance. Calculate ratios after roll-up, not before.

See [OLAP examples and contracts](docs/olap.md).

### Canonical dimension hierarchies

`createHierarchy` accepts **explicit canonical member edges**, not inferred
geographic or industry relations. One named hierarchy is a single-parent,
acyclic forest within one dimension. Distinct classification systems use
distinct hierarchy keys.

```ts
import { canonicalMember, createHierarchy } from "@vizhub/udc";

const hierarchy = createHierarchy({
  key: "un-m49",
  dimensionId: "space",
  revision: "source-snapshot:v1",
  edition: "2026",
  edges: [
    {
      child: canonicalMember("space", "india"),
      parent: canonicalMember("space", "southern-asia"),
      provenance: {
        snapshot: { datasetId: "geography-2026", revision: "v1" },
        sourceRow: 1,
        mappingRevision: "approval:v1",
      },
    },
  ],
});

hierarchy.parent("india")?.id; // "southern-asia"
hierarchy.ancestors("india").map((member) => member.id);
```

Identical child-to-parent edges deduplicate while preserving each distinct
source-row provenance. Cycles, self-parents, conflicting parents, cross-dimension
identities and invalid revisions are rejected. Hosts must provide approved
relationships and stable canonical IDs; UDC neither authorizes nor materializes
member records. This module does **not** perform cube rollups or source-code
translation. See [the hierarchy API](docs/api.md) and [semantics](docs/concepts.md).

Inner joins return dense `CanonicalCube` values as before. Left/right/full joins return a distinct `SparseIntegratedCube`: `presence.left` and `presence.right` identify which source observed each coordinate. A source absent at a coordinate has **no measure property**; a present source reporting a null has a measure property whose `value` is `null`. Sparse results may be sliced, but cannot be implicitly aggregated or passed back as canonical input.

Coverage is separate from numeric integration. `projectDatasetCoverage` accepts a single-snapshot `CanonicalCube` or measure-less `CanonicalCoordinateDataset`, retains only selected canonical axes, and deduplicates coordinates within the dataset. `countDatasetCoverage` counts each dataset identity only once per coordinate, even when many source rows or visualization uses refer to the same dataset. It returns exact contributing dataset IDs for traceability. No Cartesian-product cells, inferred year coverage, implicit rollups, or numeric values are created.

The implementation deliberately rejects unknown or non-equivalent identifiers, duplicate measure identities, incompatible grains, ambiguous mappings and over-budget operations. There is no guesswork or implicit aggregation.

Failures throw a typed `UdcError` carrying a `UdcErrorCode` (`INVALID`, `LIMIT`, `DUPLICATE`, `UNRESOLVED`, `CONFLICT`, `INCOMPATIBLE`). `UDC_LIMITS` exposes the resource ceilings; inputs over budget fail rather than truncate. Low-level `assertId` and `assertBound` raise the same errors.

## Documentation

- [Quick start](docs/quickstart.md)
- [Concepts and data model](docs/concepts.md)
- [API reference](docs/api.md)
- [Scope, limits, and security](docs/limitations.md)
- [Migrating from UDC 2014](docs/migration-from-2014.md)
- [Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md) · [Change log](CHANGELOG.md)

## Relationship to VizHub

UDC is useful without VizHub. Visualization and data platforms may supply their own CSV/TSV bytes, schema revisions, reviewed mappings and provenance. In VizHub AI Studio, authorization, project membership and registry-source access must remain in the hosting application; the standalone library **does not perform authorization**. A source hash is an identity, not an access token.

UDC is MIT-licensed. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
