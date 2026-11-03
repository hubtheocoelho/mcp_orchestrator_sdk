// src/http-transport.ts
// ---------------------------------------------------------------------
// Concrete MCP transport that talks to a remote MCP server over HTTP.
// ---------------------------------------------------------------------
//
// Why we need this:
//   • The SDK ships only an in‑memory transport (useful for tests).
//   • Production harnesses must call real MCP services that run in a
//     separate process, container, or remote machine.
//   • Implementing a transport that follows the `McpTransport` interface
//     allows the orchestrator to remain agnostic of the underlying protocol.
//
// Design goals:
//   1. Minimal dependencies – we use the native `fetch` API that is
//      available in Node >=18. If the project targets older Node versions,
//      the consumer can install `node-fetch` and assign it to globalThis.fetch.
//   2. Simple JSON‑over‑HTTP contract:
//        GET    /tools               -> RemoteToolDescriptor[]
//        POST   /tools/:name/call    -> { args: JsonObject } -> JsonValue
//        GET    /resources           -> Resource[]
//        GET    /resources/:uri      -> string (raw bytes as UTF‑8)
//   3. Transport lifecycle (`start`/`close`) mirrors the in‑memory version
//      but is essentially a no‑op – the HTTP client is ready immediately.
//   4. Errors are wrapped in a stable `Error` with a clear message so the
//      orchestrator can surface them in audit logs.
//
// Usage example (in a harness):
//   import { HttpTransport } from "@mcp-orchestrator/mcp";
//   const transport = new HttpTransport({ baseUrl: "http://localhost:8080" });
//   await transport.start();
//   const client = new McpClient({ transport, clientId: "my-harness" });
//   // register the client in an Orchestrator, then call tools or resources.
//
// ---------------------------------------------------------------

import type { JsonObject, JsonValue } from "@mcp-orchestrator/core";
import type { McpTransport, RemoteToolDescriptor, Resource } from "./types.js";

export interface HttpTransportOptions {
  /** Base URL of the remote MCP HTTP server, e.g. "http://localhost:8080" */
  baseUrl: string;
  /** Optional fetch implementation – defaults to globalThis.fetch */
  fetchImpl?: typeof fetch;
}

export class HttpTransport implements McpTransport {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private started = false;

  constructor(options: HttpTransportOptions) {
    if (!options.baseUrl) {
      throw new Error("HttpTransport requires a baseUrl option");
    }
    // Normalise – ensure no trailing slash to simplify URL construction.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (!this.fetch) {
      throw new Error(
        "fetch is not available – provide a fetchImpl or run on Node >=18",
      );
    }
  }

  /** No external resources to allocate; mark the transport as ready. */
  async start(): Promise<void> {
    this.started = true;
  }

  /** No persistent connections; simply toggle the flag. */
  async close(): Promise<void> {
    this.started = false;
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error("HttpTransport is not started; call start() first");
    }
  }

  // -------------------------------------------------------------------
  // Tool‑related methods
  // -------------------------------------------------------------------
  async listTools(): Promise<RemoteToolDescriptor[]> {
    this.assertStarted();
    const resp = await this.fetch(`${this.baseUrl}/tools`);
    if (!resp.ok) {
      throw new Error(`Failed to list tools: ${resp.status} ${resp.statusText}`);
    }
    // The server must return a JSON array matching RemoteToolDescriptor.
    const tools = (await resp.json()) as RemoteToolDescriptor[];
    return tools;
  }

  async callTool(name: string, args: JsonObject): Promise<JsonValue> {
    this.assertStarted();
    const resp = await this.fetch(`${this.baseUrl}/tools/${encodeURIComponent(name)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args }),
    });
    if (!resp.ok) {
      throw new Error(
        `Tool call failed (${name}): ${resp.status} ${resp.statusText}`,
      );
    }
    // The server returns the tool's result as JSON.
    return (await resp.json()) as JsonValue;
  }

  // -------------------------------------------------------------------
  // Resource‑related methods
  // -------------------------------------------------------------------
  async listResources(): Promise<Resource[]> {
    this.assertStarted();
    const resp = await this.fetch(`${this.baseUrl}/resources`);
    if (!resp.ok) {
      throw new Error(
        `Failed to list resources: ${resp.status} ${resp.statusText}`,
      );
    }
    const resources = (await resp.json()) as Resource[];
    return resources;
  }

  async readResource(uri: string): Promise<string> {
    this.assertStarted();
    const resp = await this.fetch(
      `${this.baseUrl}/resources/${encodeURIComponent(uri)}`,
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to read resource (${uri}): ${resp.status} ${resp.statusText}`,
      );
    }
    // Resources are returned as plain text (binary can be base64‑encoded if needed).
    return await resp.text();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /**
   * Gracefully shut down the transport. Idempotent — calling dispose() twice is safe.
   */
  async dispose(): Promise<void> {
    await this.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
