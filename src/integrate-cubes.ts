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
      throw new UdcError(
        "INCOMPATIBLE",
        "Measure value set does not match definitions",
      );
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
  assertBound(
    keys.length,
    UDC_LIMITS.outputObservations,
    "integrated observations",
  );

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

/**
 * Integrate revision-pinned sources at identical canonical grain. The first
 * input anchors a left join; the last anchors a right join. Full joins retain
 * the union, inner joins the intersection. Binary results retain their exact
 * legacy shape. For N-way sparse joins, presence.sources is authoritative.
 */
export function integrateManyCubes(
  cubes: readonly CanonicalCube[],
  options?: { join: "inner" },
): CanonicalCube;
export function integrateManyCubes(
  cubes: readonly CanonicalCube[],
  options: { join: OuterJoinMode },
): SparseIntegratedCube;
export function integrateManyCubes(
  cubes: readonly CanonicalCube[],
  options: IntegrationOptions,
): CanonicalCube | SparseIntegratedCube;
export function integrateManyCubes(
  cubes: readonly CanonicalCube[],
  options: IntegrationOptions = { join: "inner" },
): CanonicalCube | SparseIntegratedCube {
  const { join } = options;
  if (!["inner", "left", "right", "full"].includes(join))
    throw new UdcError("INVALID", "Unsupported join mode");
  if (cubes.length < 2)
    throw new UdcError("INVALID", "Integration requires at least two sources");
  assertBound(cubes.length, UDC_LIMITS.cubes, "integration sources");
  assertBound(
    cubes.reduce((sum, cube) => sum + cube.observations.length, 0),
    UDC_LIMITS.integrationInputRows,
    "integration input rows",
  );
  assertBound(
    cubes.reduce(
      (sum, cube) => sum + cube.observations.length * cube.measures.length,
      0,
    ),
    UDC_LIMITS.integrationInputValues,
    "integration input values",
  );
  if (cubes.length === 2) return integrateCubes(cubes[0], cubes[1], options);

  const first = cubes[0];
  const last = cubes.length - 1;
  const dimIds = (cube: CanonicalCube) =>
    cube.dimensions.map((dimension) => dimension.id).sort(stable);
  const grain = JSON.stringify(dimIds(first));
  const datasetIds = new Set<string>();
  const measureIds = new Set<string>();
  for (const cube of cubes) {
    if (cube.snapshots.length !== 1 || !cube.snapshots[0].revision)
      throw new UdcError("INCOMPATIBLE", "Expected one pinned source snapshot");
    const snapshot = cube.snapshots[0];
    assertId(snapshot.datasetId, "dataset");
    assertId(snapshot.revision!, "snapshot revision");
    if (datasetIds.has(snapshot.datasetId))
      throw new UdcError("CONFLICT", "Duplicate source dataset");
    datasetIds.add(snapshot.datasetId);
    if (JSON.stringify(dimIds(cube)) !== grain)
      throw new UdcError("INCOMPATIBLE", "Dimensions or granularity incompatible");
    for (const measure of cube.measures) {
      if (measureIds.has(measure.id))
        throw new UdcError("CONFLICT", "Duplicate measure identity");
      measureIds.add(measure.id);
    }
  }
  assertBound(measureIds.size, UDC_LIMITS.columns, "integration measures");
  const indexes = cubes.map(validate);
  const anchor = join === "right" ? last : 0;
  const keys = new Set<string>();
  if (join === "full") {
    for (const index of indexes) {
      for (const key of index.keys()) {
        keys.add(key);
        assertBound(keys.size, UDC_LIMITS.outputObservations, "integrated observations");
      }
    }
  } else {
    for (const key of indexes[anchor].keys()) {
      if (join !== "inner" || indexes.every((index) => index.has(key)))
        keys.add(key);
    }
  }
  assertBound(keys.size, UDC_LIMITS.outputObservations, "integrated observations");

  const shared = {
    dimensions: [...first.dimensions].sort((a, b) => stable(a.id, b.id)),
    measures: cubes.flatMap((cube) => cube.measures),
    snapshots: cubes.flatMap((cube) => cube.snapshots),
    schemaRevisions: [...new Set(cubes.flatMap((cube) => cube.schemaRevisions))].sort(stable),
    concordanceRevisions: [...new Set(cubes.flatMap((cube) => cube.concordanceRevisions))].sort(stable),
  };
  const observations = [...keys].sort(stable).map((key) => {
    const rows = indexes.map((index) => index.get(key));
    const values = Object.fromEntries(
      rows.flatMap((row) => (row ? Object.entries(row.values) : [])),
    );
    return {
      coordinate: rows.find((row) => row !== undefined)!.coordinate,
      cellKey: key,
      values,
      presence: {
        left: join === "right" ? rows.slice(0, last).some(Boolean) : !!rows[0],
        right: join === "right" ? !!rows[last] : rows.slice(1).some(Boolean),
        sources: cubes.map((cube, i) => ({
          datasetId: cube.snapshots[0].datasetId,
          present: rows[i] !== undefined,
        })),
      },
    };
  });
  if (join === "inner")
    return {
      stage: "canonical",
      ...shared,
      observations: observations.map(({ coordinate, cellKey, values }) => ({
        coordinate,
        cellKey,
        values,
      })),
    };
  return { stage: "sparse-integrated", join, ...shared, observations };
}
