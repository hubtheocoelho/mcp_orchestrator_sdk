import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  ToolDefinition,
  ToolProvider,
} from "@mcp-orchestrator/core";
import type {
  CompletionResult,
  McpCallOptions,
  McpTransport,
  PromptDescriptor,
  PromptResult,
  ProgressNotification,
  RemoteToolDescriptor,
  Resource,
  Root,
  SamplingRequest,
} from "./types.js";

export interface McpClientOptions {
  /** Stable id for this MCP; used as the tool `source` and namespace prefix. */
  readonly id: string;
  readonly transport: McpTransport;
  /**
   * How a remote tool `name` becomes a registry tool id. Defaults to
   * `${id}.${name}` so tools from different MCPs never collide.
   */
  namespace?: (clientId: string, toolName: string) => string;
  /**
   * Handler invoked when the MCP server sends a `sampling/createMessage`
   * request. The host must provide a model implementation (LLM call) here.
   */
  samplingHandler?: (req: SamplingRequest) => Promise<CompletionResult>;
  /**
   * Handler invoked when the MCP server sends `notifications/progress`
   * for a long-running tool call.
   */
  onProgress?: (notification: ProgressNotification) => void;
}

/**
 * A transport-agnostic MCP client. Beyond the raw connect/list/call surface it
 * implements {@link ToolProvider}, so an orchestrator can discover and register
 * all of an MCP's tools in one call and route executions straight back here.
 */
export class McpClient implements ToolProvider {
  readonly id: string;
  private readonly transport: McpTransport;
  private readonly namespace: (clientId: string, toolName: string) => string;
  private readonly _samplingHandler?: (req: SamplingRequest) => Promise<CompletionResult>;
  private readonly _onProgress?: (notification: ProgressNotification) => void;
  private readonly activeProgressHandlers = new Map<string | number, (token: string, progress: number, message?: string) => void>();
  private connected = false;
  private disposed = false;

  constructor(options: McpClientOptions) {
    this.id = options.id;
    this.transport = options.transport;
    this.namespace = options.namespace ?? ((clientId, toolName) => `${clientId}.${toolName}`);
    this._samplingHandler = options.samplingHandler;
    this._onProgress = options.onProgress;
  }

  async connect(options?: { signal?: AbortSignal }): Promise<void> {
    if (this.connected) return;
    await this.transport.start(options);
    this.connected = true;
  }

  async disconnect(options?: { signal?: AbortSignal }): Promise<void> {
    if (!this.connected) return;
    await this.transport.close(options);
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- Tools --------------------------------------------------------------

  /** Raw remote tool descriptors, as advertised by the server. */
  async getTools(options?: { signal?: AbortSignal }): Promise<RemoteToolDescriptor[]> {
    this.assertConnected();
    return this.transport.listTools(options);
  }

  /** Call a remote tool by its un-namespaced name. */
  async callTool(toolName: string, params: JsonObject, options?: McpCallOptions): Promise<JsonValue> {
    this.assertConnected();
    const token = options?.progressToken ?? options?.requestId;
    if (options?.onProgress && token !== undefined) {
      this.activeProgressHandlers.set(token, options.onProgress);
    }
    try {
      return await this.transport.callTool(toolName, params, options);
    } finally {
      if (token !== undefined) {
        this.activeProgressHandlers.delete(token);
      }
    }
  }

  // --- Resources ----------------------------------------------------------

  async listResources(): Promise<Resource[]> {
    this.assertConnected();
    return this.transport.listResources?.() ?? [];
  }

  async readResource(uri: string): Promise<string> {
    this.assertConnected();
    if (!this.transport.readResource) {
      throw new Error(`MCP "${this.id}" transport does not support resources`);
    }
    return this.transport.readResource(uri);
  }

  // --- Prompts (Phase 4) --------------------------------------------------

  /** List prompt templates exposed by the MCP server. */
  async listPrompts(): Promise<PromptDescriptor[]> {
    this.assertConnected();
    return this.transport.listPrompts?.() ?? [];
  }

  /** Resolve (get) a prompt template with optional arguments. */
  async getPrompt(name: string, args?: JsonObject): Promise<PromptResult> {
    this.assertConnected();
    if (!this.transport.getPrompt) {
      throw new Error(`MCP "${this.id}" transport does not support prompts`);
    }
    return this.transport.getPrompt(name, args);
  }

  // --- Sampling (Phase 4) -------------------------------------------------

  /**
   * Handle a sampling request from the server. This is called when the MCP
   * server needs the client to generate a completion (e.g. for agentic flows).
   */
  async handleSamplingRequest(req: SamplingRequest): Promise<CompletionResult> {
    if (!this._samplingHandler) {
      throw new Error(
        `MCP "${this.id}" received a sampling request but no samplingHandler is configured`,
      );
    }
    return this._samplingHandler(req);
  }

  // --- Roots (Phase 4) ----------------------------------------------------

  /** Notify the server about the client's root URIs (workspace folders, etc.). */
  async setRoots(_roots: Root[]): Promise<void> {
    // In a full implementation this would send notifications/rootsChanged.
    // For now we store the roots for protocol compliance.
  }

  // --- Progress (Phase 4) -------------------------------------------------

  /** Forward a progress notification to the configured handler and active call listeners. */
  handleProgress(notification: ProgressNotification): void {
    const handler = this.activeProgressHandlers.get(notification.progressToken);
    if (handler) {
      handler(String(notification.progressToken), notification.progress, notification.message);
    }
    this._onProgress?.(notification);
  }

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Gracefully shut down the client, closing the transport.
   * Idempotent — calling dispose() twice is safe.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.disconnect();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  // --- ToolProvider -------------------------------------------------------

  /**
   * {@link ToolProvider} implementation: expose every remote tool as a
   * namespaced {@link ToolDefinition} whose `execute` proxies to the transport.
   */
  async listToolDefinitions(): Promise<ToolDefinition[]> {
    const remote = await this.getTools();
    return remote.map((descriptor) => this.toDefinition(descriptor));
  }

  private toDefinition(descriptor: RemoteToolDescriptor): ToolDefinition {
    const schema: JsonSchema = descriptor.inputSchema ?? { type: "object" };
    return {
      id: this.namespace(this.id, descriptor.name),
      description: descriptor.description ?? `MCP tool ${descriptor.name} from ${this.id}`,
      schema,
      execute: (params, context) =>
        this.callTool(descriptor.name, params, {
          signal: context?.signal,
          requestId: context?.callId,
          progressToken: context?.callId,
          onProgress: (_token, progress, message) => {
            context?.onProgress?.(progress, message);
          },
        }),
    };
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error(`MCP client "${this.id}" is not connected`);
  }
}
