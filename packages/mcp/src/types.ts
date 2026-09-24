import type { JsonObject, JsonSchema, JsonValue } from "@mcp-orchestrator/core";

/** A tool as advertised by a remote MCP server. */
export interface RemoteToolDescriptor {
  readonly name: string;
  readonly description?: string;
  /** JSON schema for the tool's arguments (MCP calls this `inputSchema`). */
  readonly inputSchema?: JsonSchema;
}

/** A resource advertised by a remote MCP server. */
export interface Resource {
  readonly uri: string;
  readonly name?: string;
  readonly mimeType?: string;
}

/**
 * A transport is the only thing that knows *how* an MCP is reached — in-process,
 * stdio, HTTP, WebSocket, etc. The client and pool are written entirely against
 * this interface, so adding a new transport requires no changes elsewhere.
 */
export interface McpTransport {
  /** Establish the connection / start the server process. */
  start(): Promise<void>;
  /** Tear the connection down. */
  close(): Promise<void>;
  /** List the tools the remote exposes. */
  listTools(): Promise<RemoteToolDescriptor[]>;
  /** Invoke a remote tool by its (un-namespaced) name. */
  callTool(name: string, args: JsonObject): Promise<JsonValue>;
  /** Optional resource support. */
  listResources?(): Promise<Resource[]>;
  readResource?(uri: string): Promise<string>;
}
