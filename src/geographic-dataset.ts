import { codedRef, memberIdentity } from "./coordinate";
import { assertBound, assertId, UDC_LIMITS, UdcError } from "./limits";
import type { QueryResult } from "./query-types";
import type {
  CodedMemberRef,
  Codelist,
  Concordance,
  DatasetSnapshot,
  Dimension,
  Member,
} from "./types";

export type GeometryIdentifier =
  | { kind: "id" }
  | { kind: "property"; property: string };

export interface GeometryCollectionMapping {
  /** "features" for GeoJSON; a named objects entry for TopoJSON. */
  collection: string;
  dimension: Dimension;
  codelist: Codelist;
  identifier: GeometryIdentifier;
}

export interface GeographicDatasetSchema {
  id: string;
  revision: string;
  format: "geojson" | "topojson";
  collections: readonly GeometryCollectionMapping[];
}

/** Index into the original immutable document, not decoded geometry. */
export interface GeometryReference {
  collection: string;
  index: number;
}

export interface GeographicDiagnostic extends GeometryReference {
  kind:
    | "missing-identifier"
    | "invalid-identifier"
    | "unmapped"
    | "conflict"
    | "duplicate-code"
    | "duplicate-member";
  reason: string;
  code?: string;
}

export interface GeographicMemberGeometry extends GeometryReference {
  source: CodedMemberRef;
  member: Member;
  mappingRevisions: readonly string[];
}

export interface CanonicalGeometryCollection {
  collection: string;
  dimension: Dimension;
  geometries: readonly GeographicMemberGeometry[];
}

export interface CanonicalGeographicDataset {
  snapshot: DatasetSnapshot & { revision: string };
  schemaId: string;
  schemaRevision: string;
  format: GeographicDatasetSchema["format"];
  concordanceRevision: string;
  collections: readonly CanonicalGeometryCollection[];
  diagnostics: readonly GeographicDiagnostic[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function own(value: Record<string, unknown> | undefined, key: string): unknown {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}

/** Validate mapping metadata, without traversing or interpreting coordinates. */
export function validateGeographicDatasetSchema(
  schema: GeographicDatasetSchema,
): void {
  if (!record(schema))
    throw new UdcError("INVALID", "Invalid geographic schema");
  assertId(schema.id, "geographic schema");
  assertId(schema.revision, "geographic schema revision");
  if (schema.format !== "geojson" && schema.format !== "topojson")
    throw new UdcError("INVALID", "Unsupported geographic format");
  if (!Array.isArray(schema.collections) || !schema.collections.length)
    throw new UdcError("INVALID", "Missing geometry collections");
  assertBound(schema.collections.length, UDC_LIMITS.columns, "collections");
  const seen = new Set<string>();
  for (const mapping of schema.collections as readonly GeometryCollectionMapping[]) {
    if (!record(mapping) || !record(mapping.dimension) || !record(mapping.codelist))
      throw new UdcError("INVALID", "Invalid geometry collection mapping");
    if (typeof mapping.collection !== "string" || !mapping.collection.trim())
      throw new UdcError("INVALID", "Missing collection name");
    if (schema.format === "geojson" && mapping.collection !== "features")
      throw new UdcError("INVALID", "GeoJSON collection must be features");
    if (seen.has(mapping.collection))
      throw new UdcError("DUPLICATE", "Duplicate geometry collection mapping");
    seen.add(mapping.collection);
    assertId(mapping.dimension.id, "dimension");
    assertId(mapping.codelist.id, "codelist");
    assertId(mapping.codelist.revision, "codelist revision");
    if (typeof mapping.dimension.name !== "string" || !mapping.dimension.name.trim())
      throw new UdcError("INVALID", "Missing dimension name");
    const accessor = mapping.identifier;
    if (!record(accessor) ||
      (accessor.kind !== "id" &&
        (accessor.kind !== "property" ||
          typeof accessor.property !== "string" ||
          !accessor.property.trim())))
      throw new UdcError("INVALID", "Invalid geometry identifier accessor");
  }
}

function collectionEntries(
  document: Record<string, unknown>,
  format: GeographicDatasetSchema["format"],
  collection: string,
): readonly unknown[] {
  if (format === "geojson") {
    if (document.type !== "FeatureCollection" || !Array.isArray(document.features))
      throw new UdcError("INVALID", "Expected GeoJSON FeatureCollection");
    return document.features;
  }
  if (document.type !== "Topology")
    throw new UdcError("INVALID", "Expected TopoJSON Topology");
  const object = record(own(record(document.objects), collection));
  if (!object)
    throw new UdcError("INVALID", "Missing TopoJSON object: " + collection);
  if (object.type === "GeometryCollection") {
    if (!Array.isArray(object.geometries))
      throw new UdcError("INVALID", "Invalid TopoJSON GeometryCollection");
    return object.geometries;
  }
  return [object];
}

/** Resolve only semantic identity. Geometry coordinates/arcs remain opaque. */
export function canonicalizeGeographicDataset(
  document: unknown,
  schema: GeographicDatasetSchema,
  snapshot: DatasetSnapshot & { revision: string },
  concordance: Concordance,
): CanonicalGeographicDataset {
  validateGeographicDatasetSchema(schema);
  assertId(snapshot.datasetId, "dataset");
  assertId(snapshot.revision, "dataset revision");
  assertId(concordance.revision, "concordance revision");
  const root = record(document);
  if (!root) throw new UdcError("INVALID", "Invalid geographic document");
  const diagnostics: GeographicDiagnostic[] = [];
  let total = 0;
  const collections = schema.collections.map((mapping) => {
    const entries = collectionEntries(root, schema.format, mapping.collection);
    total += entries.length;
    assertBound(total, UDC_LIMITS.coverageContributions, "geometry entries");
    const geometries: GeographicMemberGeometry[] = [];
    const codes = new Set<string>();
    const members = new Set<string>();
    entries.forEach((entry, index) => {
      const reference = { collection: mapping.collection, index };
      const report = (
        kind: GeographicDiagnostic["kind"],
        reason: string,
        code?: string,
      ) => diagnostics.push({ ...reference, kind, reason, ...(code === undefined ? {} : { code }) });
      const object = record(entry);
      if (!object || (schema.format === "geojson"
        ? object.type !== "Feature"
        : typeof object.type !== "string"))
        throw new UdcError("INVALID", "Invalid geometry entry");
      const accessor = mapping.identifier;
      const raw = accessor.kind === "id"
        ? own(object, "id")
        : own(record(own(object, "properties")), accessor.property);
      if (raw === undefined || raw === null || raw === "") {
        report("missing-identifier", "Missing geographic identifier");
        return;
      }
      // Never coerce strings to numbers: leading zeros are significant.
      const code = typeof raw === "string" ? raw :
        typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : undefined;
      if (code === undefined) {
        report("invalid-identifier", "Expected string or safe integer identifier");
        return;
      }
      let source: CodedMemberRef;
      try {
        source = codedRef(mapping.dimension.id, mapping.codelist.id, mapping.codelist.revision, code);
      } catch (error) {
        if (!(error instanceof UdcError)) throw error;
        report("invalid-identifier", error.message, code);
        return;
      }
      if (codes.has(code)) report("duplicate-code", "Repeated source code", code);
      codes.add(code);
      const resolution = concordance.resolve(source);
      if (resolution.status !== "resolved") {
        report(resolution.status === "conflict" ? "conflict" : "unmapped", resolution.reason, code);
        return;
      }
      if (resolution.member.dimensionId !== mapping.dimension.id)
        throw new UdcError("INCOMPATIBLE", "Wrong canonical dimension");
      const key = memberIdentity(resolution.member);
      if (members.has(key))
        report("duplicate-member", "Multiple geometries for canonical member", code);
      members.add(key);
      geometries.push({
        ...reference,
        source,
        member: { ...resolution.member },
        mappingRevisions: [...resolution.mappingRevisions].sort(),
      });
    });
    return { collection: mapping.collection, dimension: { ...mapping.dimension }, geometries };
  });
  return {
    snapshot: { ...snapshot },
    schemaId: schema.id,
    schemaRevision: schema.revision,
    format: schema.format,
    concordanceRevision: concordance.revision,
    collections,
    diagnostics,
  };
}

type QueryObservation = QueryResult["observations"][number];

export interface GeographicQueryAssociation {
  geography: CanonicalGeographicDataset;
  collection: string;
  rows: readonly {
    observation: QueryObservation;
    geometries: readonly GeographicMemberGeometry[];
  }[];
  /** Resolved geometries without any matching query observation. */
  unmatchedGeometries: readonly GeographicMemberGeometry[];
}

/** Left-preserving association with an explicit reverse coverage report.
 * Repeated observations (e.g. years) reuse the same member's geometry list.
 * Duplicate geometries are retained, never guessed or implicitly dissolved.
 */
export function associateGeographicQuery(
  result: QueryResult,
  geography: CanonicalGeographicDataset,
  collection: string,
): GeographicQueryAssociation {
  const selected = geography.collections.find((item) => item.collection === collection);
  if (!selected)
    throw new UdcError("INVALID", "Unknown geometry collection");
  if (!result.dimensions.some((dimension) => dimension.id === selected.dimension.id))
    throw new UdcError("INCOMPATIBLE", "Query does not retain geographic dimension");
  const byMember = new Map<string, GeographicMemberGeometry[]>();
  for (const geometry of selected.geometries) {
    const key = memberIdentity(geometry.member);
    let group = byMember.get(key);
    if (!group) byMember.set(key, (group = []));
    group.push(geometry);
  }
  const matched = new Set<string>();
  let total = 0;
  const rows = result.observations.map((observation) => {
    const member = observation.coordinate.members.find((m) => m.dimensionId === selected.dimension.id);
    if (!member || member.kind !== "canonical")
      throw new UdcError("INCOMPATIBLE", "Missing canonical geographic member");
    const key = memberIdentity(member);
    const geometries = byMember.get(key) ?? [];
    matched.add(key);
    total += geometries.length;
    assertBound(total, UDC_LIMITS.coverageContributions, "geometry associations");
    return { observation, geometries };
  });
  return {
    geography,
    collection,
    rows,
    unmatchedGeometries: selected.geometries.filter((geometry) => !matched.has(memberIdentity(geometry.member))),
  };
}
