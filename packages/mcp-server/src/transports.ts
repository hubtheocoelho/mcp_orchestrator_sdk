import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpWorkflowServer } from "./server.js";

/** Serve over stdin/stdout (for clients that launch the server as a subprocess). */
export async function serveStdio(workflows: McpWorkflowServer): Promise<Server> {
  return workflows.connect(new StdioServerTransport());
}

/** A Node HTTP handler for the MCP endpoint (mount it on e.g. `POST/GET/DELETE /mcp`). */
export type StreamableHttpHandler = ((
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
) => Promise<void>) & {
  /** Close every open session. */
  close(): Promise<void>;
};

/**
 * Streamable HTTP transport with one session (and one protocol `Server`) per
 * client, keyed by the `mcp-session-id` header.
 */
export function createStreamableHttpHandler(workflows: McpWorkflowServer): StreamableHttpHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const handler = async (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> => {
    const body = parsedBody ?? (req.method === "POST" ? await readJson(req) : undefined);
    const header = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;

    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId || req.method !== "POST" || !isInitialize(body)) {
        sendJsonRpcError(res, sessionId ? 404 : 400, sessionId ? "Session not found" : "No valid session; send initialize first");
        return;
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) sessions.delete(created.sessionId);
      };
      await workflows.connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  };

  return Object.assign(handler, {
    async close(): Promise<void> {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((t) => t.close()));
    },
  });
}

function isInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}
