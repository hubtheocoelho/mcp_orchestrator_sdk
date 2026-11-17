import type { JsonObject } from "@mcp-orchestrator/core";
import {
  InMemoryCheckpointStore,
  WorkflowInputError,
  type CheckpointStore,
  type ExecutionContext,
  type InputProvider,
  type WorkflowDefinition,
  type WorkflowEngine,
  type WorkflowResult,
} from "@mcp-orchestrator/workflow";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ElicitRequestFormParams,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { requestSchema, validateInput, workflowInputSchema } from "./input-schema.js";
import {
  InMemorySuspensionStore,
  hashToken,
  newResumeToken,
  tokenMatches,
  type SuspensionStore,
} from "./suspension-store.js";

/**
 * How a `needs_input` step hands control back to the LLM:
 * - `"auto"`: MCP elicitation inside the same `tools/call` when the client
 *   declared the `elicitation` capability (Mode A), else suspend (Mode B).
 * - `"suspend"`: always suspend and let the client resume (Mode B).
 */
export type InputMode = "auto" | "suspend";

/** Per-workflow overrides. */
export interface WorkflowToolOptions {
  /** Force a mode for this workflow; defaults to the server's `mode`. */
  mode?: InputMode;
  /** Tool description; defaults to the workflow's description. */
  description?: string;
}

export interface McpWorkflowServerOptions {
  /** Server name reported in `initialize`. */
  name: string;
  version: string;
  /** Engine holding the workflow definitions; each one becomes a tool. */
  engine: WorkflowEngine;
  /**
   * Which workflows to expose (by id), optionally with per-workflow options.
   * Defaults to every workflow defined on the engine at `tools/list` time.
   */
  workflows?: readonly string[] | Readonly<Record<string, WorkflowToolOptions>>;
  /** Default input mode. Defaults to `"auto"`. */
  mode?: InputMode;
  /** Where suspended runs are checkpointed. Use a durable store in production. */
  checkpointStore?: CheckpointStore;
  /** Where Mode B resume tokens are kept. Use a durable store in production. */
  suspensionStore?: SuspensionStore;
  /**
   * How long a Mode A run waits for the elicitation reply before falling back
   * to Mode B (checkpoint + `suspended` result). Defaults to 10 minutes.
   */
  elicitationTimeoutMs?: number;
  /** Name of the tool that resumes suspended runs. Defaults to `"resume_workflow"`. */
  resumeToolName?: string;
  /** Instructions sent in `initialize`. */
  instructions?: string;
}

/** The `structuredContent` of a workflow tool call. */
export type WorkflowToolResult =
  | { status: "completed"; runId: string; outputs: JsonObject }
  | { status: "failed"; runId: string; error: string }
  | {
      status: "suspended";
      runId: string;
      resumeToken: string;
      request: { message: string; schema: Record<string, unknown> };
    };

const DEFAULT_ELICITATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Exposes the workflows of a {@link WorkflowEngine} as tools of an MCP server
 * built on the official `@modelcontextprotocol/sdk`. Each workflow is one tool;
 * `needs_input` steps are answered by elicitation or by suspend/resume (see
 * ADR 0001).
 *
 * One instance can serve many connections: {@link createServer} builds a fresh
 * protocol `Server` per connection, all sharing the engine and stores.
 */
export class McpWorkflowServer {
  readonly resumeToolName: string;
  private readonly checkpoints: CheckpointStore;
  private readonly suspensions: SuspensionStore;

  constructor(private readonly options: McpWorkflowServerOptions) {
    this.resumeToolName = options.resumeToolName ?? "resume_workflow";
    this.checkpoints = options.checkpointStore ?? new InMemoryCheckpointStore();
    this.suspensions = options.suspensionStore ?? new InMemorySuspensionStore();
  }

  /** Build a protocol server for one connection. */
  createServer(): Server {
    const server = new Server(
      { name: this.options.name, version: this.options.version },
      {
        capabilities: { tools: {} },
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args = {} } = request.params;
      if (name === this.resumeToolName) return this.resume(server, args, extra.signal);
      const definition = this.exposed(name);
      if (!definition) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      return this.run(server, definition, args as JsonObject, extra.signal);
    });
    return server;
  }

  /** Build a protocol server and connect it to `transport`. */
  async connect(transport: Transport): Promise<Server> {
    const server = this.createServer();
    await server.connect(transport);
    return server;
  }

  private listTools(): Tool[] {
    const tools: Tool[] = this.exposedDefinitions().map((definition) => ({
      name: definition.id,
      description: this.toolOptions(definition.id).description ?? definition.description ?? `Run the "${definition.id}" workflow.`,
      inputSchema: workflowInputSchema(definition),
    }));
    tools.push({
      name: this.resumeToolName,
      description:
        "Resume a workflow run that returned status \"suspended\". Pass its runId and resumeToken, " +
        "and an `input` object that matches the `request.schema` it returned. Each resumeToken works once.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "runId from the suspended result" },
          resumeToken: { type: "string", description: "resumeToken from the suspended result" },
          input: { type: "object", description: "Answer matching request.schema" },
        },
        required: ["runId", "resumeToken", "input"],
      },
    });
    return tools;
  }

  private async run(
    server: Server,
    definition: WorkflowDefinition,
    args: JsonObject,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    let result: WorkflowResult;
    try {
      result = await this.options.engine.execute(definition.id, args, this.context(server, definition.id, signal));
    } catch (err) {
      if (err instanceof WorkflowInputError) return errorResult(err.message);
      throw err;
    }
    return this.toToolResult(result);
  }

  private async resume(server: Server, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const { runId, resumeToken, input } = args;
    if (typeof runId !== "string" || typeof resumeToken !== "string") {
      return errorResult("runId and resumeToken must be strings");
    }
    const suspended = await this.suspensions.get(runId);
    if (!suspended || !tokenMatches(resumeToken, suspended.tokenHash)) {
      return errorResult("Unknown runId or invalid resumeToken (tokens work once; use the latest one)");
    }
    const problems = validateInput(requestSchema(suspended.request), input);
    if (problems.length > 0) {
      // The token is not consumed: the client can fix its input and retry.
      return errorResult(`Invalid input: ${problems.join("; ")}`);
    }
    if (!(await this.suspensions.take(runId, suspended.tokenHash))) {
      return errorResult("This resumeToken has already been used");
    }
    const result = await this.options.engine.resume(suspended.workflowId, runId, this.checkpoints, {
      ...this.context(server, suspended.workflowId, signal),
      resumeInput: { stepId: suspended.stepId, content: input as JsonObject },
    });
    if (!result) return errorResult(`No checkpoint found for run ${runId}`);
    return this.toToolResult(result);
  }

  private context(server: Server, workflowId: string, signal: AbortSignal): ExecutionContext {
    const mode = this.toolOptions(workflowId).mode ?? this.options.mode ?? "auto";
    const canElicit = mode === "auto" && server.getClientCapabilities()?.elicitation !== undefined;
    return {
      caller: "mcp-client",
      signal,
      checkpointStore: this.checkpoints,
      ...(canElicit ? { inputProvider: this.elicitationProvider(server) } : {}),
    };
  }

  /** Mode A: ask the client through `elicitation/create`; fall back to suspend on timeout or disconnect. */
  private elicitationProvider(server: Server): InputProvider {
    const timeout = this.options.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS;
    return async (request, { signal }) => {
      const schema = requestSchema(request);
      let reply;
      try {
        reply = await server.elicitInput(
          { mode: "form", message: request.message, requestedSchema: schema } as ElicitRequestFormParams,
          { timeout, signal },
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        return { action: "suspend" };
      }
      if (reply.action !== "accept") return { action: reply.action };
      const content = (reply.content ?? {}) as JsonObject;
      const problems = validateInput(schema, content);
      if (problems.length > 0) throw new Error(`Invalid input: ${problems.join("; ")}`);
      return { action: "accept", content };
    };
  }

  private async toToolResult(result: WorkflowResult): Promise<CallToolResult> {
    let structured: WorkflowToolResult;
    if (result.suspended) {
      const resumeToken = newResumeToken();
      await this.suspensions.save({
        runId: result.runId,
        workflowId: result.workflowId,
        stepId: result.suspended.stepId,
        request: result.suspended.request,
        tokenHash: hashToken(resumeToken),
        createdAt: Date.now(),
      });
      structured = {
        status: "suspended",
        runId: result.runId,
        resumeToken,
        request: { message: result.suspended.request.message, schema: requestSchema(result.suspended.request) },
      };
      const text =
        `${JSON.stringify(structured)}\n\nThe workflow is paused and needs input: ${structured.request.message}\n` +
        `To continue, call the "${this.resumeToolName}" tool with this runId and resumeToken, ` +
        `and an "input" object matching request.schema.`;
      return { content: [{ type: "text", text }], structuredContent: structured };
    }
    if (!result.ok) {
      structured = { status: "failed", runId: result.runId, error: result.error ?? "Workflow failed" };
      return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: true };
    }
    structured = { status: "completed", runId: result.runId, outputs: result.outputs };
    return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
  }

  private exposedDefinitions(): WorkflowDefinition[] {
    const all = this.options.engine.list();
    const selection = this.options.workflows;
    if (!selection) return all;
    const ids = new Set(Array.isArray(selection) ? selection : Object.keys(selection));
    return all.filter((definition) => ids.has(definition.id));
  }

  private exposed(name: string): WorkflowDefinition | undefined {
    if (name === this.resumeToolName) return undefined;
    return this.exposedDefinitions().find((definition) => definition.id === name);
  }

  private toolOptions(workflowId: string): WorkflowToolOptions {
    const selection = this.options.workflows;
    if (!selection || Array.isArray(selection)) return {};
    const map = selection as Readonly<Record<string, WorkflowToolOptions>>;
    return Object.hasOwn(map, workflowId) ? (map[workflowId] ?? {}) : {};
  }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
