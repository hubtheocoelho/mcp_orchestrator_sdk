import type { JsonObject, JsonValue } from "@mcp-orchestrator/core";
import type { McpTransport, RemoteToolDescriptor, Resource } from "./types.js";

/** A single tool served by an {@link InMemoryTransport}. */
export interface InMemoryTool extends RemoteToolDescriptor {
  handler(args: JsonObject): Promise<JsonValue> | JsonValue;
}

export interface InMemoryTransportOptions {
  tools?: InMemoryTool[];
  resources?: Array<Resource & { read(): Promise<string> | string }>;
}

/**
 * An in-process MCP transport. It runs tool handlers directly in the current
 * process — ideal for tests, local reference domains and embedding MCP-style
 * servers without spawning anything. It exercises the exact same client/pool
 * code paths a stdio or HTTP transport would.
 */
export class InMemoryTransport implements McpTransport {
  private readonly tools = new Map<string, InMemoryTool>();
  private readonly resources = new Map<string, Resource & { read(): Promise<string> | string }>();
  private started = false;

  constructor(options: InMemoryTransportOptions = {}) {
    for (const tool of options.tools ?? []) this.tools.set(tool.name, tool);
    for (const resource of options.resources ?? []) this.resources.set(resource.uri, resource);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async close(): Promise<void> {
    this.started = false;
  }

  async listTools(): Promise<RemoteToolDescriptor[]> {
    this.assertStarted();
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  async callTool(name: string, args: JsonObject): Promise<JsonValue> {
    this.assertStarted();
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    return tool.handler(args);
  }

  async listResources(): Promise<Resource[]> {
    this.assertStarted();
    return [...this.resources.values()].map(({ uri, name, mimeType }) => ({ uri, name, mimeType }));
  }

  async readResource(uri: string): Promise<string> {
    this.assertStarted();
    const resource = this.resources.get(uri);
    if (!resource) throw new Error(`Unknown MCP resource: ${uri}`);
    return resource.read();
  }

  private assertStarted(): void {
    if (!this.started) throw new Error("Transport is not started; call start() first");
  }
}
