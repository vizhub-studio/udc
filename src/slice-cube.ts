import type { CanonicalCube, Member, SparseIntegratedCube } from "./types";
import { getCellKey, memberIdentity } from "./coordinate";
import { UdcError } from "./limits";

/**
 * Fix a canonical member, removing its dimension. Sparse joins retain missing
 * measure keys and left/right presence; no implicit filling or aggregation.
 */
export function sliceCube(cube: CanonicalCube, member: Member): CanonicalCube;
export function sliceCube(
  cube: SparseIntegratedCube,
  member: Member,
): SparseIntegratedCube;
export function sliceCube(
  cube: CanonicalCube | SparseIntegratedCube,
  member: Member,
): CanonicalCube | SparseIntegratedCube {
  if (cube.stage !== "canonical" && cube.stage !== "sparse-integrated")
    throw new UdcError(
      "INCOMPATIBLE",
      "Expected canonical or sparse-integrated cube",
    );
  memberIdentity(member);
  if (!cube.dimensions.some((d) => d.id === member.dimensionId))
    throw new UdcError("INCOMPATIBLE", "Member dimension not in cube");
  const dimensions = cube.dimensions.filter((x) => x.id !== member.dimensionId);
  if (cube.stage === "canonical") {
    const observations = cube.observations.flatMap((obs) => {
      if (
        !obs.coordinate.members.some(
          (m) => m.dimensionId === member.dimensionId && m.id === member.id,
        )
      )
        return [];
      const coordinate = {
        members: obs.coordinate.members.filter(
          (m) => m.dimensionId !== member.dimensionId,
        ),
      };
      return [{ ...obs, coordinate, cellKey: getCellKey(coordinate) }];
    });
    return { ...cube, dimensions, observations };
  }
  const observations = cube.observations.flatMap((obs) => {
    if (
      !obs.coordinate.members.some(
        (m) => m.dimensionId === member.dimensionId && m.id === member.id,
      )
    )
      return [];
    const coordinate = {
      members: obs.coordinate.members.filter(
        (m) => m.dimensionId !== member.dimensionId,
      ),
    };
    return [{ ...obs, coordinate, cellKey: getCellKey(coordinate) }];
  });
  return { ...cube, dimensions, observations };
}
