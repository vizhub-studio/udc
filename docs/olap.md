# OLAP query operations

These pure operations work with canonical coordinates and do not load data or infer semantic mappings.

## Dice

`diceCube(cube, selections)` accepts canonical, sparse-integrated, aggregated and calculated cubes and returns the same stage. Each selection specifies a dimension ID and a list of canonical member IDs. Match any member within a selection and all selections across dimensions. Omitted dimensions are unrestricted. Duplicate dimension selections are errors; duplicate member IDs have set semantics. Unknown but valid member IDs match nothing. Empty selections match all; empty member sets match none. Input ordering and provenance are retained.

## Hierarchical roll-up

`rollupCube(cube, hierarchy, targetMembers)` accepts dense canonical or aggregated cubes, preserves the dimensions, and groups by explicit target members of a validated hierarchy. Targets must be known, disjoint (no ancestor/descendant overlap), and cover every observed member. Observed ancestor/descendant mixtures on the selected axis are rejected conservatively, even across other coordinates. Sparse cubes require an explicit missingness policy outside this release.

The shared reducer preserves sums, non-null counts, average sufficient statistics and source rows. Non-additive measures reject multi-observation groups. Each roll-up records the hierarchy key, edition, revision and traversed edges with their original evidence. Subsequent aggregations retain that history. No missing coordinates or hierarchy relationships are inferred.

## Calculated measures

`calculateMeasure(cube, definition)` accepts canonical, aggregated and sparse-integrated inputs. Expressions are explicit trees with measure references, finite numeric constants, and binary arithmetic operators. The caller declares the output unit; there is no implicit unit conversion or dimensional analysis. Unknown references, duplicate output IDs, non-finite arithmetic and excessive expression depth or size fail with typed errors.

Present null operands or division by zero produce a present null calculated value. An absent sparse operand produces an absent calculated value. Each present derived value identifies its distinct source measure operands and their source-row contributors. The calculated result preserves the input values, sparse flags and hierarchy history and has a separate terminal stage. It is not accepted by aggregate, roll-up or integration operations: calculate ratios at the final grain.

## Advanced analytical queries

- `drilldownCube(fineCube, hierarchy, parentMemberId)` selects the observed descendants of a known non-leaf parent and rolls them up to its immediate children. Other dimensions are retained. Supply a dense finer-grained cube, already restricted to any required time or other axes. The result is aggregated, even when a child is already observed directly. No parent/coarser total can be inverted; unknown members, mixed ancestor/descendant grain in the selected subtree, incompatible hierarchy history, sparse inputs and leaf drill-down are rejected. Empty observed subtrees return no observations. No unobserved child or period is synthesized. Hierarchy navigation via `createHierarchy(...).children(member)` and `descendants(member)` uses deterministic sibling order and breadth-first traversal respectively; unknown members have no children.
- `filterCube(cube, predicate)` returns the same stage, preserves input order, and evaluates a bounded declarative predicate tree. Use `{ kind: "compare", measureId, operator, value }` (eq, ne, lt, lte, gt, gte), `{ kind: "range", measureId, min, max }` (inclusive), `{ kind: "isNull", measureId }`, or `{ kind: "isAbsent", measureId }`. Combine nonempty operand arrays with `{ kind: "and" | "or", operands }` and negate with `{ kind: "not", operand }`. Numeric comparisons against present null or absent values are unknown, including after NOT. AND with false is false; OR with true is true; otherwise unknown propagates. Only true matches. Null and absent checks are distinct and always boolean. Unknown measures and invalid or excessive predicates fail even on empty cubes.
- `rankCube(cube, options)` produces metadata entries with `cellKey`, `partitionKey`, numeric `value` and `rank`. Specify `measureId`, optional `direction` (desc default, asc for lowest first), `partitionBy` (dimension IDs, empty/global by default), and `method` (competition default, ordinal or dense). Values 100, 80, 80, 60 rank 1, 2, 2, 4 by competition, 1, 2, 3, 4 by ordinal, or 1, 2, 2, 3 by dense ranking. Null and absent values are unranked; zero is numeric. Equal values are sorted by canonical cell key, and partitions by projected coordinate key. Rank is metadata, not an aggregatable measure.
- `topNCube(cube, { ...rankOptions, n, ties })` selects up to N numeric observations per partition, in rank order. N is a nonnegative bounded integer; `ties: "exact"` (default) uses the deterministic cell-key tie-break, and `ties: "include"` retains all observations equal to the Nth value, regardless of rank method. N = 0 selects none; N larger than the partition selects every numeric observation. Use ascending direction for bottom-N. Original stage, coordinates, values, sparse flags, aggregation state and provenance are unchanged.

Filtering, ranking, top-N and dice accept calculated results; aggregate, roll-up and integration still reject them. A partition dimension must actually exist on the cube: a geographic hierarchy does not implicitly add a continent dimension. For a per-region country ranking, drill down separately within each region or supply an explicit region dimension. Ranking and top-N describe the selected observations, not all possible members.

## Example

Assume GDP and population are canonical cubes at identical country/year grain, and geography is a versioned hierarchy built from approved mappings.

```ts
import {
  integrateCubes,
  diceCube,
  rollupCube,
  calculateMeasure,
} from "@vizhub/udc";

const joined = integrateCubes(gdp, population);
const selected = diceCube(joined, [
  { dimensionId: "year", memberIds: ["2020", "2021"] },
]);
const regional = rollupCube(selected, geography, [
  "europe",
  "asia",
  "africa",
  "americas",
  "oceania",
]);
const result = calculateMeasure(regional, {
  id: "gdp-per-capita",
  name: "GDP per capita",
  unit: "USD/person",
  expression: {
    kind: "binary",
    operator: "/",
    left: { kind: "measure", measureId: "gdp" },
    right: { kind: "measure", measureId: "population" },
  },
});
```

For a ranked country-level view, use the underlying selected cube rather than the regional totals:

```ts
import { drilldownCube, filterCube, topNCube } from "@vizhub/udc";

const countries = drilldownCube(selected, geography, "asia");
const ratios = calculateMeasure(countries, {
  id: "gdp-per-capita",
  name: "GDP per capita",
  unit: "USD/person",
  expression: {
    kind: "binary",
    operator: "/",
    left: { kind: "measure", measureId: "gdp" },
    right: { kind: "measure", measureId: "population" },
  },
});
const eligible = filterCube(ratios, {
  kind: "compare",
  measureId: "population",
  operator: "gte",
  value: 1000000,
});
const top = topNCube(eligible, {
  measureId: "gdp-per-capita",
  partitionBy: ["year"],
  n: 10,
  ties: "include",
});
```

Here the hierarchy must have countries as immediate children of the selected parent for a country-level result. If the immediate children are subregions, drill into each subregion using the finer source instead; for continent-wide ranking of countries across subregions, dice the original country cube to all observed country descendants before calculating.

An inner join here summarizes only the shared observed coordinates, not the complete population of a region. Use only data whose coverage and units support the intended interpretation.

For declarative access to drill-down through the query API, see the
[drill-down query syntax](query-language.md#declarative-drill-down).

The deterministic golden workflow in `test/olap.test.ts` exercises this composition with synthetic fixtures. The operations are library-only; no application UI, data loader or database is introduced.

### Multiple calculated measures

`calculateMeasures(cube, definitions)` evaluates a nonempty acyclic graph of structured expressions at the final grain. It accepts forward references, rejects unknown inputs and duplicate output IDs, and retains transitive source provenance. Its result remains a terminal calculated cube, not an aggregatable cube. For compatibility, `definition` is the last evaluated definition; multi-calculation cubes additionally expose the complete ordered `definitions` array. `calculateMeasure` remains the single-definition convenience API.

Minimum and maximum ignore nulls, return null for all-null groups, and merge extrema across repeated rollups without computing irrelevant sums. Provenance retains all contributing source rows, including nulls.
