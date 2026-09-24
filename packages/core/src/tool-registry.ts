import { randomUUID } from "node:crypto";
import type { AuditSink } from "./audit.js";
import { err, ok, type Result } from "./result.js";
import type {
  JsonObject,
  JsonSchema,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ValidationError,
} from "./types.js";

/**
 * A source of tool definitions that can be discovered and registered in bulk,
 * e.g. an MCP client. Kept structural so `core` need not depend on `mcp`.
 */
export interface ToolProvider {
  /** Stable id of the provider, used as the tool `source`. */
  readonly id: string;
  /** List the tool definitions this provider exposes. */
  listToolDefinitions(): Promise<ToolDefinition[]> | ToolDefinition[];
}

/** Options controlling a single tool execution. */
export interface ExecuteOptions {
  readonly caller?: string;
  readonly metadata?: JsonObject;
  readonly signal?: AbortSignal;
  /** Override the generated call id (useful for correlating with a parent op). */
  readonly callId?: string;
}

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly source: string;
}

/** Thrown when an operation references a tool id that is not registered. */
export class ToolNotFoundError extends Error {
  constructor(readonly toolId: string) {
    super(`Tool not found: ${toolId}`);
    this.name = "ToolNotFoundError";
  }
}

/**
 * Centralized index of callable tools. Handles registration, discovery from
 * providers, structural validation and audited execution.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly sinks: AuditSink[];

  constructor(options: { auditSinks?: AuditSink[] } = {}) {
    this.sinks = options.auditSinks ?? [];
  }

  /** Register (or replace) a single tool definition. */
  register(definition: ToolDefinition, options: { source?: string } = {}): void {
    this.tools.set(definition.id, {
      definition,
      source: options.source ?? "local",
    });
  }

  /** Discover and register every tool exposed by a provider. */
  async discover(provider: ToolProvider): Promise<Tool[]> {
    const definitions = await provider.listToolDefinitions();
    for (const definition of definitions) {
      this.register(definition, { source: provider.id });
    }
    return definitions.map((d) => this.toTool(d, provider.id));
  }

  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  /** Public, executor-free view of a single tool. */
  get(toolId: string): Tool | undefined {
    const entry = this.tools.get(toolId);
    return entry ? this.toTool(entry.definition, entry.source) : undefined;
  }

  /** Public, executor-free view of every registered tool. */
  list(): Tool[] {
    return [...this.tools.values()].map((e) => this.toTool(e.definition, e.source));
  }

  ids(): string[] {
    return [...this.tools.keys()];
  }

  getSchema(toolId: string): JsonSchema {
    const entry = this.requireTool(toolId);
    return entry.definition.schema;
  }

  /**
   * Validate params against the tool's validator (or, absent one, its schema's
   * `required`/`type` constraints). Returns `ok(void)` or the error list.
   */
  validate(toolId: string, params: JsonObject): Result<void, ValidationError[]> {
    const entry = this.requireTool(toolId);
    const { definition } = entry;

    if (definition.validate) {
      const result = definition.validate(params);
      return result.ok ? ok(undefined) : err(result.errors);
    }

    const errors = structuralErrors(definition.schema, params);
    return errors.length === 0 ? ok(undefined) : err(errors);
  }

  /** Validate then execute a tool, emitting an audit record for the call. */
  async execute(
    toolId: string,
    params: JsonObject,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const callId = options.callId ?? randomUUID();
    const caller = options.caller ?? "system";
    const startedAt = Date.now();

    const call: ToolCall = { callId, toolId, caller, params, startedAt };

    const entry = this.tools.get(toolId);
    if (!entry) {
      const error = new ToolNotFoundError(toolId).message;
      const result: ToolResult = { callId, toolId, ok: false, error, durationMs: 0 };
      await this.emit(call, result, error);
      return result;
    }

    const validation = this.validate(toolId, params);
    if (!validation.ok) {
      const message = validation.error.map((e) => `${e.path}: ${e.message}`).join("; ");
      const result: ToolResult = {
        callId,
        toolId,
        ok: false,
        error: `Validation failed: ${message}`,
        durationMs: 0,
      };
      await this.emit(call, result, result.error);
      return result;
    }

    try {
      const output = await entry.definition.execute(params, {
        callId,
        caller,
        metadata: options.metadata ?? {},
        signal: options.signal,
      });
      const result: ToolResult = {
        callId,
        toolId,
        ok: true,
        output: output as ToolResult["output"],
        durationMs: Date.now() - startedAt,
      };
      await this.emit(call, result);
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const result: ToolResult = {
        callId,
        toolId,
        ok: false,
        error: message,
        durationMs: Date.now() - startedAt,
      };
      await this.emit(call, result, message);
      return result;
    }
  }

  /** Send a call/result pair to every configured audit sink. */
  async audit(call: ToolCall, result: ToolResult, error?: string): Promise<void> {
    await this.emit(call, result, error);
  }

  private async emit(call: ToolCall, result: ToolResult, error?: string): Promise<void> {
    const recordedAt = Date.now();
    await Promise.all(this.sinks.map((sink) => sink.record({ call, result, error, recordedAt })));
  }

  private requireTool(toolId: string): RegisteredTool {
    const entry = this.tools.get(toolId);
    if (!entry) throw new ToolNotFoundError(toolId);
    return entry;
  }

  private toTool(definition: ToolDefinition, source: string): Tool {
    return {
      id: definition.id,
      description: definition.description,
      schema: definition.schema,
      safety: definition.safety ?? "write",
      source,
    };
  }
}

/** Minimal structural validation from a JSON schema's `required` and `type`. */
function structuralErrors(schema: JsonSchema, params: JsonObject): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of schema.required ?? []) {
    if (params[key] === undefined) {
      errors.push({ path: key, message: "is required" });
    }
  }
  const properties = schema.properties ?? {};
  for (const [key, propSchema] of Object.entries(properties)) {
    const value = params[key];
    if (value === undefined || propSchema.type === undefined) continue;
    if (!matchesType(value, propSchema.type)) {
      errors.push({ path: key, message: `expected ${propSchema.type}` });
    }
  }
  return errors;
}

function matchesType(value: unknown, type: NonNullable<JsonSchema["type"]>): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}
