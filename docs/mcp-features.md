# MCP Protocol Support Matrix (Spec 2024-11 / Runtime 2026)

This document describes the MCP features supported across `@mcp-orchestrator/mcp` and `@mcp-orchestrator/core`.

| Feature | Supported | Client API | Description |
|---|---|---|---|
| **Tools (`tools/list`, `tools/call`)** | ✅ Yes | `getTools()`, `callTool()` | Discover and invoke remote tools with schema validation |
| **Resources (`resources/list`, `resources/read`)** | ✅ Yes | `listResources()`, `readResource(uri)` | Query and read text/binary resources exposed by servers |
| **Prompts (`prompts/list`, `prompts/get`)** | ✅ Yes | `listPrompts()`, `getPrompt(name, args)` | Retrieve reusable prompt templates and arguments |
| **Sampling (`sampling/createMessage`)** | ✅ Yes | `samplingHandler` option | Allows server to request model completions from client |
| **Progress (`notifications/progress`)** | ✅ Yes | `onProgress` option | Real-time progress updates for long-running tool runs |
| **Roots (`roots/list`)** | ✅ Yes | `setRoots(roots)` | Informs servers about client workspace directories |
| **Cancellation (`notifications/cancelled`)** | ✅ Yes | `signal` option / `AbortSignal` | Cooperative cancellation of requests in flight |

## Sampling (Client Completion)

When an MCP server requires LLM intelligence (e.g. to synthesize content or refine arguments), it issues a `sampling/createMessage` request to the client. The client delegates to the user-supplied handler:

```typescript
const client = new McpClient({
  id: "agentic-server",
  transport,
  samplingHandler: async (req) => {
    // Call LLM provider (Anthropic, Gemini, OpenAI, etc.)
    return {
      role: "assistant",
      content: { type: "text", text: "Completion response" },
      model: "claude-3-7-sonnet",
      stopReason: "endTurn",
    };
  },
});
```

## Progress Notifications

For tools with non-trivial runtimes, progress notifications are forwarded to the client's `onProgress` callback:

```typescript
const client = new McpClient({
  id: "data-cruncher",
  transport,
  onProgress: (notification) => {
    console.log(`Progress on ${notification.progressToken}: ${notification.progress}/${notification.total}`);
  },
});
```
