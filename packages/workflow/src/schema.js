import { z } from "zod";
/** Policy applied when a step fails. */
export const onFailureSchema = z.enum(["fail", "skip", "retry"]).default("fail");
/** Retry configuration for steps with `on_failure: "retry"`. */
export const retrySchema = z.object({
    max: z.number().int().positive().default(1),
    /** Milliseconds to wait between attempts. */
    delayMs: z.number().int().nonnegative().default(0),
});
/** A single workflow step: call one tool, gated by optional conditions. */
export const workflowStepSchema = z.object({
    id: z.string().min(1),
    /** Tool id to invoke. */
    tool: z.string().min(1),
    /** Parameters, possibly containing `${...}` interpolation templates. */
    params: z.record(z.unknown()).default({}),
    /** Only run the step when this expression is truthy. */
    when: z.string().optional(),
    /** After the step, stop the workflow early when this expression is truthy. */
    stop_when: z.string().optional(),
    on_failure: onFailureSchema,
    retry: retrySchema.optional(),
});
/** Declaration of a single workflow input. */
export const workflowInputSchema = z.object({
    type: z.enum(["string", "number", "integer", "boolean", "object", "array", "null"]).optional(),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    description: z.string().optional(),
});
/** A complete, declarative workflow definition. */
export const workflowDefinitionSchema = z.object({
    id: z.string().min(1),
    description: z.string().optional(),
    inputs: z.record(workflowInputSchema).default({}),
    steps: z.array(workflowStepSchema).min(1),
    /** Named outputs, each an expression evaluated against the final context. */
    outputs: z.record(z.string()).default({}),
});
//# sourceMappingURL=schema.js.map