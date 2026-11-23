import type {
  CanonicalCoordinateDataset,
  CanonicalCube,
  Coordinate,
  DatasetCoverageObservation,
  DatasetCoverageSummary,
  DatasetSnapshot,
  Dimension,
  Member,
  ProjectedDatasetCoverage,
} from "./types";
import { getCellKey } from "./coordinate";
import { assertBound, assertId, UdcError, UDC_LIMITS } from "./limits";

const stable = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (ids: readonly string[]) => [...ids].sort(stable);

/** Snapshot identities are metadata, never authorizations to access data. */
function validateSnapshot(snapshot: DatasetSnapshot): void {
  if (!snapshot || typeof snapshot !== "object")
    throw new UdcError("INVALID", "Missing dataset snapshot");
  assertId(snapshot.datasetId, "dataset snapshot");
  for (const [field, value] of Object.entries(snapshot)) {
    if (value !== undefined) assertId(value, "snapshot " + field);
  }
}

function validateDimensions(dimensions: readonly Dimension[]): string[] {
  if (!Array.isArray(dimensions))
    throw new UdcError("INVALID", "Invalid coverage dimensions");
  assertBound(dimensions.length, UDC_LIMITS.columns, "coverage dimensions");
  const ids = dimensions.map((dimension) => {
    if (
      !dimension ||
      typeof dimension.name !== "string" ||
      !dimension.name.trim()
    )
      throw new UdcError("INVALID", "Invalid coverage dimension");
    assertId(dimension.id, "dimension");
    return dimension.id;
  });
  if (new Set(ids).size !== ids.length)
    throw new UdcError("DUPLICATE", "Duplicate coverage dimension");
  return sorted(ids);
}

function validateRevisions(
  values: readonly string[] | undefined,
  label: string,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new UdcError("INVALID", "Invalid " + label);
  assertBound(values.length, UDC_LIMITS.columns, label);
  for (const revision of values) assertId(revision, label);
  const result = sorted(values);
  if (new Set(result).size !== result.length)
    throw new UdcError("DUPLICATE", "Duplicate " + label);
  return result;
}

function validateCoordinate(
  coordinate: Coordinate<Member>,
  dimensionIds: readonly string[],
): void {
  if (!coordinate || !Array.isArray(coordinate.members))
    throw new UdcError("INVALID", "Invalid coverage coordinate");
  for (const member of coordinate.members) {
    if (!member || member.kind !== "canonical")
      throw new UdcError("INCOMPATIBLE", "Coverage requires canonical members");
  }
  getCellKey(coordinate);
  if (
    JSON.stringify(sorted(coordinate.members.map((m) => m.dimensionId))) !==
    JSON.stringify(dimensionIds)
  )
    throw new UdcError("INCOMPATIBLE", "Coverage coordinate grain mismatch");
}

function projectCoordinate(
  coordinate: Coordinate<Member>,
  retained: ReadonlySet<string>,
): Coordinate<Member> {
  return {
    members: coordinate.members
      .filter((member) => retained.has(member.dimensionId))
      .map((member) => ({ ...member }))
      .sort((a, b) => stable(a.dimensionId, b.dimensionId)),
  };
}

/**
 * Project coordinate *existence*, not numeric measure values, onto a subset of
 * dimensions. Each source coordinate contributes at most one presence
 * indication per projected key, regardless of null/zero values or measure policy.
 *
 * CanonicalCube must represent exactly one snapshot. Measure-less datasets
 * use CanonicalCoordinateDataset with already-reviewed canonical coordinates.
 */
export function projectDatasetCoverage(
  source: CanonicalCube | CanonicalCoordinateDataset,
  retainDimensionIds: readonly string[],
): ProjectedDatasetCoverage {
  if (
    !source ||
    (source.stage !== "canonical" && source.stage !== "coordinate-dataset")
  )
    throw new UdcError("INCOMPATIBLE", "Expected a single canonical dataset");
  if (!Array.isArray(retainDimensionIds))
    throw new UdcError("INVALID", "Invalid retained dimensions");

  const originalIds = validateDimensions(source.dimensions);
  assertBound(
    retainDimensionIds.length,
    UDC_LIMITS.columns,
    "retained dimensions",
  );
  const retained = new Set<string>();
  for (const id of retainDimensionIds) {
    assertId(id, "retained dimension");
    if (!originalIds.includes(id))
      throw new UdcError("INCOMPATIBLE", "Unknown retained dimension");
    if (retained.has(id))
      throw new UdcError("DUPLICATE", "Duplicate retained dimension");
    retained.add(id);
  }

  const snapshot =
    source.stage === "canonical"
      ? (() => {
          if (!Array.isArray(source.snapshots) || source.snapshots.length !== 1)
            throw new UdcError(
              "INCOMPATIBLE",
              "Coverage requires one dataset snapshot",
            );
          return source.snapshots[0];
        })()
      : source.snapshot;
  validateSnapshot(snapshot);

  const schemaRevisions = validateRevisions(
    source.schemaRevisions,
    "schema revisions",
  );
  const concordanceRevisions = validateRevisions(
    source.concordanceRevisions,
    "concordance revisions",
  );
  const coordinates =
    source.stage === "canonical" ? source.observations : source.coordinates;
  if (!Array.isArray(coordinates))
    throw new UdcError("INVALID", "Invalid coverage observations");
  assertBound(
    coordinates.length,
    UDC_LIMITS.rows,
    "coverage input coordinates",
  );

  const groups = new Map<
    string,
    {
      coordinate: Coordinate<Member>;
      cellKey: string;
      sourceCoordinateCount: number;
    }
  >();
  const seenOriginal = new Set<string>();
  for (const item of coordinates) {
    const coordinate =
      source.stage === "canonical"
        ? (item as CanonicalCube["observations"][number]).coordinate
        : (item as Coordinate<Member>);
    validateCoordinate(coordinate, originalIds);
    const originalKey = getCellKey(coordinate);
    if (source.stage === "canonical") {
      if (
        (item as CanonicalCube["observations"][number]).cellKey !==
          originalKey ||
        seenOriginal.has(originalKey)
      )
        throw new UdcError(
          "DUPLICATE",
          "Invalid or duplicate canonical coordinate",
        );
      seenOriginal.add(originalKey);
    }

    const projected = projectCoordinate(coordinate, retained);
    const cellKey = getCellKey(projected);
    const existing = groups.get(cellKey);
    if (existing) {
      existing.sourceCoordinateCount++;
    } else {
      groups.set(cellKey, {
        coordinate: projected,
        cellKey,
        sourceCoordinateCount: 1,
      });
    }
  }
  assertBound(
    groups.size,
    UDC_LIMITS.outputObservations,
    "projected coordinates",
  );

  return {
    stage: "dataset-coverage",
    snapshot: { ...snapshot },
    dimensions: source.dimensions
      .filter((dimension) => retained.has(dimension.id))
      .map((dimension) => ({ ...dimension }))
      .sort((a, b) => stable(a.id, b.id)),
    coordinates: [...groups.values()].sort((a, b) =>
      stable(a.cellKey, b.cellKey),
    ),
    schemaRevisions,
    concordanceRevisions,
  };
}

/**
 * Count distinct dataset IDs at each canonical projected coordinate.
 * Repeated uses of a content-identical dataset count once, not once per
 * visualization, row, or measure. Conflicting revision pins fail closed.
 */
export function countDatasetCoverage(
  datasets: readonly ProjectedDatasetCoverage[],
  dimensions: readonly Dimension[],
): DatasetCoverageSummary {
  if (!Array.isArray(datasets))
    throw new UdcError("INVALID", "Invalid coverage datasets");
  assertBound(
    datasets.length,
    UDC_LIMITS.coverageDatasets,
    "coverage datasets",
  );
  const ids = validateDimensions(dimensions);
  const retained = new Set(ids);
  const cells = new Map<
    string,
    { coordinate: Coordinate<Member>; contributorIds: Set<string> }
  >();
  const datasetPins = new Map<string, string>();
  const snapshots = new Map<string, DatasetSnapshot>();
  let contributions = 0;

  for (const dataset of datasets) {
    if (!dataset || dataset.stage !== "dataset-coverage")
      throw new UdcError("INCOMPATIBLE", "Expected projected dataset coverage");
    validateSnapshot(dataset.snapshot);
    if (
      JSON.stringify(validateDimensions(dataset.dimensions)) !==
      JSON.stringify(ids)
    )
      throw new UdcError("INCOMPATIBLE", "Coverage dimension sets differ");

    const pin = JSON.stringify([
      dataset.snapshot.revision ?? null,
      validateRevisions(dataset.schemaRevisions, "schema revisions"),
      validateRevisions(dataset.concordanceRevisions, "concordance revisions"),
    ]);
    const datasetId = dataset.snapshot.datasetId;
    if (datasetPins.has(datasetId) && datasetPins.get(datasetId) !== pin)
      throw new UdcError(
        "CONFLICT",
        "Conflicting revisions for the same dataset",
      );
    datasetPins.set(datasetId, pin);

    const snapshotKey = JSON.stringify(
      Object.entries(dataset.snapshot).sort(([a], [b]) => stable(a, b)),
    );
    snapshots.set(snapshotKey, { ...dataset.snapshot });

    if (!Array.isArray(dataset.coordinates))
      throw new UdcError("INVALID", "Invalid projected coordinates");
    assertBound(
      dataset.coordinates.length,
      UDC_LIMITS.outputObservations,
      "dataset coordinates",
    );
    contributions += dataset.coordinates.length;
    assertBound(
      contributions,
      UDC_LIMITS.coverageContributions,
      "coverage coordinate contributions",
    );
    const seen = new Set<string>();
    for (const item of dataset.coordinates) {
      if (!item || !item.coordinate)
        throw new UdcError("INVALID", "Invalid projected coordinate");
      validateCoordinate(item.coordinate, ids);
      const key = getCellKey(item.coordinate);
      if (key !== item.cellKey || seen.has(key))
        throw new UdcError(
          "DUPLICATE",
          "Invalid or duplicate projected coordinate",
        );
      seen.add(key);
      assertBound(
        item.sourceCoordinateCount,
        UDC_LIMITS.rows,
        "source coordinate count",
      );
      if (item.sourceCoordinateCount === 0)
        throw new UdcError("INVALID", "Empty coverage contribution");
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          coordinate: projectCoordinate(item.coordinate, retained),
          contributorIds: new Set(),
        };
        cells.set(key, cell);
        assertBound(
          cells.size,
          UDC_LIMITS.coverageOutputCoordinates,
          "coverage output coordinates",
        );
      }
      cell.contributorIds.add(datasetId);
    }
  }

  const observations: DatasetCoverageObservation[] = [...cells]
    .sort(([a], [b]) => stable(a, b))
    .map(([cellKey, cell]) => {
      const datasetIds = sorted([...cell.contributorIds]);
      return {
        coordinate: cell.coordinate,
        cellKey,
        datasetCount: datasetIds.length,
        datasetIds,
      };
    });
  return {
    stage: "coverage-summary",
    dimensions: [...dimensions]
      .map((dimension) => ({ ...dimension }))
      .sort((a, b) => stable(a.id, b.id)),
    observations,
    snapshots: [...snapshots]
      .sort(([a], [b]) => stable(a, b))
      .map(([, value]) => value),
  };
}
