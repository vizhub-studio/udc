import type {
  CanonicalCube,
  Dimension,
  Observation,
  Member,
  SparseIntegratedCube,
  SparseIntegratedObservation,
} from "./types";
import { getCellKey } from "./coordinate";
import { assertBound, assertId, UdcError, UDC_LIMITS } from "./limits";

export type JoinMode = "inner" | "left" | "right" | "full";
export type OuterJoinMode = Exclude<JoinMode, "inner">;
export interface IntegrationOptions {
  join: JoinMode;
}

const stable = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function validate(cube: CanonicalCube): Map<string, Observation<Member>> {
  if (cube.stage !== "canonical")
    throw new UdcError("INCOMPATIBLE", "Both cubes must be canonical");
  assertBound(cube.observations.length, UDC_LIMITS.rows, "input observations");
  const out = new Map<string, Observation<Member>>();
  const declaredDimensions = cube.dimensions.map((d) => d.id).sort(stable);
  const declaredMeasures = cube.measures
    .map((m) => {
      assertId(m.id, "measure");
      assertId(m.unit, "measure unit");
      return m.id;
    })
    .sort(stable);
  if (
    new Set(declaredDimensions).size !== declaredDimensions.length ||
    new Set(declaredMeasures).size !== declaredMeasures.length
  )
    throw new UdcError("DUPLICATE", "Duplicate cube declarations");
  for (const obs of cube.observations) {
    if (getCellKey(obs.coordinate) !== obs.cellKey || out.has(obs.cellKey))
      throw new UdcError(
        "DUPLICATE",
        "Invalid or duplicate canonical coordinate",
      );
    const actualDimensions = obs.coordinate.members
      .map((m) => m.dimensionId)
      .sort(stable);
    if (JSON.stringify(actualDimensions) !== JSON.stringify(declaredDimensions))
      throw new UdcError("INCOMPATIBLE", "Coordinate granularity mismatch");
    if (
      JSON.stringify(Object.keys(obs.values).sort(stable)) !==
      JSON.stringify(declaredMeasures)
    )
      throw new UdcError("INCOMPATIBLE", "Measure value set does not match definitions");
    out.set(obs.cellKey, obs);
  }
  return out;
}

/**
 * Inner joins remain dense CanonicalCubes. Non-inner joins have an explicit
 * sparse stage and presence flags, preserving absent-versus-null semantics.
 */
export function integrateCubes(
  a: CanonicalCube,
  b: CanonicalCube,
  options?: { join: "inner" },
): CanonicalCube;
export function integrateCubes(
  a: CanonicalCube,
  b: CanonicalCube,
  options: { join: OuterJoinMode },
): SparseIntegratedCube;
export function integrateCubes(
  a: CanonicalCube,
  b: CanonicalCube,
  options: IntegrationOptions,
): CanonicalCube | SparseIntegratedCube;
export function integrateCubes(
  a: CanonicalCube,
  b: CanonicalCube,
  options: IntegrationOptions = { join: "inner" },
): CanonicalCube | SparseIntegratedCube {
  const join = options?.join;
  if (
    join !== "inner" &&
    join !== "left" &&
    join !== "right" &&
    join !== "full"
  )
    throw new UdcError("INVALID", "Unsupported join mode");

  const left = validate(a);
  const right = validate(b);
  const dimIds = (dims: readonly Dimension[]) =>
    dims.map((x) => x.id).sort(stable);
  if (
    new Set(dimIds(a.dimensions)).size !== a.dimensions.length ||
    new Set(dimIds(b.dimensions)).size !== b.dimensions.length ||
    JSON.stringify(dimIds(a.dimensions)) !==
      JSON.stringify(dimIds(b.dimensions))
  )
    throw new UdcError(
      "INCOMPATIBLE",
      "Dimensions or granularity incompatible",
    );
  const ids = new Set(a.measures.map((x) => x.id));
  if (
    new Set(ids).size !== a.measures.length ||
    new Set(b.measures.map((x) => x.id)).size !== b.measures.length
  )
    throw new UdcError("DUPLICATE", "Duplicate measure definitions");
  for (const measure of b.measures)
    if (ids.has(measure.id))
      throw new UdcError("CONFLICT", "Duplicate measure identity");

  const keys = [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => {
      const inLeft = left.has(key);
      const inRight = right.has(key);
      return join === "inner"
        ? inLeft && inRight
        : join === "left"
          ? inLeft
          : join === "right"
            ? inRight
            : true;
    })
    .sort(stable);
  assertBound(keys.length, UDC_LIMITS.outputObservations, "integrated observations");

  const distinct = <T>(items: readonly T[]) => [...new Set(items)];
  const shared = {
    dimensions: [...a.dimensions].sort((x, y) => stable(x.id, y.id)),
    measures: [...a.measures, ...b.measures],
    snapshots: distinct(
      [...a.snapshots, ...b.snapshots].map((x) => JSON.stringify(x)),
    ).map((x) => JSON.parse(x)),
    schemaRevisions: distinct([
      ...a.schemaRevisions,
      ...b.schemaRevisions,
    ]).sort(stable),
    concordanceRevisions: distinct([
      ...a.concordanceRevisions,
      ...b.concordanceRevisions,
    ]).sort(stable),
  };
  if (join === "inner") {
    const observations: Observation<Member>[] = keys.map((key) => {
      const leftObs = left.get(key)!;
      const rightObs = right.get(key)!;
      return {
        coordinate: leftObs.coordinate,
        cellKey: key,
        values: { ...leftObs.values, ...rightObs.values },
      };
    });
    return { stage: "canonical", ...shared, observations };
  }

  const observations: SparseIntegratedObservation[] = keys.map((key) => {
    const leftObs = left.get(key);
    const rightObs = right.get(key);
    return {
      coordinate: (leftObs ?? rightObs)!.coordinate,
      cellKey: key,
      values: { ...leftObs?.values, ...rightObs?.values },
      presence: { left: leftObs !== undefined, right: rightObs !== undefined },
    };
  });
  return { stage: "sparse-integrated", join, ...shared, observations };
}
