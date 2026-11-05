import type { JsonObject } from "@mcp-orchestrator/core";

/** The scope expressions and templates are resolved against. */
export interface ExpressionScope {
  /** Workflow inputs, referenced as `${input.x}`. */
  readonly input: JsonObject;
  /**
   * Completed step outputs, referenced as `${steps.id.output}` (or `.output.field`).
   * Steps that failed under the `continue` policy also carry `error` (and any partial
   * output, e.g. from parallel tools).
   */
  readonly steps: Record<string, { output: unknown; error?: string }>;
}

const FULL_REF = /^\$\{([^}]+)\}$/;
const EMBEDDED_REF = /\$\{([^}]+)\}/g;

/** Resolve a dotted path (e.g. `steps.a.output.value`) within a scope. */
export function resolvePath(path: string, scope: ExpressionScope): unknown {
  const segments = path.trim().split(".");
  let current: unknown = scope;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Interpolate a single value. A string that is *exactly* one `${...}` reference
 * resolves to the referenced value with its type preserved; a string with
 * embedded references is rebuilt with each reference stringified. Objects and
 * arrays are interpolated recursively; other values pass through untouched.
 */
export function interpolate(value: unknown, scope: ExpressionScope): unknown {
  if (typeof value === "string") {
    const full = value.match(FULL_REF);
    if (full) return resolvePath(full[1] as string, scope);
    return value.replace(EMBEDDED_REF, (_, path: string) => {
      const resolved = resolvePath(path, scope);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, scope));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = interpolate(item, scope);
    return out;
  }
  return value;
}

/** Interpolate a params object, always returning a JSON object. */
export function interpolateParams(params: JsonObject, scope: ExpressionScope): JsonObject {
  return interpolate(params, scope) as JsonObject;
}

type Comparator = "==" | "!=" | ">=" | "<=" | ">" | "<";
const COMPARISON = /^(.*?)(==|!=|>=|<=|>|<)(.*)$/;

/**
 * Evaluate a condition expression to a boolean without `eval`. Supports a bare
 * operand (truthiness) or a single binary comparison between two operands, where
 * each operand is either a `${path}` reference or a JSON-ish literal
 * (number, `"quoted"`, `true`/`false`/`null`, or a bare word).
 */
export function evaluateCondition(expression: string, scope: ExpressionScope): boolean {
  const match = expression.match(COMPARISON);
  if (match) {
    const left = resolveOperand((match[1] as string).trim(), scope);
    const op = match[2] as Comparator;
    const right = resolveOperand((match[3] as string).trim(), scope);
    return compare(left, op, right);
  }
  return isTruthy(resolveOperand(expression.trim(), scope));
}

function resolveOperand(token: string, scope: ExpressionScope): unknown {
  const full = token.match(FULL_REF);
  if (full) return resolvePath(full[1] as string, scope);
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (/^"(.*)"$/.test(token) || /^'(.*)'$/.test(token)) return token.slice(1, -1);
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  return token;
}

function compare(left: unknown, op: Comparator, right: unknown): boolean {
  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return Number(left) > Number(right);
    case "<":
      return Number(left) < Number(right);
    case ">=":
      return Number(left) >= Number(right);
    case "<=":
      return Number(left) <= Number(right);
  }
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}
