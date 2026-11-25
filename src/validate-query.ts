import { assertBound, assertId, UDC_LIMITS, UdcError } from "./limits";
import type { QuerySpec } from "./query-types";

type Obj = Record<string, unknown>;
const invalid = (label: string): never => { throw new UdcError("INVALID", "Invalid " + label); };
function obj(value: unknown, keys: readonly string[], label: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid(label);
  const record = value as Obj;
  if (Object.keys(record).some(key => !keys.includes(key))) return invalid(label + " field");
  return record;
}
function arr(value: unknown, limit: number, label: string): unknown[] {
  if (!Array.isArray(value)) return invalid(label);
  assertBound(value.length, limit, label);
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string") return invalid("identifier");
  assertId(value);
  return value;
}
function ids(value: unknown, limit: number, label: string, unique = true): string[] {
  const result = arr(value, limit, label).map(id);
  if (unique && new Set(result).size !== result.length) throw new UdcError("DUPLICATE", "Duplicate " + label);
  return result;
}
function oneOf(value: unknown, options: readonly string[]): void {
  if (typeof value !== "string" || !options.includes(value)) invalid("operator or policy");
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return invalid("numeric literal");
  return value;
}

/** Validate untrusted JSON before catalog resolution. Also collects semantic dependencies. */
export function validateQuery(value: unknown): asserts value is QuerySpec {
  const q = obj(value, ["version", "dimensions", "measures", "filters", "rollups", "calculatedMeasures", "measureFilter", "join", "joinAnchor", "topN"], "query");
  if (q.version !== 1) invalid("query version");
  ids(q.dimensions, UDC_LIMITS.columns, "output dimensions");
  if (!ids(q.measures, UDC_LIMITS.columns, "output measures").length) invalid("empty measures");
  if (q.filters !== undefined) {
    const seen = new Set<string>();
    for (const item of arr(q.filters, UDC_LIMITS.columns, "dimension filters")) {
      const f = obj(item, ["dimensionId", "memberIds"], "dimension filter");
      const dim = id(f.dimensionId);
      if (seen.has(dim)) throw new UdcError("DUPLICATE", "Duplicate dimension filter");
      seen.add(dim);
      ids(f.memberIds, UDC_LIMITS.rows, "members", false);
    }
  }
  if (q.rollups !== undefined) {
    const seen = new Set<string>();
    for (const item of arr(q.rollups, UDC_LIMITS.columns, "rollups")) {
      const rollup = obj(item, ["hierarchyKey", "revision", "targetMembers"], "rollup");
      const key = id(rollup.hierarchyKey);
      if (seen.has(key)) throw new UdcError("DUPLICATE", "Duplicate rollup hierarchy");
      seen.add(key);
      id(rollup.revision);
      if (!ids(rollup.targetMembers, UDC_LIMITS.rows, "rollup targets").length) invalid("empty rollup targets");
    }
  }
  let nodes = 0;
  function expression(value: unknown, depth: number): void {
    assertBound(depth, 32, "expression depth");
    assertBound(++nodes, 100, "expression nodes");
    const e = obj(value, ["kind", "operator", "left", "right", "measureId", "value"], "expression");
    switch (e.kind) {
      case "measure": obj(e, ["kind", "measureId"], "measure reference"); id(e.measureId); break;
      case "constant": obj(e, ["kind", "value"], "constant"); finite(e.value); break;
      case "binary":
        obj(e, ["kind", "operator", "left", "right"], "binary expression");
        oneOf(e.operator, ["+", "-", "*", "/"]);
        expression(e.left, depth + 1); expression(e.right, depth + 1); break;
      default: invalid("expression kind");
    }
  }
  if (q.calculatedMeasures !== undefined) {
    for (const item of arr(q.calculatedMeasures, 1, "calculated measures")) {
      const d = obj(item, ["id", "name", "unit", "expression"], "calculated measure");
      id(d.id); id(d.unit);
      if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 256) invalid("calculated measure name");
      expression(d.expression, 1);
    }
  }
  nodes = 0;
  function predicate(value: unknown, depth: number): void {
    assertBound(depth, 32, "predicate depth");
    assertBound(++nodes, 100, "predicate nodes");
    const p = obj(value, ["kind", "measureId", "operator", "value", "min", "max", "operand", "operands"], "predicate");
    switch (p.kind) {
      case "compare":
        obj(p, ["kind", "measureId", "operator", "value"], "comparison");
        id(p.measureId); oneOf(p.operator, ["eq", "ne", "lt", "lte", "gt", "gte"]); finite(p.value); break;
      case "range":
        obj(p, ["kind", "measureId", "min", "max"], "range");
        id(p.measureId); if (finite(p.min) > finite(p.max)) invalid("range bounds"); break;
      case "isNull": case "isAbsent":
        obj(p, ["kind", "measureId"], "presence predicate"); id(p.measureId); break;
      case "and": case "or": {
        obj(p, ["kind", "operands"], "boolean predicate");
        const children = arr(p.operands, 100, "predicate operands");
        if (!children.length) invalid("empty predicate");
        for (const child of children) predicate(child, depth + 1);
        break;
      }
      case "not": obj(p, ["kind", "operand"], "negation"); predicate(p.operand, depth + 1); break;
      default: invalid("predicate kind");
    }
  }
  if (q.measureFilter !== undefined) predicate(q.measureFilter, 1);
  if (q.join !== undefined) oneOf(q.join, ["inner", "left", "right", "full"]);
  if (q.join === "left" || q.join === "right") id(q.joinAnchor);
  else if (q.joinAnchor !== undefined) invalid("join anchor without directional join");
  if (q.topN !== undefined) {
    const t = obj(q.topN, ["measureId", "n", "direction", "partitionBy", "method", "ties"], "top-N");
    id(t.measureId);
    if (typeof t.n !== "number") invalid("top-N count");
    assertBound(t.n as number, UDC_LIMITS.rows, "top-N");
    if (t.direction !== undefined) oneOf(t.direction, ["asc", "desc"]);
    if (t.method !== undefined) oneOf(t.method, ["ordinal", "competition", "dense"]);
    if (t.ties !== undefined) oneOf(t.ties, ["exact", "include"]);
    if (t.partitionBy !== undefined) ids(t.partitionBy, UDC_LIMITS.columns, "ranking partitions");
  }
}
