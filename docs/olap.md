# OLAP query operations

These pure operations work with canonical coordinates and do not load data or infer semantic mappings.

## Dice

`diceCube(cube, selections)` accepts canonical, sparse-integrated and aggregated cubes and returns the same stage. Each selection specifies a dimension ID and a list of canonical member IDs. Match any member within a selection and all selections across dimensions. Omitted dimensions are unrestricted. Duplicate dimension selections are errors; duplicate member IDs have set semantics. Unknown but valid member IDs match nothing. Empty selections match all; empty member sets match none. Input ordering and provenance are retained.

## Hierarchical roll-up

`rollupCube(cube, hierarchy, targetMembers)` accepts dense canonical or aggregated cubes, preserves the dimensions, and groups by explicit target members of a validated hierarchy. Targets must be known, disjoint (no ancestor/descendant overlap), and cover every observed member. Observed ancestor/descendant mixtures on the selected axis are rejected conservatively, even across other coordinates. Sparse cubes require an explicit missingness policy outside this release.

The shared reducer preserves sums, non-null counts, average sufficient statistics and source rows. Non-additive measures reject multi-observation groups. Each roll-up records the hierarchy key, edition, revision and traversed edges with their original evidence. Subsequent aggregations retain that history. No missing coordinates or hierarchy relationships are inferred.

## Calculated measures

`calculateMeasure(cube, definition)` accepts canonical, aggregated and sparse-integrated inputs. Expressions are explicit trees with measure references, finite numeric constants, and binary arithmetic operators. The caller declares the output unit; there is no implicit unit conversion or dimensional analysis. Unknown references, duplicate output IDs, non-finite arithmetic and excessive expression depth or size fail with typed errors.

Present null operands or division by zero produce a present null calculated value. An absent sparse operand produces an absent calculated value. Each present derived value identifies its distinct source measure operands and their source-row contributors. The calculated result preserves the input values, sparse flags and hierarchy history and has a separate terminal stage. It is not accepted by aggregate, roll-up or integration operations: calculate ratios at the final grain.

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

An inner join here summarizes only the shared observed coordinates, not the complete population of a region. Use only data whose coverage and units support the intended interpretation.

The deterministic golden workflow in `test/olap.test.ts` exercises this composition with synthetic fixtures. The operations are library-only; no application UI, data loader or database is introduced.
