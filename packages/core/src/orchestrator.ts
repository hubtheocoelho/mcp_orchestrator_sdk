import { randomUUID } from "node:crypto";
import { AgentRegistry } from "./agent-registry.js";
import type { AuditSink } from "./audit.js";
import {
  HookManager,
  type AfterToolCallPayload,
  type BeforeToolCallPayload,
  type HookHandler,
  type Subscription,
} from "./hook-manager.js";
import { ToolRegistry, type ExecuteOptions, type ToolProvider } from "./tool-registry.js";
import type { Agent, AgentConfig, JsonObject, Tool, ToolDefinition, ToolResult } from "./types.js";
import type { OrchestratorEvent } from "./orchestrator-event.js";

/**
 * Minimal structural view of a state backend the orchestrator can delegate to.
 * `@mcp-orchestrator/state`'s StateManager satisfies this without a package
 * dependency in either direction.
 */
export interface StateAccess {
  get(collection: string, id: string): Promise<unknown>;
  /** Merge `patch` into an entity. The return value (if any) is ignored. */
  update(collection: string, id: string, patch: JsonObject): Promise<unknown>;
}

/** Minimal structural view of a workflow runtime the orchestrator can delegate to. */
export interface WorkflowRunner {
  execute(workflowId: string, inputs: JsonObject, context?: unknown): Promise<unknown>;
}

export interface OrchestratorOptions {
  toolRegistry?: ToolRegistry;
  agentRegistry?: AgentRegistry;
  hooks?: HookManager;
  auditSinks?: AuditSink[];
  state?: StateAccess;
  workflows?: WorkflowRunner;
}

/** Thrown when an agent attempts to call a tool outside its allowlist. */
export class ToolNotAllowedError extends Error {
  constructor(
    readonly agentId: string,
    readonly toolId: string,
  ) {
    super(`Agent "${agentId}" is not allowed to call tool "${toolId}"`);
    this.name = "ToolNotAllowedError";
  }
}

/** Thrown when an operation is aborted via AbortSignal. */
export class OrchestratorAbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "OrchestratorAbortError";
  }
}

/**
 * The main orchestration engine. It composes the tool and agent registries with
 * the hook manager and optional state / workflow backends, and provides the
 * single entry point (`callTool`) through which every tool call flows so that
 * hooks, allowlists and audit consistently apply.
 */
export class Orchestrator {
  readonly tools: ToolRegistry;
  readonly agents: AgentRegistry;
  readonly hooks: HookManager;

  private readonly state?: StateAccess;
  private readonly workflows?: WorkflowRunner;
  private disposed = false;

  constructor(options: OrchestratorOptions = {}) {
    this.tools = options.toolRegistry ?? new ToolRegistry({ auditSinks: options.auditSinks });
    this.agents = options.agentRegistry ?? new AgentRegistry();
    this.hooks = options.hooks ?? new HookManager();
    this.state = options.state;
    this.workflows = options.workflows;
  }

  // --- Registration -------------------------------------------------------

  async registerAgent(config: AgentConfig): Promise<Agent> {
    const agent = this.agents.upsert(config);
    await this.hooks.emit("agentSpawn", { config });
    return agent;
  }

  registerTool(tool: ToolDefinition, options?: { source?: string }): void {
    this.tools.register(tool, options);
  }

  /** Discover and register every tool from a provider (e.g. an MCP client). */
  async registerToolProvider(provider: ToolProvider): Promise<Tool[]> {
    return this.tools.discover(provider);
  }

  // --- Tool execution -----------------------------------------------------

  /**
   * Execute a tool through the full pipeline: allowlist check → beforeToolCall
   * hooks (may rewrite params or veto) → registry execution + audit →
   * afterToolCall hooks. Vetoes and unexpected hook errors surface as failed
   * ToolResults, never thrown, so callers have a single success/failure channel.
   */
  async callTool(
    toolId: string,
    params: JsonObject,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const caller = options.caller ?? "system";
    const callId = options.callId ?? randomUUID();
    const startedAt = Date.now();

    if (caller !== "system" && this.agents.has(caller)) {
      const allowed = this.agents.require(caller).allowedTools(this.tools.ids());
      if (!allowed.includes(toolId)) {
        const error = new ToolNotAllowedError(caller, toolId);
        await this.emitError("callTool", error);
        return { callId, toolId, ok: false, error: error.message, durationMs: 0 };
      }
    }

    const before: BeforeToolCallPayload = { toolId, caller, params: { ...params } };
    try {
      await this.hooks.emit("beforeToolCall", before);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await this.emitError("beforeToolCall", cause);
      return { callId, toolId, ok: false, error: message, durationMs: 0 };
    }

    const result = await this.tools.execute(toolId, before.params, { ...options, caller, callId });

    const after: AfterToolCallPayload = {
      call: { callId, toolId, caller, params: before.params, startedAt },
      result,
    };
    await this.hooks.emit("afterToolCall", after).catch((cause) => this.emitError("afterToolCall", cause));

    return result;
  }

  // --- Streaming tool execution -------------------------------------------

  /**
   * Streaming version of callTool. Emits tool.chunk events for each chunk.
   * For tools that do not support streaming, a single chunk with the full
   * result is emitted (degraded but consistent behavior).
   */
  async *callToolStream(
    toolId: string,
    params: JsonObject,
    options: ExecuteOptions = {},
  ): AsyncGenerator<OrchestratorEvent> {
    const result = await this.callTool(toolId, params, options);
    if (result.ok) {
      const output = result.output as any;
      if (output && typeof output[Symbol.asyncIterator] === "function") {
        for await (const chunk of output) {
          yield { type: "tool.chunk", toolName: toolId, chunk };
        }
      } else {
        yield { type: "tool.chunk", toolName: toolId, chunk: output };
      }
    } else {
      yield { type: "tool.chunk", toolName: toolId, chunk: { error: result.error } };
    }
  }

  // --- Streaming workflow execution ---------------------------------------

  /**
   * Streaming version of executeWorkflow. Yields OrchestratorEvent for every
   * lifecycle transition. The caller can consume these events to drive a UI,
   * log progress, or pipe them to an SSE endpoint.
   *
   * The existing `executeWorkflow` method is left completely intact; this is
   * a new, additive API that operates on the same WorkflowRunner.
   *
   * @param workflowId   Identifier of the workflow (used for events only).
   * @param steps        Array of step descriptors `{ id, tool, params?, when?, stop_when? }`.
   * @param input        Workflow-level input data.
   * @param options      Execution options including optional `signal` for cancellation.
   */
  async *executeWorkflowStream(
    workflowId: string,
    steps: ReadonlyArray<{
      id: string;
      tool: string;
      params?: JsonObject;
      when?: string;
      stop_when?: string;
    }>,
    input: JsonObject,
    options: ExecuteOptions & { signal?: AbortSignal } = {},
  ): AsyncGenerator<OrchestratorEvent> {
    const { signal } = options;

    // Helper: check if we've been aborted and emit the right events.
    const checkAbort = (): OrchestratorEvent | undefined => {
      if (signal?.aborted) {
        return {
          type: "workflow.failed",
          workflowId,
          error: new OrchestratorAbortError(),
        };
      }
      return undefined;
    };

    // Guard: already aborted before we even start
    const preAbort = checkAbort();
    if (preAbort) {
      yield preAbort;
      return;
    }

    yield { type: "workflow.started", workflowId, input };

    const scope: Record<string, any> = { input, steps: {} };
    let lastOutput: unknown = undefined;

    for (const step of steps) {
      // Check cancellation between steps
      const abortEvent = checkAbort();
      if (abortEvent) {
        yield abortEvent;
        return;
      }

      yield { type: "step.started", stepName: step.id, tool: step.tool };

      const toolResult = await this.callTool(
        step.tool,
        step.params ?? ({} as JsonObject),
        { caller: options.caller, callId: options.callId, signal } as ExecuteOptions,
      );

      if (toolResult.ok) {
        yield { type: "step.output", stepName: step.id, output: toolResult.output };
        scope.steps[step.id] = { output: toolResult.output };
        lastOutput = toolResult.output;
      } else {
        const err = new Error(toolResult.error ?? "unknown error");
        yield { type: "step.failed", stepName: step.id, error: err, willRetry: false };
        yield { type: "workflow.failed", workflowId, error: err };
        return; // terminate the stream on error
      }
    }

    yield { type: "workflow.finished", workflowId, result: lastOutput };
  }

  // --- Workflows & state (delegated) --------------------------------------

  async executeWorkflow(workflowId: string, inputs: JsonObject, context?: unknown): Promise<unknown> {
    if (!this.workflows) throw new Error("No workflow runner configured on this orchestrator");
    return this.workflows.execute(workflowId, inputs, context);
  }

  async getState(collection: string, id: string): Promise<unknown> {
    if (!this.state) throw new Error("No state backend configured on this orchestrator");
    return this.state.get(collection, id);
  }

  async updateState(collection: string, id: string, patch: JsonObject): Promise<void> {
    if (!this.state) throw new Error("No state backend configured on this orchestrator");
    await this.state.update(collection, id, patch);
  }

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Gracefully shut down the orchestrator, releasing any resources.
   * Idempotent — calling dispose() twice is safe.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Future: close transport connections, cancel subscriptions, etc.
  }

  /** Support `await using orchestrator = new Orchestrator()` (TC39 Explicit Resource Management). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  // --- Hook sugar ---------------------------------------------------------

  onBeforeToolCall(handler: HookHandler<BeforeToolCallPayload>): Subscription {
    return this.hooks.on("beforeToolCall", handler);
  }

  onAfterToolCall(handler: HookHandler<AfterToolCallPayload>): Subscription {
    return this.hooks.on("afterToolCall", handler);
  }

  private async emitError(scope: string, cause: unknown): Promise<void> {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // Avoid infinite loops if an error handler itself throws.
    try {
      await this.hooks.emit("error", { scope, error });
    } catch {
      /* swallow secondary errors */
    }
  }
}
