/**
 * Core type definitions shared across the orchestration engine.
 *
 * These types are intentionally transport- and backend-agnostic: they describe
 * *what* a tool, agent or call is, never *how* it is transported or persisted.
 */

/** JSON-compatible value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * A minimal JSON Schema shape. This is deliberately loose — concrete registries
 * may narrow it, and validators may accept richer schemas.
 */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: JsonValue[];
  description?: string;
  [keyword: string]: unknown;
}

/** How dangerous a tool is, used for safe-by-default gating. */
export type ToolSafety = "read-only" | "write" | "destructive";

/** A validation error produced while checking parameters against a schema. */
export interface ValidationError {
  /** Dotted path to the offending field, e.g. `input.user.id`. */
  readonly path: string;
  readonly message: string;
}

/**
 * A validator turns raw params into either a typed, validated value or a list
 * of validation errors. Implementations may wrap Zod, Ajv, etc.
 */
export type ParamsValidator<T = JsonObject> = (
  params: JsonObject,
) => { ok: true; value: T } | { ok: false; errors: ValidationError[] };

/** Metadata + behavior describing a single callable tool. */
export interface ToolDefinition<Params extends JsonObject = JsonObject, Output = JsonValue> {
  /** Stable unique identifier, e.g. `filesystem.read_file`. */
  readonly id: string;
  readonly description: string;
  /** JSON schema for the tool's parameters (used for discovery/documentation). */
  readonly schema: JsonSchema;
  /** Safety classification; defaults to `write` when omitted by a registry. */
  readonly safety?: ToolSafety;
  /** Optional structural validator run before {@link ToolDefinition.execute}. */
  readonly validate?: ParamsValidator<Params>;
  /** Perform the tool's work. */
  execute(params: Params, context: ToolExecutionContext): Promise<Output> | Output;
}

/** A registered tool as seen by consumers (definition without the executor). */
export interface Tool {
  readonly id: string;
  readonly description: string;
  readonly schema: JsonSchema;
  readonly safety: ToolSafety;
  /** Origin of the tool: `local` or the id of the MCP that provided it. */
  readonly source: string;
}

/** Context handed to a tool at execution time. */
export interface ToolExecutionContext {
  /** Correlation id for this call, useful for tracing and audit. */
  readonly callId: string;
  /** Id of the agent (or `"system"`) that initiated the call. */
  readonly caller: string;
  /** Arbitrary, caller-provided values propagated through the call. */
  readonly metadata: Readonly<JsonObject>;
  /** AbortSignal, if the caller supports cancellation. */
  readonly signal?: AbortSignal;
}

/** A record of a tool invocation request. */
export interface ToolCall {
  readonly callId: string;
  readonly toolId: string;
  readonly caller: string;
  readonly params: JsonObject;
  readonly startedAt: number;
}

/** The outcome of a tool invocation. */
export interface ToolResult<Output = JsonValue> {
  readonly callId: string;
  readonly toolId: string;
  readonly ok: boolean;
  readonly output?: Output;
  readonly error?: string;
  readonly durationMs: number;
}

/** Declarative configuration for an agent. */
export interface AgentConfig {
  readonly id: string;
  readonly description?: string;
  /** Model identifier the agent should run on, e.g. `claude-opus-4-8`. */
  readonly model?: string;
  /** Ids of tools the agent is allowed to call (omit for "all registered"). */
  readonly tools?: string[];
  /** System prompt / steering for the agent. */
  readonly instructions?: string;
  /** Free-form, agent-specific settings. */
  readonly metadata?: JsonObject;
}

/** A registered agent handle. */
export interface Agent {
  readonly config: AgentConfig;
  /** Resolve the concrete set of tool ids this agent may call. */
  allowedTools(all: readonly string[]): string[];
}
