import type {
  AggregatedCube,
  CanonicalCube,
  Member,
  SparseIntegratedCube,
} from "./types";
import type { Hierarchy } from "./hierarchy";
import { getCellKey } from "./coordinate";
import { diceCube, rollupCube, type CalculatedCube } from "./olap";
import { assertBound, assertId, UDC_LIMITS, UdcError } from "./limits";

export type AnalyticalCube =
  CanonicalCube | AggregatedCube | SparseIntegratedCube | CalculatedCube;
type Observation = AnalyticalCube["observations"][number];
const stable = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function validateCube(cube: AnalyticalCube): void {
  if (
    !cube ||
    !["canonical", "aggregated", "sparse-integrated", "calculated"].includes(
      cube.stage,
    )
  )
    throw new UdcError("INCOMPATIBLE", "Expected a canonical analytical cube");
  assertBound(cube.observations.length, UDC_LIMITS.rows, "input observations");
  assertBound(cube.dimensions.length, UDC_LIMITS.columns, "input dimensions");
  assertBound(cube.measures.length, UDC_LIMITS.columns, "input measures");
}

function checkMeasure(cube: AnalyticalCube, id: string): void {
  assertId(id, "measure");
  if (!cube.measures.some((measure) => measure.id === id))
    throw new UdcError("UNRESOLVED", "Unknown measure");
}

function valueAt(
  observation: Observation,
  id: string,
): number | null | undefined {
  if (!Object.hasOwn(observation.values, id)) return undefined;
  const value = observation.values[id]?.value;
  if (value !== null && !Number.isFinite(value))
    throw new UdcError("INVALID", "Invalid numeric measure value");
  return value;
}

/** Expand one parent from supplied finer-grained data, never from its total. */
export function drilldownCube(
  cube: CanonicalCube | AggregatedCube,
  hierarchy: Hierarchy,
  parentMemberId: string,
): AggregatedCube {
  validateCube(cube);
  if (cube.stage !== "canonical" && cube.stage !== "aggregated")
    throw new UdcError(
      "INCOMPATIBLE",
      "Drill-down requires dense finer-grained observations",
    );
  assertId(parentMemberId, "drill-down parent");
  if (
    !cube.dimensions.some((dimension) => dimension.id === hierarchy.dimensionId)
  )
    throw new UdcError("INCOMPATIBLE", "Hierarchy dimension not in cube");
  if (
    cube.stage === "aggregated" &&
    cube.hierarchyRollups?.some(
      (history) =>
        history.dimensionId === hierarchy.dimensionId &&
        (history.key !== hierarchy.key ||
          history.revision !== hierarchy.revision ||
          history.edition !== hierarchy.edition),
    )
  )
    throw new UdcError("INCOMPATIBLE", "Incompatible hierarchy history");
  assertBound(hierarchy.edges.length, UDC_LIMITS.rows, "hierarchy edges");
  const byParent = new Map<string, Member[]>();
  const known = new Set<string>();
  for (const edge of hierarchy.edges) {
    known.add(edge.child.id);
    known.add(edge.parent.id);
    const children = byParent.get(edge.parent.id) ?? [];
    children.push(edge.child);
    byParent.set(edge.parent.id, children);
  }
  if (!known.has(parentMemberId))
    throw new UdcError("UNRESOLVED", "Unknown drill-down parent");
  const children = byParent.get(parentMemberId) ?? [];
  if (children.length === 0)
    throw new UdcError("INCOMPATIBLE", "Cannot drill down a leaf");
  const descendants = new Set<string>();
  const pending = children.map((child) => child.id);
  while (pending.length) {
    const id = pending.pop()!;
    if (id === parentMemberId || descendants.has(id))
      throw new UdcError("CONFLICT", "Invalid hierarchy traversal");
    descendants.add(id);
    assertBound(descendants.size, UDC_LIMITS.rows, "hierarchy descendants");
    for (const child of byParent.get(id) ?? []) pending.push(child.id);
  }
  const ancestors = new Set(
    hierarchy.ancestors(parentMemberId).map((member) => member.id),
  );
  for (const observation of cube.observations) {
    const member = observation.coordinate.members.find(
      (m) => m.dimensionId === hierarchy.dimensionId,
    );
    if (!member || !known.has(member.id))
      throw new UdcError("UNRESOLVED", "Observation missing from hierarchy");
    if (member.id === parentMemberId || ancestors.has(member.id))
      throw new UdcError(
        "INCOMPATIBLE",
        "Parent or coarser observation cannot be drilled down",
      );
  }
  const selected = diceCube(cube, [
    { dimensionId: hierarchy.dimensionId, memberIds: [...descendants] },
  ]);
  return rollupCube(
    selected,
    hierarchy,
    children.map((child) => child.id),
  );
}

export type MeasurePredicate =
  | {
      kind: "compare";
      measureId: string;
      operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      value: number;
    }
  | { kind: "range"; measureId: string; min: number; max: number }
  | { kind: "isNull" | "isAbsent"; measureId: string }
  | { kind: "and" | "or"; operands: readonly MeasurePredicate[] }
  | { kind: "not"; operand: MeasurePredicate };

type Truth = boolean | undefined;
type Evaluate = (observation: Observation) => Truth;

/** SQL-style three-valued logic: missing numeric operands are unknown. */
export function filterCube<T extends AnalyticalCube>(
  cube: T,
  predicate: MeasurePredicate,
): T {
  validateCube(cube);
  let nodes = 0;
  function compile(p: MeasurePredicate, depth: number): Evaluate {
    assertBound(depth, 32, "predicate depth");
    assertBound(++nodes, 100, "predicate nodes");
    if (!p || typeof p !== "object")
      throw new UdcError("INVALID", "Invalid predicate");
    if (p.kind === "not") {
      const evaluate = compile(p.operand, depth + 1);
      return (row) => {
        const result = evaluate(row);
        return result === undefined ? undefined : !result;
      };
    }
    if (p.kind === "and" || p.kind === "or") {
      if (!Array.isArray(p.operands) || !p.operands.length)
        throw new UdcError("INVALID", "Expected nonempty predicate operands");
      assertBound(p.operands.length, 100, "predicate operands");
      const operands = p.operands.map((operand) => compile(operand, depth + 1));
      return (row) => {
        let unknown = false;
        for (const evaluate of operands) {
          const result = evaluate(row);
          if (result === (p.kind === "or")) return result;
          if (result === undefined) unknown = true;
        }
        return unknown ? undefined : p.kind === "and";
      };
    }
    if (!("measureId" in p))
      throw new UdcError("INVALID", "Unknown predicate kind");
    const id = p.measureId;
    checkMeasure(cube, id);
    if (p.kind === "isNull") return (row) => valueAt(row, id) === null;
    if (p.kind === "isAbsent") return (row) => valueAt(row, id) === undefined;
    if (p.kind === "range") {
      const { min, max } = p;
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
        throw new UdcError("INVALID", "Invalid predicate range");
      return (row) => {
        const value = valueAt(row, id);
        return value == null ? undefined : value >= min && value <= max;
      };
    }
    if (p.kind !== "compare" || !Number.isFinite(p.value))
      throw new UdcError("INVALID", "Invalid numeric comparison");
    const { operator, value: target } = p;
    if (!["eq", "ne", "lt", "lte", "gt", "gte"].includes(operator))
      throw new UdcError("INVALID", "Unknown comparison operator");
    return (row) => {
      const value = valueAt(row, id);
      if (value == null) return undefined;
      switch (operator) {
        case "eq":
          return value === target;
        case "ne":
          return value !== target;
        case "lt":
          return value < target;
        case "lte":
          return value <= target;
        case "gt":
          return value > target;
        case "gte":
          return value >= target;
      }
    };
  }
  const evaluate = compile(predicate, 1);
  return {
    ...cube,
    observations: cube.observations.filter((row) => evaluate(row) === true),
  } as T;
}

export interface RankOptions {
  measureId: string;
  direction?: "asc" | "desc";
  partitionBy?: readonly string[];
  method?: "ordinal" | "competition" | "dense";
}
export interface RankedObservation {
  cellKey: string;
  partitionKey: string;
  value: number;
  rank: number;
}
interface RankedRow extends RankedObservation {
  observation: Observation;
}
function rankedRows(cube: AnalyticalCube, options: RankOptions): RankedRow[] {
  validateCube(cube);
  if (!options || typeof options !== "object")
    throw new UdcError("INVALID", "Missing ranking options");
  checkMeasure(cube, options.measureId);
  const direction = options.direction ?? "desc";
  const method = options.method ?? "competition";
  const partitionBy = options.partitionBy ?? [];
  if (
    !["asc", "desc"].includes(direction) ||
    !["ordinal", "competition", "dense"].includes(method) ||
    !Array.isArray(partitionBy)
  )
    throw new UdcError("INVALID", "Invalid ranking options");
  assertBound(partitionBy.length, UDC_LIMITS.columns, "partition dimensions");
  const dimensions = new Set<string>();
  for (const id of partitionBy) {
    assertId(id, "partition dimension");
    if (!cube.dimensions.some((dimension) => dimension.id === id))
      throw new UdcError("INCOMPATIBLE", "Unknown partition dimension");
    if (dimensions.has(id))
      throw new UdcError("DUPLICATE", "Duplicate partition dimension");
    dimensions.add(id);
  }
  const groups = new Map<string, RankedRow[]>();
  const seen = new Set<string>();
  for (const observation of cube.observations) {
    if (getCellKey(observation.coordinate) !== observation.cellKey)
      throw new UdcError("INVALID", "Invalid coordinate key");
    if (seen.has(observation.cellKey))
      throw new UdcError("DUPLICATE", "Duplicate observation");
    seen.add(observation.cellKey);
    const value = valueAt(observation, options.measureId);
    if (value == null) continue;
    const members = observation.coordinate.members.filter((member) =>
      dimensions.has(member.dimensionId),
    );
    if (members.length !== dimensions.size)
      throw new UdcError("INCOMPATIBLE", "Missing partition dimension");
    const partitionKey = getCellKey({ members });
    const group = groups.get(partitionKey) ?? [];
    group.push({
      cellKey: observation.cellKey,
      partitionKey,
      value,
      rank: 0,
      observation,
    });
    groups.set(partitionKey, group);
  }
  const result: RankedRow[] = [];
  for (const key of [...groups.keys()].sort(stable)) {
    const group = groups.get(key)!;
    group.sort((a, b) => {
      if (a.value === b.value) return stable(a.cellKey, b.cellKey);
      return (a.value < b.value ? -1 : 1) * (direction === "asc" ? 1 : -1);
    });
    let dense = 0;
    let competition = 0;
    for (let i = 0; i < group.length; i++) {
      const row = group[i];
      if (i === 0 || row.value !== group[i - 1].value) {
        dense++;
        competition = i + 1;
      }
      row.rank =
        method === "ordinal" ? i + 1 : method === "dense" ? dense : competition;
      result.push(row);
    }
  }
  return result;
}

/** Metadata only; rank is not an aggregatable measure. Null and absent values are unranked. */
export function rankCube(
  cube: AnalyticalCube,
  options: RankOptions,
): readonly RankedObservation[] {
  return rankedRows(cube, options).map(
    ({ cellKey, partitionKey, value, rank }) => ({
      cellKey,
      partitionKey,
      value,
      rank,
    }),
  );
}

export interface TopNOptions extends RankOptions {
  n: number;
  ties?: "exact" | "include";
}

/** Select at most N numeric observations per partition (or include cutoff ties). */
export function topNCube<T extends AnalyticalCube>(
  cube: T,
  options: TopNOptions,
): T {
  if (!options || typeof options !== "object")
    throw new UdcError("INVALID", "Missing top-N options");
  assertBound(options.n, UDC_LIMITS.rows, "top-N");
  const ties = options.ties ?? "exact";
  if (!["exact", "include"].includes(ties))
    throw new UdcError("INVALID", "Invalid cutoff tie policy");
  const rows = rankedRows(cube, options);
  let partition: string | undefined;
  let count = 0;
  let cutoff: number | undefined;
  const observations: Observation[] = [];
  for (const row of rows) {
    if (row.partitionKey !== partition) {
      partition = row.partitionKey;
      count = 0;
      cutoff = undefined;
    }
    if (count < options.n) {
      count++;
      cutoff = row.value;
      observations.push(row.observation);
    } else if (
      ties === "include" &&
      cutoff !== undefined &&
      row.value === cutoff
    ) {
      observations.push(row.observation);
    }
  }
  return { ...cube, observations } as T;
}
