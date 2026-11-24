import type {
  AggregatedCube,
  AggregatedMeasureValue,
  CanonicalCube,
  MeasureDefinition,
  MeasureProvenance,
  MeasureValue,
  Member,
  SparseIntegratedCube,
} from "./types";
import type { Hierarchy } from "./hierarchy";
import { aggregateByCoordinate } from "./aggregate-cube";
import { assertBound, assertId, UDC_LIMITS, UdcError } from "./limits";

type QueryCube = CanonicalCube | AggregatedCube | SparseIntegratedCube;
export interface DiceSelection {
  dimensionId: string;
  memberIds: readonly string[];
}

function queryCube(cube: QueryCube): void {
  if (!cube || !["canonical", "aggregated", "sparse-integrated"].includes(cube.stage))
    throw new UdcError("INCOMPATIBLE", "Expected a canonical query cube");
  assertBound(cube.observations.length, UDC_LIMITS.rows, "input observations");
  assertBound(cube.measures.length, UDC_LIMITS.columns, "input measures");
}

/** OR within each selection, AND across dimensions; preserve the input grain. */
export function diceCube<T extends QueryCube>(
  cube: T,
  selections: readonly DiceSelection[],
): T {
  queryCube(cube);
  if (!Array.isArray(selections))
    throw new UdcError("INVALID", "Invalid dice selections");
  assertBound(selections.length, UDC_LIMITS.columns, "dice dimensions");
  const byDimension = new Map<string, Set<string>>();
  for (const selection of selections) {
    assertId(selection.dimensionId, "dice dimension");
    if (!cube.dimensions.some((d) => d.id === selection.dimensionId))
      throw new UdcError("INCOMPATIBLE", "Unknown dice dimension");
    if (byDimension.has(selection.dimensionId))
      throw new UdcError("DUPLICATE", "Duplicate dice dimension");
    if (!Array.isArray(selection.memberIds))
      throw new UdcError("INVALID", "Invalid dice members");
    assertBound(selection.memberIds.length, UDC_LIMITS.rows, "dice members");
    const ids = new Set<string>();
    for (const id of selection.memberIds) {
      assertId(id, "dice member");
      ids.add(id);
    }
    byDimension.set(selection.dimensionId, ids);
  }
  const observations = cube.observations.filter((observation) =>
    [...byDimension].every(([dimension, ids]) =>
      observation.coordinate.members.some(
        (member) => member.dimensionId === dimension && ids.has(member.id),
      ),
    ),
  );
  return { ...cube, observations } as T;
}

/** Roll up to an explicit disjoint cut of a versioned hierarchy. */
export function rollupCube(
  cube: CanonicalCube | AggregatedCube,
  hierarchy: Hierarchy,
  targetMembers: readonly string[],
): AggregatedCube {
  queryCube(cube);
  if (cube.stage !== "canonical" && cube.stage !== "aggregated")
    throw new UdcError("INCOMPATIBLE", "Sparse roll-up requires a missingness policy");
  if (!cube.dimensions.some((d) => d.id === hierarchy.dimensionId))
    throw new UdcError("INCOMPATIBLE", "Hierarchy dimension not in cube");
  if (!Array.isArray(targetMembers) || targetMembers.length === 0)
    throw new UdcError("INVALID", "Expected explicit roll-up targets");
  assertBound(targetMembers.length, UDC_LIMITS.rows, "roll-up targets");
  const edges = new Map(hierarchy.edges.map((edge) => [edge.child.id, edge]));
  const known = new Set(hierarchy.edges.flatMap((edge) => [edge.child.id, edge.parent.id]));
  const targets = new Set<string>();
  for (const target of targetMembers) {
    assertId(target, "roll-up target");
    if (!known.has(target))
      throw new UdcError("UNRESOLVED", "Unknown roll-up target");
    if (targets.has(target))
      throw new UdcError("DUPLICATE", "Duplicate roll-up target");
    targets.add(target);
  }
  let traversal = 0;
  const path = (id: string): Member[] => {
    const result: Member[] = [];
    const seen = new Set<string>([id]);
    let current = id;
    while (edges.has(current)) {
      const parent = edges.get(current)!.parent;
      assertBound(++traversal, UDC_LIMITS.rows * 100, "hierarchy traversal");
      if (seen.has(parent.id))
        throw new UdcError("CONFLICT", "Cyclic hierarchy");
      seen.add(parent.id);
      result.push(parent);
      current = parent.id;
    }
    return result;
  };
  for (const target of targets) {
    if (path(target).some((ancestor) => targets.has(ancestor.id)))
      throw new UdcError("CONFLICT", "Overlapping roll-up targets");
  }
  const observed = new Set<string>();
  for (const observation of cube.observations) {
    const member = observation.coordinate.members.find(
      (m) => m.dimensionId === hierarchy.dimensionId,
    );
    if (!member)
      throw new UdcError("INCOMPATIBLE", "Missing hierarchy axis");
    observed.add(member.id);
  }
  const mapped = new Map<string, Member>();
  const used = new Set<string>();
  for (const id of observed) {
    if (!known.has(id))
      throw new UdcError("UNRESOLVED", "Member absent from hierarchy");
    const ancestors = path(id);
    if (ancestors.some((ancestor) => observed.has(ancestor.id)))
      throw new UdcError("CONFLICT", "Mixed ancestor and descendant grain");
    const target = targets.has(id)
      ? { kind: "canonical" as const, dimensionId: hierarchy.dimensionId, id }
      : ancestors.find((ancestor) => targets.has(ancestor.id));
    if (!target)
      throw new UdcError("UNRESOLVED", "Member has no selected roll-up target");
    mapped.set(id, target);
    let current = id;
    while (current !== target.id) {
      used.add(current);
      current = edges.get(current)!.parent.id;
    }
  }
  const result = aggregateByCoordinate(
    cube,
    cube.dimensions.map((dimension) => dimension.id),
    (member) =>
      member.dimensionId === hierarchy.dimensionId ? mapped.get(member.id)! : member,
  );
  const prior = cube.stage === "aggregated" ? cube.hierarchyRollups ?? [] : [];
  assertBound(prior.length + 1, UDC_LIMITS.columns, "roll-up history");
  return {
    ...result,
    hierarchyRollups: [
      ...prior,
      {
        key: hierarchy.key,
        dimensionId: hierarchy.dimensionId,
        revision: hierarchy.revision,
        edition: hierarchy.edition,
        edges: hierarchy.edges.filter((edge) => used.has(edge.child.id)),
      },
    ],
  };
}

export type MeasureExpression =
  | { kind: "measure"; measureId: string }
  | { kind: "constant"; value: number }
  | {
      kind: "binary";
      operator: "+" | "-" | "*" | "/";
      left: MeasureExpression;
      right: MeasureExpression;
    };

export interface CalculatedMeasureDefinition {
  id: string;
  name: string;
  unit: string;
  expression: MeasureExpression;
}
export interface CalculatedMeasureValue {
  value: number | null;
  inputs: readonly {
    measureId: string;
    contributors: readonly MeasureProvenance[];
  }[];
}
export interface CalculatedObservation {
  coordinate: CanonicalCube["observations"][number]["coordinate"];
  cellKey: string;
  values: Readonly<Partial<Record<string, MeasureValue | AggregatedMeasureValue | CalculatedMeasureValue>>>;
  presence?: { left: boolean; right: boolean };
}
/** Terminal calculation stage: never silently aggregate a derived ratio. */
export interface CalculatedCube extends Omit<AggregatedCube, "stage" | "observations"> {
  stage: "calculated";
  inputStage: QueryCube["stage"];
  definition: CalculatedMeasureDefinition;
  observations: readonly CalculatedObservation[];
  join?: SparseIntegratedCube["join"];
}

export function calculateMeasure(
  cube: QueryCube,
  definition: CalculatedMeasureDefinition,
): CalculatedCube {
  queryCube(cube);
  assertId(definition.id, "calculated measure");
  assertId(definition.unit, "calculated unit");
  if (typeof definition.name !== "string" || !definition.name.trim())
    throw new UdcError("INVALID", "Missing calculated measure name");
  const measures = new Set(cube.measures.map((measure) => measure.id));
  if (measures.has(definition.id))
    throw new UdcError("CONFLICT", "Calculated measure already exists");
  assertBound(cube.measures.length + 1, UDC_LIMITS.columns, "output measures");
  const references = new Set<string>();
  let nodes = 0;
  function validate(expr: MeasureExpression, depth: number): void {
    assertBound(depth, 32, "expression depth");
    assertBound(++nodes, 100, "expression nodes");
    if (!expr || typeof expr !== "object")
      throw new UdcError("INVALID", "Invalid expression");
    if (expr.kind === "constant") {
      if (!Number.isFinite(expr.value))
        throw new UdcError("INVALID", "Non-finite constant");
    } else if (expr.kind === "measure") {
      assertId(expr.measureId, "expression measure");
      if (!measures.has(expr.measureId))
        throw new UdcError("UNRESOLVED", "Unknown expression measure");
      references.add(expr.measureId);
    } else if (expr.kind === "binary" && ["+", "-", "*", "/"].includes(expr.operator)) {
      validate(expr.left, depth + 1);
      validate(expr.right, depth + 1);
    } else {
      throw new UdcError("INVALID", "Invalid expression operator");
    }
  }
  validate(definition.expression, 1);
  const ids = [...references].sort();
  const measure: MeasureDefinition = {
    id: definition.id,
    name: definition.name,
    unit: definition.unit,
    aggregation: "none",
  };
  const observations: CalculatedObservation[] = cube.observations.map((observation) => {
    const values = observation.values;
    const inputs: { measureId: string; contributors: readonly MeasureProvenance[] }[] = [];
    let absent = false;
    for (const id of ids) {
      const value = Object.hasOwn(values, id) ? values[id] : undefined;
      if (!value) {
        if (cube.stage !== "sparse-integrated")
          throw new UdcError("INCOMPATIBLE", "Missing input measure");
        absent = true;
      } else {
        inputs.push({
          measureId: id,
          contributors: "contributors" in value ? value.contributors : [value.provenance],
        });
      }
    }
    if (absent) return { ...observation };
    function evaluate(expr: MeasureExpression): number | null {
      if (expr.kind === "constant") return expr.value;
      if (expr.kind === "measure") return values[expr.measureId]!.value;
      const a = evaluate(expr.left);
      const b = evaluate(expr.right);
      if (a === null || b === null || (expr.operator === "/" && b === 0)) return null;
      const result = expr.operator === "+" ? a + b
        : expr.operator === "-" ? a - b
        : expr.operator === "*" ? a * b : a / b;
      if (!Number.isFinite(result))
        throw new UdcError("LIMIT", "Calculated value overflow");
      return result;
    }
    return {
      ...observation,
      values: {
        ...values,
        [definition.id]: { value: evaluate(definition.expression), inputs },
      },
    };
  });
  return {
    ...cube,
    stage: "calculated",
    inputStage: cube.stage,
    definition: JSON.parse(JSON.stringify(definition)) as CalculatedMeasureDefinition,
    measures: [...cube.measures, measure],
    observations,
  };
}
