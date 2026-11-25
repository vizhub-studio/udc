# Declarative JSON queries (v1)

The query API composes the existing UDC operators without introducing a SQL
parser, evaluation of expression strings, a network loader, or a database.
The syntax is inspired by Cube's semantic JSON API and Druid's structured
arithmetic. The host supplies an authorized semantic catalog and immutable
canonical source cubes.

```ts
import { describeQuerySource, validateQuery, planQuery, executeQuery } from "@vizhub/udc";

// gdp and population are revision-pinned CanonicalCubes from the host.
const query = {
  version: 1,
  dimensions: ["space", "time"],
  measures: ["gdp-per-capita"],
  filters: [{ dimensionId: "time", memberIds: ["2020", "2021"] }],
  calculatedMeasures: [{
    id: "gdp-per-capita",
    name: "GDP per capita",
    unit: "USD/person",
    expression: {
      kind: "binary",
      operator: "/",
      left: { kind: "measure", measureId: "gdp" },
      right: { kind: "measure", measureId: "population" },
    },
  }],
  topN: { measureId: "gdp-per-capita", n: 10, partitionBy: ["time"] },
} as const;
validateQuery(query);
const plan = planQuery(query, {
  sources: [describeQuerySource(gdp), describeQuerySource(population)],
});
const result = executeQuery(plan, { cubes: [gdp, population] });
```

The same query object can be supplied as JSON after runtime validation.
The plan contains source snapshot identities, semantic revision pins, selected
measure IDs and ordered operator steps; no rows, executable functions or loaders.
A catalog can be built from metadata without fetching rows. The convenience
function `describeQuerySource` derives that metadata from an existing canonical
cube. Each source must have one dataset snapshot with an immutable revision.

## Query properties

| Field | Meaning |
| --- | --- |
| version | Required literal 1 |
| dimensions | Retained axes, in output order; [] requests scalar grain |
| measures | Nonempty requested output measures, in output order |
| filters | Existing DiceSelection objects: OR within axis, AND across axes, before integration |
| rollups | Explicit hierarchyKey, revision and targetMembers; one hierarchy per retained axis |
| calculatedMeasures | Zero or one existing CalculatedMeasureDefinition, evaluated after rollups and aggregation |
| measureFilter | Existing structured MeasurePredicate evaluated at final grain |
| join | inner (default), full, left or right |
| joinAnchor | Required for left/right; semantic required measure ID identifying the preserved source |
| topN | Existing TopNOptions, partitioned on retained axes |

All identifiers are canonical semantic IDs. Dimension ranges are not inferred
from IDs; enumerate canonical members explicitly. Numeric comparisons, ranges,
Boolean predicates and arithmetic use the existing structured operator types
(see [OLAP contracts](olap.md)). A count roll-up is requested as
`measure-id:count`, exactly as the existing reducer names its output.

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
   and cannot roll up or aggregate.
4. Calculate the derived measure at final grain, apply the measure predicate,
   select top/bottom N, and project the requested output. Missing and null
   values retain existing operator semantics. Ranking ties use canonical keys.
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

## Initial limits and deliberate non-goals

The existing UDC limits apply (including two selected source cubes, 10,000
observations, bounded expression/predicate trees). One calculated measure per
query; no chained calculations or arbitrary code. No implicit aggregation of
sparse results, cross-grain joins, inferred source preferences, drill-down query
syntax, independent rank metadata, arbitrary sorting, dataset coverage queries,
physical loading, authentication, HTTP/MCP endpoints, or application UI.
Existing lower-level operators remain public for these workflows. No new
production dependencies. This source change does not publish an npm version.
