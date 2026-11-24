import type { CodedMemberRef, DatasetSnapshot, Member } from "./types";
import { memberIdentity } from "./coordinate";
import { assertBound, assertId, UDC_LIMITS, UdcError } from "./limits";

/** Evidence for one asserted row-level parent/child relationship. */
export interface HierarchyProvenance {
  snapshot: DatasetSnapshot;
  sourceRow: number;
  /** Revision of the approved dataset hierarchy column mapping. */
  mappingRevision: string;
  /** Optional, version-pinned source codes for auditability. */
  childSource?: CodedMemberRef;
  parentSource?: CodedMemberRef;
}

export interface HierarchyEdgeInput {
  child: Member;
  parent: Member;
  provenance: HierarchyProvenance;
}

/** Identical edges are merged, preserving all distinct source evidence. */
export interface HierarchyEdge {
  child: Member;
  parent: Member;
  provenance: readonly HierarchyProvenance[];
}

export interface HierarchyDefinition {
  /** Named hierarchy, e.g. "un-m49-geography" or "naics-industry". */
  key: string;
  dimensionId: string;
  /** Immutable revision of this resolved relationship set. */
  revision: string;
  /** Source classification edition, independent of the UDC revision. */
  edition?: string;
  edges: readonly HierarchyEdgeInput[];
}

export interface Hierarchy {
  readonly key: string;
  readonly dimensionId: string;
  readonly revision: string;
  readonly edition?: string;
  readonly edges: readonly HierarchyEdge[];
  /** Returns undefined for a root or a member not present as a child. */
  parent(member: Member | string): Member | undefined;
  /** Nearest parent first; excludes the input member. */
  ancestors(member: Member | string): readonly Member[];
}

/** Navigation added by createHierarchy; legacy structural Hierarchy values remain valid. */
export interface NavigableHierarchy extends Hierarchy {
  children(member: Member | string): readonly Member[];
  /** Breadth-first, stable sibling order; excludes the input member. */
  descendants(member: Member | string): readonly Member[];
}

const stable = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function canonical(member: Member, dimensionId: string): Member {
  if (!member || typeof member !== "object" || member.kind !== "canonical")
    throw new UdcError("INVALID", "Hierarchy requires canonical members");
  memberIdentity(member);
  if (member.dimensionId !== dimensionId)
    throw new UdcError("INCOMPATIBLE", "Cross-dimension hierarchy edge");
  return { kind: "canonical", dimensionId, id: member.id };
}

function sourceRef(
  source: CodedMemberRef,
  dimensionId: string,
): CodedMemberRef {
  if (!source || typeof source !== "object" || source.kind !== "coded")
    throw new UdcError("INVALID", "Invalid hierarchy source code");
  memberIdentity(source);
  if (source.dimensionId !== dimensionId)
    throw new UdcError("INCOMPATIBLE", "Cross-dimension hierarchy source");
  return { ...source };
}

function evidence(
  input: HierarchyProvenance,
  dimensionId: string,
): HierarchyProvenance {
  if (!input || typeof input !== "object")
    throw new UdcError("INVALID", "Missing hierarchy provenance");
  if (
    !input.snapshot ||
    typeof input.snapshot !== "object" ||
    Array.isArray(input.snapshot)
  )
    throw new UdcError("INVALID", "Missing hierarchy dataset snapshot");
  assertId(input.snapshot.datasetId, "hierarchy dataset");
  for (const [field, value] of Object.entries(input.snapshot))
    if (value !== undefined) assertId(value, "snapshot " + field);
  if (!Number.isSafeInteger(input.sourceRow) || input.sourceRow < 1)
    throw new UdcError("INVALID", "Invalid hierarchy source row");
  assertId(input.mappingRevision, "hierarchy mapping revision");
  if ((input.childSource === undefined) !== (input.parentSource === undefined))
    throw new UdcError("INVALID", "Both hierarchy source codes are required");
  return {
    snapshot: { ...input.snapshot },
    sourceRow: input.sourceRow,
    mappingRevision: input.mappingRevision,
    ...(input.childSource === undefined
      ? {}
      : {
          childSource: sourceRef(input.childSource, dimensionId),
          parentSource: sourceRef(input.parentSource!, dimensionId),
        }),
  };
}

function evidenceKey(value: HierarchyProvenance): string {
  return JSON.stringify([
    Object.entries(value.snapshot).sort(([a], [b]) => stable(a, b)),
    value.sourceRow,
    value.mappingRevision,
    value.childSource ? memberIdentity(value.childSource) : null,
    value.parentSource ? memberIdentity(value.parentSource) : null,
  ]);
}

/**
 * Construct a bounded, deterministic, single-parent forest for one named
 * hierarchy of one semantic dimension. Inputs must already be approved and
 * resolved to canonical members by the caller; this function never guesses
 * identity or performs IO.
 */
export function createHierarchy(
  definition: HierarchyDefinition,
): NavigableHierarchy {
  if (!definition || typeof definition !== "object")
    throw new UdcError("INVALID", "Missing hierarchy definition");
  assertId(definition.key, "hierarchy key");
  assertId(definition.dimensionId, "hierarchy dimension");
  assertId(definition.revision, "hierarchy revision");
  if (
    definition.edition !== undefined &&
    (typeof definition.edition !== "string" ||
      definition.edition.length === 0 ||
      definition.edition.length > 120 ||
      definition.edition.trim() !== definition.edition ||
      [...definition.edition].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ))
  )
    throw new UdcError("INVALID", "Invalid hierarchy edition");
  if (!Array.isArray(definition.edges))
    throw new UdcError("INVALID", "Invalid hierarchy edges");
  assertBound(definition.edges.length, UDC_LIMITS.rows, "hierarchy edges");

  const byChild = new Map<
    string,
    {
      child: Member;
      parent: Member;
      provenance: Map<string, HierarchyProvenance>;
    }
  >();
  for (const input of definition.edges) {
    if (!input || typeof input !== "object")
      throw new UdcError("INVALID", "Invalid hierarchy edge");
    const child = canonical(input.child, definition.dimensionId);
    const parent = canonical(input.parent, definition.dimensionId);
    if (child.id === parent.id)
      throw new UdcError("CONFLICT", "Hierarchy member cannot parent itself");
    const provenance = evidence(input.provenance, definition.dimensionId);
    let edge = byChild.get(child.id);
    if (edge && edge.parent.id !== parent.id)
      throw new UdcError("CONFLICT", "Conflicting hierarchy parents");
    if (!edge) {
      edge = { child, parent, provenance: new Map() };
      byChild.set(child.id, edge);
    }
    edge.provenance.set(evidenceKey(provenance), provenance);
  }

  const parents = new Map<string, Member>();
  for (const [childId, edge] of byChild) parents.set(childId, edge.parent);

  // Iterative traversal avoids stack overflows for deep, but bounded, forests.
  const done = new Set<string>();
  const visiting = new Set<string>();
  for (const child of parents.keys()) {
    const path: string[] = [];
    let current = child;
    while (parents.has(current) && !done.has(current)) {
      if (visiting.has(current))
        throw new UdcError("CONFLICT", "Hierarchy contains a cycle");
      visiting.add(current);
      path.push(current);
      current = parents.get(current)!.id;
    }
    for (const id of path) {
      visiting.delete(id);
      done.add(id);
    }
  }

  const edges: HierarchyEdge[] = [...byChild.values()]
    .sort((a, b) => stable(a.child.id, b.child.id))
    .map((edge) => ({
      child: edge.child,
      parent: edge.parent,
      provenance: [...edge.provenance.entries()]
        .sort(([a], [b]) => stable(a, b))
        .map(([, value]) => value),
    }));

  const childrenByParent = new Map<string, Member[]>();
  for (const edge of edges) {
    const children = childrenByParent.get(edge.parent.id) ?? [];
    children.push(edge.child);
    childrenByParent.set(edge.parent.id, children);
  }
  const memberId = (member: Member | string): string => {
    if (typeof member === "string") {
      assertId(member, "hierarchy member");
      return member;
    }
    return canonical(member, definition.dimensionId).id;
  };
  return {
    key: definition.key,
    dimensionId: definition.dimensionId,
    revision: definition.revision,
    edition: definition.edition,
    edges,
    parent(member) {
      return parents.get(memberId(member));
    },
    children(member) {
      return [...(childrenByParent.get(memberId(member)) ?? [])];
    },
    descendants(member) {
      const result = [...(childrenByParent.get(memberId(member)) ?? [])];
      for (let i = 0; i < result.length; i++) {
        for (const child of childrenByParent.get(result[i].id) ?? []) {
          result.push(child);
          assertBound(result.length, UDC_LIMITS.rows, "hierarchy descendants");
        }
      }
      return result;
    },
    ancestors(member) {
      const result: Member[] = [];
      let id = memberId(member);
      while (parents.has(id)) {
        const parent = parents.get(id)!;
        result.push(parent);
        id = parent.id;
      }
      return result;
    },
  };
}
