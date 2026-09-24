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

    if (caller !== "system" && this.agents.has(caller)) {
      const allowed = this.agents.require(caller).allowedTools(this.tools.ids());
      if (!allowed.includes(toolId)) {
        const error = new ToolNotAllowedError(caller, toolId);
        await this.emitError("callTool", error);
        return { callId: options.callId ?? "", toolId, ok: false, error: error.message, durationMs: 0 };
      }
    }

    const before: BeforeToolCallPayload = { toolId, caller, params: { ...params } };
    try {
      await this.hooks.emit("beforeToolCall", before);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await this.emitError("beforeToolCall", cause);
      return { callId: options.callId ?? "", toolId, ok: false, error: message, durationMs: 0 };
    }

    const result = await this.tools.execute(toolId, before.params, { ...options, caller });

    const after: AfterToolCallPayload = {
      call: { callId: result.callId, toolId, caller, params: before.params, startedAt: Date.now() },
      result,
    };
    await this.hooks.emit("afterToolCall", after).catch((cause) => this.emitError("afterToolCall", cause));

    return result;
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
