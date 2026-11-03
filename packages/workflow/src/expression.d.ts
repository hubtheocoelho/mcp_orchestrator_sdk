import type { JsonObject } from "@mcp-orchestrator/core";
/** The scope expressions and templates are resolved against. */
export interface ExpressionScope {
    /** Workflow inputs, referenced as `${input.x}`. */
    readonly input: JsonObject;
    /** Completed step outputs, referenced as `${steps.id.output}` (or `.output.field`). */
    readonly steps: Record<string, {
        output: unknown;
    }>;
}
/** Resolve a dotted path (e.g. `steps.a.output.value`) within a scope. */
export declare function resolvePath(path: string, scope: ExpressionScope): unknown;
/**
 * Interpolate a single value. A string that is *exactly* one `${...}` reference
 * resolves to the referenced value with its type preserved; a string with
 * embedded references is rebuilt with each reference stringified. Objects and
 * arrays are interpolated recursively; other values pass through untouched.
 */
export declare function interpolate(value: unknown, scope: ExpressionScope): unknown;
/** Interpolate a params object, always returning a JSON object. */
export declare function interpolateParams(params: JsonObject, scope: ExpressionScope): JsonObject;
/**
 * Evaluate a condition expression to a boolean without `eval`. Supports a bare
 * operand (truthiness) or a single binary comparison between two operands, where
 * each operand is either a `${path}` reference or a JSON-ish literal
 * (number, `"quoted"`, `true`/`false`/`null`, or a bare word).
 */
export declare function evaluateCondition(expression: string, scope: ExpressionScope): boolean;
//# sourceMappingURL=expression.d.ts.map