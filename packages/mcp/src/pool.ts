import type { JsonObject, JsonValue, ToolDefinition } from "@mcp-orchestrator/core";
import { McpClient } from "./client.js";
import type { McpCallOptions } from "./types.js";

/** Thrown when referencing an MCP id that is not in the pool. */
export class McpNotFoundError extends Error {
  constructor(readonly mcpId: string) {
    super(`MCP not found in pool: ${mcpId}`);
    this.name = "McpNotFoundError";
  }
}

/**
 * Manages a set of {@link McpClient}s as a single unit: connect/disconnect them
 * together, aggregate their tool definitions for bulk registration, and route
 * calls to the right client. Multiplexing many MCPs behind one façade.
 */
export class McpPool {
  private readonly clients = new Map<string, McpClient>();

  /** Add a client to the pool (does not connect it). */
  add(client: McpClient): this {
    this.clients.set(client.id, client);
    return this;
  }

  remove(mcpId: string): boolean {
    return this.clients.delete(mcpId);
  }

  get(mcpId: string): McpClient | undefined {
    return this.clients.get(mcpId);
  }

  require(mcpId: string): McpClient {
    const client = this.clients.get(mcpId);
    if (!client) throw new McpNotFoundError(mcpId);
    return client;
  }

  ids(): string[] {
    return [...this.clients.keys()];
  }

  /** Connect every client, in parallel. */
  async connectAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.connect()));
  }

  /** Disconnect every client, in parallel. Errors are collected, not swallowed. */
  async disconnectAll(): Promise<void> {
    const results = await Promise.allSettled([...this.clients.values()].map((c) => c.disconnect()));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length > 0) {
      throw new AggregateError(
        failed.map((f) => f.reason),
        `Failed to disconnect ${failed.length} MCP client(s)`,
      );
    }
  }

  /** Aggregate namespaced tool definitions across every client in the pool. */
  async listToolDefinitions(): Promise<ToolDefinition[]> {
    const perClient = await Promise.all(
      [...this.clients.values()].map((c) => c.listToolDefinitions()),
    );
    return perClient.flat();
  }

  /** Call a specific MCP's tool directly, bypassing the registry. */
  async callTool(
    mcpId: string,
    toolName: string,
    params: JsonObject,
    options?: McpCallOptions,
  ): Promise<JsonValue> {
    return this.require(mcpId).callTool(toolName, params, options);
  }
}
