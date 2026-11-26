# Declarative JSON queries (v1)

The query API composes the existing UDC operators without introducing a SQL
parser, evaluation of expression strings, a network loader, or a database.
The syntax is inspired by Cube's semantic JSON API and Druid's structured
arithmetic. The host supplies an authorized semantic catalog and an asynchronous
provider for immutable canonical source cubes.

```ts
import {
  describeQuerySource,
  validateQuery,
  planQuery,
  executeQuery,
  createInMemoryProvider,
} from "@vizhub/udc";

// gdp and population are revision-pinned CanonicalCubes from the host.
const query = {
  version: 1,
  dimensions: ["space", "time"],
  measures: ["gdp-per-capita"],
  filters: [{ dimensionId: "time", memberIds: ["2020", "2021"] }],
  calculatedMeasures: [
    {
      id: "gdp-per-capita",
      name: "GDP per capita",
      unit: "USD/person",
      expression: {
        kind: "binary",
        operator: "/",
        left: { kind: "measure", measureId: "gdp" },
        right: { kind: "measure", measureId: "population" },
      },
    },
  ],
  topN: { measureId: "gdp-per-capita", n: 10, partitionBy: ["time"] },
} as const;
validateQuery(query);
const plan = planQuery(query, {
  sources: [describeQuerySource(gdp), describeQuerySource(population)],
});
const result = await executeQuery(plan, {
  provider: createInMemoryProvider([gdp, population]),
});
```

The same query object can be supplied as JSON after runtime validation.
The plan contains source snapshot identities, semantic revision pins, selected
measure IDs and ordered operator steps; no rows, executable functions or loaders.
A catalog can be built from metadata without fetching rows. The convenience
function `describeQuerySource` derives that metadata from an existing canonical
cube. Each source must have one dataset snapshot with an immutable revision.

## Data providers (UDC 3.0)

`executeQuery` now always returns a promise. Replace
`executeQuery(plan, { cubes })` with
`await executeQuery(plan, { provider: createInMemoryProvider(cubes) })`.
For remote acquisition, implement `DataProvider` instead:

```ts
import type { DataProvider, QueryPlan } from "@vizhub/udc";

function providerFor(
  plan: QueryPlan,
  load: DataProvider["loadSource"],
): DataProvider {
  return {
    sources: plan.sources.map((entry) => entry.source),
    loadSource: load,
  };
}
```

The host must authorize the sources and provide exactly the selected metadata
and corresponding complete canonical snapshots for the fallback loader.
Each request includes revision-pinned source metadata, measure dependencies
(including hidden operands), and canonical dimension filters.

### Optional source pushdown

A provider may expose `pushdown: { capabilities(source), load(request) }`.
UDC negotiates exact source-local dimension filtering and measure projection,
and may request aggregation only for one source, no hierarchy rollups,
no residual dimension filter, and additive/count/average measures. Original
grain is retained for federation. All other operators stay in UDC.

The load request includes a backend-neutral `pushdown` plan: exact filters
(OR within an axis, AND across axes), measure IDs, and optional
`aggregateDimensions` (including [] for scalar). Return a discriminated
`subset` with a canonical cube, `aggregate` with an aggregated cube, or
`unsupported` to use the full loader. A subset retains the source dimensions,
snapshot, schema and concordance revisions, selected measure definitions and
original source-row provenance. It must contain every matching observation,
not a page or sample. Aggregation must exactly reproduce aggregateCube,
including null handling, count-derived measure IDs, sufficient statistics,
canonical contributor order and all contributing rows, including nulls.
An empty input returns no groups, even for scalar queries. Floating-point
reduction order must be equivalent; providers that cannot guarantee this
must decline aggregation. UDC verifies result metadata, coordinate grain,
filter membership for subsets, aggregate state and contributor structure;
it cannot prove remote completeness or verify values against unseen rows.

The provider owns revision consistency, canonical mappings, authorization and
resource bounds on remote work. Returned rows and aggregate lineage remain
bounded. Failures reject the query; only explicit unsupported permits fallback.
No SQL compilation, database drivers, connections or credentials live in UDC.
The provider and hierarchy inputs must remain immutable during execution.

## Query properties

| Field              | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| version            | Required literal 1                                                                        |
| dimensions         | Retained axes, in output order; [] requests scalar grain                                  |
| measures           | Nonempty requested output measures, in output order                                       |
| filters            | Existing DiceSelection objects: OR within axis, AND across axes, before integration       |
| rollups            | Explicit hierarchyKey, revision and targetMembers; one hierarchy per retained axis        |
| calculatedMeasures | Multiple CalculatedMeasureDefinitions with acyclic dependencies, evaluated after rollups and aggregation |
| measureFilter      | Existing structured MeasurePredicate evaluated at final grain                             |
| join               | inner (default), full, left or right                                                      |
| joinAnchor         | Required for left/right; semantic required measure ID identifying the preserved source    |
| topN               | Existing TopNOptions, partitioned on retained axes                                        |
| orderBy            | Ordered dimension or measure keys from the requested output                               |
| limit              | Global nonnegative integer cap on returned observations (at most 10,000)                  |

All identifiers are canonical semantic IDs. Dimension ranges are not inferred
from IDs; enumerate canonical members explicitly. Numeric comparisons, ranges,
Boolean predicates and arithmetic use the existing structured operator types
(see [OLAP contracts](olap.md)). A count roll-up is requested as
`measure-id:count`, exactly as the existing reducer names its output.

## Ordering and limits

```json
{
  "version": 1,
  "dimensions": ["country", "year"],
  "measures": ["population", "gdp-usd"],
  "orderBy": [
    { "kind": "dimension", "dimensionId": "year", "direction": "asc" },
    { "kind": "measure", "measureId": "gdp-usd", "direction": "desc" }
  ],
  "limit": 100
}
```

Earlier keys take precedence. Dimensions compare canonical IDs lexically,
not display labels or inferred numeric or chronological values. Measures
compare numeric values; explicit nulls sort after numbers, and absent values
sort after nulls, in either direction. Equal keys fall back to ascending
canonical cell keys. Ordering keys must be unique selected output fields
(including a calculated measure or explicit derived count identity).
An omitted or empty ordering preserves the original default ordering,
including the existing top-N ordering. Explicit ordering is applied after
top-N and does not change which observations top-N selects.

The optional limit applies globally after ordering. Zero returns no observations
but preserves result metadata. A limit greater than the result size returns
all observations; values above the existing output bound are rejected.
Limits do not relax source or intermediate computational resource budgets.
They are not pagination or a replacement for partitioned top-N.

## Planning and execution

1. Validate bounded, versioned JSON syntax and gather all measure dependencies,
   including operands and measures referenced only by filtering or ranking.
2. Resolve each source measure to exactly one eligible catalog entry containing
   all requested and filtered axes. Reject competing providers; do not prefer
   a physical dataset or silently guess. Require identical canonical grain
   across selected sources. No cross-grain joins or implicit source union.
3. Project away unused input measures, filter dimensions, integrate sources,
   apply hierarchical rollups in query order, and aggregate away extra axes.
   Only shared coordinates contribute to inner joins; this is not a guarantee
   of complete coverage. Explicit left/right/full joins retain sparse absence
   and cannot roll up or aggregate. N-way inner joins intersect all selected
   coordinates, full joins union them, and directional joins retain exactly
   the anchor source's coordinates.
4. Calculate the derived measure at final grain, apply the measure predicate,
   select top/bottom N, apply explicit ordering, apply the global limit, and
   project the requested output. Missing and null values retain existing operator
   semantics. Ranking ties use canonical keys.
5. Return a terminal QueryResult with requested dimensions and measures, cell
   keys, values, provenance, snapshots, hierarchy evidence and sparse flags.
   Hidden operands are excluded from output columns but remain in calculation
   lineage. Results are not implicitly reusable as canonical cubes.

The executor rebuilds the plan against the actual supplied metadata before
execution and rejects stale/tampered plans and extra/missing sources. Revision
pins are identities, not cryptographic content verification: the host must
guarantee immutability, authorization, compatible units, and approved
concordances/hierarchies. Hierarchy revisions must identify immutable definitions.
There is no implicit unit conversion or dimensional analysis.

## N-way sparse presence

Binary results retain the existing `presence.left` and `presence.right`.
For three or more selected sources, each sparse observation also includes
`presence.sources`, an ordered array of dataset IDs and Boolean presence.
Dataset revisions remain pinned in the result snapshots. The existing flags
summarize groups: left joins and full joins use first versus remaining sources;
right joins use preceding sources versus the last (anchor) source. A group
is present if any source in it is present. Use the per-source array for
unambiguous N-way presence. Source order is deterministic by dataset ID,
with the directional anchor moved to the preserved end.

## Initial limits and deliberate non-goals

The existing UDC limits apply: at most 100 selected measures/sources, 10,000
rows per source, 100,000 acquired input rows and 1,000,000 acquired measure
values across sources, 10,000 output observations, and bounded expression and
predicate trees. Provider-side work is still bounded by the host. Calculated measures
support forward references and acyclic chains; no arbitrary code. At most 100 definitions,
100 expression nodes per definition, 1,000 cumulative nodes, 10 million row-expression
node operations, and one million retained calculation contributor entries are allowed.
Base and calculated intermediate measures share the 100-column budget. Unused definitions,
duplicate identities, cycles and unresolved operands fail closed. No implicit aggregation of
sparse results, cross-grain joins, inferred source preferences, drill-down query
syntax, independent rank metadata, sorting by hidden fields, dataset coverage queries,
physical loading, authentication, HTTP/MCP endpoints, or application UI.
Existing lower-level operators remain public for these workflows. No new
production dependencies. This source change does not publish an npm version.

### Composable calculated measures

A measure expression can reference any declared calculated measure by ID, irrespective of declaration order. Requested output measures, measure predicates and ranking determine the roots; all intermediate dependencies must be reachable. The planner resolves only base operands against the source catalog. Calculations run once per row in deterministic topological order after rollups and aggregation and before measure predicates, ranking and projection. Missing operands remain absent and explicit nulls propagate. Each direct input retains transitive original source-row contributors, deduplicated across shared dependency paths within that input. Single-calculation results retain `definition`; multi-calculation results expose `definitions` in evaluation order. Query syntax remains version 1.
