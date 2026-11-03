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

/** A prompt template advertised by a remote MCP server. */
export interface PromptDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: Array<{
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }>;
}

/** The result of resolving (getting) a prompt. */
export interface PromptResult {
  readonly description?: string;
  readonly messages: Array<{
    readonly role: "user" | "assistant";
    readonly content: { readonly type: string; readonly text?: string; [key: string]: unknown };
  }>;
}

/** A sampling (completion) request from the MCP server to the client. */
export interface SamplingRequest {
  readonly messages: Array<{
    readonly role: "user" | "assistant";
    readonly content: { readonly type: string; readonly text?: string; [key: string]: unknown };
  }>;
  readonly modelPreferences?: {
    readonly hints?: Array<{ readonly name?: string }>;
    readonly costPriority?: number;
    readonly speedPriority?: number;
    readonly intelligencePriority?: number;
  };
  readonly systemPrompt?: string;
  readonly includeContext?: "none" | "thisServer" | "allServers";
  readonly temperature?: number;
  readonly maxTokens: number;
  readonly stopSequences?: string[];
  readonly metadata?: JsonObject;
}

/** The result returned by the client's sampling handler. */
export interface CompletionResult {
  readonly role: "user" | "assistant";
  readonly content: { readonly type: string; readonly text?: string; [key: string]: unknown };
  readonly model: string;
  readonly stopReason?: "endTurn" | "stopSequence" | "maxTokens" | string;
}

/** A root URI that the client exposes to the MCP server. */
export interface Root {
  readonly uri: string;
  readonly name?: string;
}

/** Progress notification from the server for a long-running tool call. */
export interface ProgressNotification {
  readonly progressToken: string | number;
  readonly progress: number;
  readonly total?: number;
}

/** Options passed to transport calls. */
export interface McpCallOptions {
  readonly signal?: AbortSignal;
  readonly requestId?: string;
  readonly onProgress?: (notification: ProgressNotification) => void;
}

/**
 * A transport is the only thing that knows *how* an MCP is reached — in-process,
 * stdio, HTTP, WebSocket, etc. The client and pool are written entirely against
 * this interface, so adding a new transport requires no changes elsewhere.
 */
export interface McpTransport {
  /** Establish the connection / start the server process. */
  start(options?: { signal?: AbortSignal }): Promise<void>;
  /** Tear the connection down. */
  close(options?: { signal?: AbortSignal }): Promise<void>;
  /** List the tools the remote exposes. */
  listTools(options?: { signal?: AbortSignal }): Promise<RemoteToolDescriptor[]>;
  /** Invoke a remote tool by its (un-namespaced) name. */
  callTool(name: string, args: JsonObject, options?: McpCallOptions): Promise<JsonValue>;
  /** Optional resource support. */
  listResources?(options?: { signal?: AbortSignal }): Promise<Resource[]>;
  readResource?(uri: string, options?: { signal?: AbortSignal }): Promise<string>;
  /** Optional prompt support. */
  listPrompts?(options?: { signal?: AbortSignal }): Promise<PromptDescriptor[]>;
  getPrompt?(name: string, args?: JsonObject, options?: { signal?: AbortSignal }): Promise<PromptResult>;
}
