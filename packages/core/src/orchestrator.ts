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
import { NoopTracer, type Tracer } from "./tracing.js";
import { OrchestratorAbortError, pumpEvents } from "./event-pump.js";

export { OrchestratorAbortError } from "./event-pump.js";

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
  /**
   * Optional: validate and run an ad-hoc definition (`{ id, steps, inputs, outputs }`).
   * When present, `executeWorkflowStream` delegates to it so inline steps get
   * the full workflow semantics. `WorkflowEngine` implements it.
   */
  executeDefinition?(definition: unknown, inputs: JsonObject, context?: unknown): Promise<unknown>;
}

/**
 * Context handed to a {@link WorkflowRunner} by the streaming APIs. Runners
 * that support streaming (e.g. `WorkflowEngine`) call `onEvent` for every
 * lifecycle transition.
 */
export interface WorkflowStreamContext {
  signal?: AbortSignal;
  caller?: string;
  onEvent: (event: OrchestratorEvent) => void;
}

/** An inline step accepted by {@link Orchestrator.executeWorkflowStream}. */
export interface InlineWorkflowStep {
  id: string;
  tool: string;
  params?: JsonObject;
  when?: string;
  stop_when?: string;
  [key: string]: unknown;
}

/** Structural view of a provider offering prompts (e.g. McpClient). */
export interface PromptProvider {
  listPrompts?(): Promise<unknown[]>;
  getPrompt?(name: string, args?: JsonObject): Promise<unknown>;
}

/** Structural view of a provider offering resources (e.g. McpClient). */
export interface ResourceProvider {
  listResources?(): Promise<unknown[]>;
  readResource?(uri: string): Promise<string>;
}

export interface OrchestratorOptions {
  toolRegistry?: ToolRegistry;
  agentRegistry?: AgentRegistry;
  hooks?: HookManager;
  auditSinks?: AuditSink[];
  state?: StateAccess;
  workflows?: WorkflowRunner;
  tracer?: Tracer;
  samplingHandler?: (req: unknown) => Promise<unknown>;
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
  readonly tracer: Tracer;
  readonly samplingHandler?: (req: unknown) => Promise<unknown>;

  private readonly state?: StateAccess;
  private readonly workflows?: WorkflowRunner;
  private readonly promptProviders: PromptProvider[] = [];
  private readonly resourceProviders: ResourceProvider[] = [];
  private disposed = false;

  constructor(options: OrchestratorOptions = {}) {
    this.tools = options.toolRegistry ?? new ToolRegistry({ auditSinks: options.auditSinks });
    this.agents = options.agentRegistry ?? new AgentRegistry();
    this.hooks = options.hooks ?? new HookManager();
    this.state = options.state;
    this.workflows = options.workflows;
    this.tracer = options.tracer ?? NoopTracer;
    this.samplingHandler = options.samplingHandler;
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

  registerPromptProvider(provider: PromptProvider): void {
    this.promptProviders.push(provider);
  }

  registerResourceProvider(provider: ResourceProvider): void {
    this.resourceProviders.push(provider);
  }

  async listPrompts(): Promise<unknown[]> {
    const all: unknown[] = [];
    for (const p of this.promptProviders) {
      if (p.listPrompts) all.push(...(await p.listPrompts()));
    }
    return all;
  }

  async getPrompt(name: string, args?: JsonObject): Promise<unknown> {
    for (const p of this.promptProviders) {
      if (p.getPrompt) {
        try {
          return await p.getPrompt(name, args);
        } catch {
          // continue searching providers
        }
      }
    }
    throw new Error(`Prompt "${name}" not found in any registered provider`);
  }

  async listResources(): Promise<unknown[]> {
    const all: unknown[] = [];
    for (const r of this.resourceProviders) {
      if (r.listResources) all.push(...(await r.listResources()));
    }
    return all;
  }

  async readResource(uri: string): Promise<string> {
    for (const r of this.resourceProviders) {
      if (r.readResource) {
        try {
          return await r.readResource(uri);
        } catch {
          // continue searching providers
        }
      }
    }
    throw new Error(`Resource "${uri}" not found in any registered provider`);
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
   * Streaming version of callTool. Emits `step.progress` for reported progress,
   * then `tool.chunk` events: one per chunk for async-iterable outputs, or a
   * single chunk with the full result (or `{ error }`) otherwise. Aborting the
   * signal ends the stream immediately with an `{ error }` chunk, even if the
   * tool ignores the signal.
   */
  async *callToolStream(
    toolId: string,
    params: JsonObject,
    options: ExecuteOptions = {},
  ): AsyncGenerator<OrchestratorEvent> {
    const abortChunk = (): OrchestratorEvent => ({
      type: "tool.chunk",
      toolName: toolId,
      chunk: { error: new OrchestratorAbortError().message },
    });
    if (options.signal?.aborted) {
      yield abortChunk();
      return;
    }

    let finalResult: ToolResult | undefined;
    yield* pumpEvents(
      async (emit) => {
        finalResult = await this.callTool(toolId, params, {
          ...options,
          onProgress: (progress, message) => {
            options.onProgress?.(progress, message);
            emit({ type: "step.progress", stepName: toolId, progress, message });
          },
        });
      },
      { signal: options.signal, onAbort: abortChunk },
    );
    if (options.signal?.aborted || !finalResult) return;

    if (finalResult.ok) {
      const output = finalResult.output as unknown;
      if (output && typeof (output as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
        for await (const chunk of output as AsyncIterable<unknown>) {
          if (options.signal?.aborted) {
            yield abortChunk();
            return;
          }
          yield { type: "tool.chunk", toolName: toolId, chunk };
        }
      } else {
        yield { type: "tool.chunk", toolName: toolId, chunk: output };
      }
    } else {
      yield { type: "tool.chunk", toolName: toolId, chunk: { error: finalResult.error } };
    }
  }

  // --- Streaming workflow execution ---------------------------------------

  /**
   * Stream a workflow **registered** on the configured {@link WorkflowRunner}
   * (e.g. `WorkflowEngine`). Yields an {@link OrchestratorEvent} for every
   * lifecycle transition; always ends with `workflow.finished` or
   * `workflow.failed`, including on abort.
   */
  async *streamWorkflow(
    workflowId: string,
    inputs: JsonObject = {},
    options: { signal?: AbortSignal; caller?: string } = {},
  ): AsyncGenerator<OrchestratorEvent> {
    const runner = this.workflows;
    if (!runner) {
      yield {
        type: "workflow.failed",
        workflowId,
        error: new Error("No workflow runner configured on this orchestrator"),
      };
      return;
    }
    if (options.signal?.aborted) {
      yield { type: "workflow.failed", workflowId, error: new OrchestratorAbortError() };
      return;
    }
    yield* pumpEvents(
      (onEvent) => {
        const context: WorkflowStreamContext = { signal: options.signal, caller: options.caller, onEvent };
        return runner.execute(workflowId, inputs, context);
      },
      { signal: options.signal, workflowId },
    );
  }

  /**
   * Stream an ad-hoc list of steps.
   *
   * When the configured {@link WorkflowRunner} implements `executeDefinition`
   * (e.g. `WorkflowEngine`), the steps run through it and get the full
   * workflow semantics: `${...}` interpolation, `when`/`stop_when`,
   * `on_failure`/`onError`, retries, `parallel`, tracing.
   *
   * Without such a runner a minimal sequential runner is used, which supports
   * only literal params; steps using `when`, `stop_when` or `${...}` templates
   * fail fast with `workflow.failed` instead of being silently mis-executed.
   *
   * @param workflowId   Identifier of the workflow (used in events).
   * @param steps        Step descriptors `{ id, tool, params?, ... }`.
   * @param input        Workflow-level input data (`${input.*}`).
   * @param options      Execution options including optional `signal` for cancellation.
   */
  async *executeWorkflowStream(
    workflowId: string,
    steps: ReadonlyArray<InlineWorkflowStep>,
    input: JsonObject,
    options: ExecuteOptions = {},
  ): AsyncGenerator<OrchestratorEvent> {
    const { signal } = options;
    if (signal?.aborted) {
      yield { type: "workflow.failed", workflowId, error: new OrchestratorAbortError() };
      return;
    }

    const runner = this.workflows;
    if (runner?.executeDefinition) {
      const run = runner.executeDefinition.bind(runner);
      const definition = { id: workflowId, inputs: {}, steps, outputs: {} };
      yield* pumpEvents(
        (onEvent) => {
          const context: WorkflowStreamContext = { signal, caller: options.caller, onEvent };
          return run(definition, input, context);
        },
        { signal, workflowId },
      );
      return;
    }

    const unsupported = steps.find(
      (s) =>
        s.when !== undefined || s.stop_when !== undefined || JSON.stringify(s.params ?? {}).includes("${"),
    );
    if (unsupported) {
      yield {
        type: "workflow.failed",
        workflowId,
        error: new Error(
          `Step "${unsupported.id}" uses when/stop_when or \${...} templates, which need a ` +
            "WorkflowRunner with executeDefinition (e.g. WorkflowEngine) configured as `workflows`",
        ),
      };
      return;
    }

    yield* pumpEvents((emit) => this.runInlineSteps(workflowId, steps, input, options, emit), {
      signal,
      workflowId,
    });
  }

  /** Minimal sequential runner used by executeWorkflowStream when no runner can run definitions. */
  private async runInlineSteps(
    workflowId: string,
    steps: ReadonlyArray<InlineWorkflowStep>,
    input: JsonObject,
    options: ExecuteOptions,
    emit: (event: OrchestratorEvent) => void,
  ): Promise<void> {
    emit({ type: "workflow.started", workflowId, input });
    let lastOutput: unknown;
    for (const step of steps) {
      if (options.signal?.aborted) return; // the pump yields the abort event
      emit({ type: "step.started", stepName: step.id, tool: step.tool });
      const result = await this.callTool(step.tool, step.params ?? {}, {
        caller: options.caller,
        signal: options.signal,
        onProgress: (progress, message) =>
          emit({ type: "step.progress", stepName: step.id, progress, message }),
      });
      if (options.signal?.aborted) return;
      if (!result.ok) {
        const error = new Error(result.error ?? "unknown error");
        emit({ type: "step.failed", stepName: step.id, error, willRetry: false });
        emit({ type: "workflow.failed", workflowId, error });
        return;
      }
      emit({ type: "step.output", stepName: step.id, output: result.output });
      lastOutput = result.output;
    }
    emit({ type: "workflow.finished", workflowId, result: lastOutput });
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
