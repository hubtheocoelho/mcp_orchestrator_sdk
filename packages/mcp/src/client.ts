import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  ToolDefinition,
  ToolProvider,
} from "@mcp-orchestrator/core";
import type { McpTransport, RemoteToolDescriptor, Resource } from "./types.js";

export interface McpClientOptions {
  /** Stable id for this MCP; used as the tool `source` and namespace prefix. */
  readonly id: string;
  readonly transport: McpTransport;
  /**
   * How a remote tool `name` becomes a registry tool id. Defaults to
   * `${id}.${name}` so tools from different MCPs never collide.
   */
  namespace?: (clientId: string, toolName: string) => string;
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
  private connected = false;

  constructor(options: McpClientOptions) {
    this.id = options.id;
    this.transport = options.transport;
    this.namespace = options.namespace ?? ((clientId, toolName) => `${clientId}.${toolName}`);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.transport.start();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.transport.close();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Raw remote tool descriptors, as advertised by the server. */
  async getTools(): Promise<RemoteToolDescriptor[]> {
    this.assertConnected();
    return this.transport.listTools();
  }

  /** Call a remote tool by its un-namespaced name. */
  async callTool(toolName: string, params: JsonObject): Promise<JsonValue> {
    this.assertConnected();
    return this.transport.callTool(toolName, params);
  }

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
      execute: (params) => this.callTool(descriptor.name, params),
    };
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error(`MCP client "${this.id}" is not connected`);
  }
}
