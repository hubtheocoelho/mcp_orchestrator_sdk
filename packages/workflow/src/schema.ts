import { z } from "zod";

/** Policy applied when a step fails: fail the run, skip silently, retry, or continue with failure reported at end. */
export const onFailureSchema = z.enum(["fail", "skip", "retry", "continue"]).default("fail");

/** Retry configuration for steps with `on_failure: "retry"`. */
export const retrySchema = z.object({
  max: z.number().int().positive().default(1),
  /** Milliseconds to wait between attempts. */
  delayMs: z.number().int().nonnegative().default(0),
});

/** Tool id recorded for `needs_input` steps, which call no tool. */
export const NEEDS_INPUT_TOOL = "workflow.needs_input";

/**
 * A request for input from whoever drives the run (typically the LLM behind an
 * MCP client). `schema` is a flat JSON Schema object (`type: "object"` with
 * primitive `properties`), the shape MCP elicitation accepts.
 */
export const inputRequestSchema = z.object({
  message: z.string().min(1),
  schema: z.record(z.unknown()).optional(),
});

const workflowStepObjectSchema = z.object({
  id: z.string().min(1),
  /**
   * Tool id to invoke. When parallel tools are specified, this acts as the
   * primary tool or identifier. Optional only on `needs_input` steps.
   */
  tool: z.string().min(1).optional(),
  /**
   * Pause the run and ask for input instead of calling a tool. The accepted
   * input becomes the step's output (`steps.<id>.output`).
   */
  needs_input: inputRequestSchema.optional(),
  /** Parameters, possibly containing `${...}` interpolation templates. */
  params: z.record(z.unknown()).default({}),
  /** Only run the step when this expression is truthy. */
  when: z.string().optional(),
  /** After the step, stop the workflow early when this expression is truthy. */
  stop_when: z.string().optional(),
  on_failure: onFailureSchema,
  /** Alias / unified nomenclature for on_failure ("fail" | "skip" | "retry" | "continue"). */
  onError: onFailureSchema.optional(),
  /** Parallel tool ids to invoke simultaneously during this step. */
  parallel: z.array(z.string()).optional(),
  retry: retrySchema.optional(),
});

/** A single workflow step: call one tool (or parallel tools), or ask for input, gated by optional conditions. */
export const workflowStepSchema = workflowStepObjectSchema
  .refine((step) => step.tool !== undefined || step.needs_input !== undefined, {
    message: "A step needs a tool or needs_input",
    path: ["tool"],
  })
  .refine((step) => !(step.needs_input && step.parallel?.length), {
    message: "A needs_input step cannot declare parallel tools",
    path: ["parallel"],
  })
  .transform((step) => ({ ...step, tool: step.tool ?? NEEDS_INPUT_TOOL }));

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

export type OnFailure = z.infer<typeof onFailureSchema>;
export type RetryConfig = z.infer<typeof retrySchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type InputRequest = z.infer<typeof inputRequestSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** The unvalidated shape accepted by `define`/`validate` before parsing. */
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;
