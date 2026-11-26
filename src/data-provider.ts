import { UdcError } from "./limits";
import { describeQuerySource } from "./plan-query";
import type { DataProvider } from "./query-types";
import type { CanonicalCube } from "./types";

/** Adapt already canonicalized, revision-pinned cubes to the async API. */
export function createInMemoryProvider(
  cubes: readonly CanonicalCube[],
): DataProvider {
  // Capture the collection, not a second copy of potentially large row arrays.
  const selected = [...cubes];
  return {
    sources: selected.map(describeQuerySource),
    async loadSource({ source }) {
      const matches = selected.filter(
        (cube) =>
          cube.snapshots[0].datasetId === source.snapshot.datasetId &&
          cube.snapshots[0].revision === source.snapshot.revision,
      );
      if (matches.length !== 1)
        throw new UdcError(
          "CONFLICT",
          "Source snapshot not uniquely available",
        );
      return matches[0];
    },
  };
}
