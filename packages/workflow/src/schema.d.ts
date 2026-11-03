import { z } from "zod";
/** Policy applied when a step fails. */
export declare const onFailureSchema: z.ZodDefault<z.ZodEnum<["fail", "skip", "retry"]>>;
/** Retry configuration for steps with `on_failure: "retry"`. */
export declare const retrySchema: z.ZodObject<{
    max: z.ZodDefault<z.ZodNumber>;
    /** Milliseconds to wait between attempts. */
    delayMs: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    max: number;
    delayMs: number;
}, {
    max?: number | undefined;
    delayMs?: number | undefined;
}>;
/** A single workflow step: call one tool, gated by optional conditions. */
export declare const workflowStepSchema: z.ZodObject<{
    id: z.ZodString;
    /** Tool id to invoke. */
    tool: z.ZodString;
    /** Parameters, possibly containing `${...}` interpolation templates. */
    params: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    /** Only run the step when this expression is truthy. */
    when: z.ZodOptional<z.ZodString>;
    /** After the step, stop the workflow early when this expression is truthy. */
    stop_when: z.ZodOptional<z.ZodString>;
    on_failure: z.ZodDefault<z.ZodEnum<["fail", "skip", "retry"]>>;
    retry: z.ZodOptional<z.ZodObject<{
        max: z.ZodDefault<z.ZodNumber>;
        /** Milliseconds to wait between attempts. */
        delayMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        max: number;
        delayMs: number;
    }, {
        max?: number | undefined;
        delayMs?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    params: Record<string, unknown>;
    tool: string;
    on_failure: "fail" | "skip" | "retry";
    when?: string | undefined;
    stop_when?: string | undefined;
    retry?: {
        max: number;
        delayMs: number;
    } | undefined;
}, {
    id: string;
    tool: string;
    params?: Record<string, unknown> | undefined;
    when?: string | undefined;
    stop_when?: string | undefined;
    retry?: {
        max?: number | undefined;
        delayMs?: number | undefined;
    } | undefined;
    on_failure?: "fail" | "skip" | "retry" | undefined;
}>;
/** Declaration of a single workflow input. */
export declare const workflowInputSchema: z.ZodObject<{
    type: z.ZodOptional<z.ZodEnum<["string", "number", "integer", "boolean", "object", "array", "null"]>>;
    required: z.ZodDefault<z.ZodBoolean>;
    default: z.ZodOptional<z.ZodUnknown>;
    description: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    required: boolean;
    description?: string | undefined;
    type?: "string" | "number" | "boolean" | "object" | "integer" | "array" | "null" | undefined;
    default?: unknown;
}, {
    description?: string | undefined;
    type?: "string" | "number" | "boolean" | "object" | "integer" | "array" | "null" | undefined;
    required?: boolean | undefined;
    default?: unknown;
}>;
/** A complete, declarative workflow definition. */
export declare const workflowDefinitionSchema: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    inputs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        type: z.ZodOptional<z.ZodEnum<["string", "number", "integer", "boolean", "object", "array", "null"]>>;
        required: z.ZodDefault<z.ZodBoolean>;
        default: z.ZodOptional<z.ZodUnknown>;
        description: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        required: boolean;
        description?: string | undefined;
        type?: "string" | "number" | "boolean" | "object" | "integer" | "array" | "null" | undefined;
        default?: unknown;
    }, {
        description?: string | undefined;
        type?: "string" | "number" | "boolean" | "object" | "integer" | "array" | "null" | undefined;
        required?: boolean | undefined;
        default?: unknown;
    }>>>;
    steps: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        /** Tool id to invoke. */
        tool: z.ZodString;
        /** Parameters, possibly containing `${...}` interpolation templates. */
        params: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        /** Only run the step when this expression is truthy. */
        when: z.ZodOptional<z.ZodString>;
        /** After the step, stop the workflow early when this expression is truthy. */
        stop_when: z.ZodOptional<z.ZodString>;
        on_failure: z.ZodDefault<z.ZodEnum<["fail", "skip", "retry"]>>;
        retry: z.ZodOptional<z.ZodObject<{
            max: z.ZodDefault<z.ZodNumber>;
            /** Milliseconds to wait between attempts. */
            delayMs: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            max: number;
            delayMs: number;
        }, {
            max?: number | undefined;
            delayMs?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        params: Record<string, unknown>;
        tool: string;
        on_failure: "fail" | "skip" | "retry";
        when?: string | undefined;
        stop_when?: string | undefined;
        retry?: {
            max: number;
            delayMs: number;
        } | undefined;
    }, {
        id: string;
        tool: string;
        params?: Record<string, unknown> | undefined;
        when?: string | undefined;
        stop_when?: string | undefined;
        retry?: {
            max?: number | undefined;
            delayMs?: number | undefined;
        } | undefined;
        on_failure?: "fail" | "skip" | "retry" | undefined;
    }>, "many">;
    /** Named outputs, each an expression evaluated against the final context. */
    outputs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    inputs: Record<string, {
        required: boolean;
        description?: string | undefined;
        type?: "string" | "number" | "boolean" | "object" | "integer" | "array" | "null" | undefined;
        default?: unknown;
    }>;
    steps: {
        id: string;
        params: Record<string, unknown>;
        tool: string;
        on_failure: "fail" | "skip" | "retry";
        when?: string | undefined;
        stop_when?: string | undefined;
        retry?: {
            max: number;
            delayMs: number;
        } | undefined;
    }[];
    outputs: Record<string, string>;
    description?: string | undefined;
}, {
    id: string;
    steps: {
        id: string;
        tool: string;
        params?: Record<string, unknown> | undefined;
        when?: string | undefined;
        stop_when?: string | undefined;
        retry?: {
            max?: number | undefined;
            delayMs?: number | undefined;
        } | undefined;
        on_failure?: "fail" | "skip" | "retry" | undefined;
    }[];
    description?: string | undefined;
    inputs?: Record<string, {
        description?: string | undefined;
        type?: "string" | "number" | "boolean" | "object" | "integer" | "array" | "null" | undefined;
        required?: boolean | undefined;
        default?: unknown;
    }> | undefined;
    outputs?: Record<string, string> | undefined;
}>;
export type OnFailure = z.infer<typeof onFailureSchema>;
export type RetryConfig = z.infer<typeof retrySchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
/** The unvalidated shape accepted by `define`/`validate` before parsing. */
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;
//# sourceMappingURL=schema.d.ts.map