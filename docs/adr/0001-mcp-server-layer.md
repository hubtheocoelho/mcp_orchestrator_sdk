# ADR 0001: Expose workflows as tools of an official-protocol MCP server

- **Status:** Accepted
- **Date:** 2026-11-17
- **Scope:** MVP

## Context

The orchestrator runs workflows that automate work across MCP servers. The
product we want is:

1. A developer installs the SDK and builds an **MCP server**.
2. **Each workflow is one tool** of that server.
3. An LLM session (Claude or any other MCP client) connects to the server and
   runs workflows by calling those tools.
4. A workflow can **hand control back to the LLM during execution** and carry on
   afterwards.

So the LLM is the MCP *client*, and the SDK's main job is the MCP *server*.

What the repository has today:

- `core`, `workflow` and `state` form a protocol-free engine. The executor
  already saves **checkpoints per run** and can **resume** a run by `runId`
  (`packages/workflow/src/checkpoint.ts`, `packages/workflow/src/executor.ts`).
- `@mcp-orchestrator/mcp` only covers the **opposite direction**: `McpClient` and
  `McpPool` let a workflow call *other* MCP servers.
- No package implements the official MCP protocol:
  - no dependency on `@modelcontextprotocol/sdk`;
  - no JSON-RPC 2.0 framing and no `initialize` / capability negotiation;
  - no stdio transport (the README and docstrings mention one, but it does not
    exist);
  - `HttpTransport` speaks a REST contract of its own (`GET /tools`,
    `POST /tools/:name/call`), not MCP.
- Nothing lets an LLM session reach a workflow, because there is no server.
- `docs/mcp-features.md` claims support for the 2024-11 spec that the code does
  not provide.
- No LLM is called from inside workflows. That stays out of scope (see
  *Out of scope*).

## Decision

### 1. A new `@mcp-orchestrator/mcp-server` package on the official SDK

- It depends on the **server** side of `@modelcontextprotocol/sdk`. The official
  SDK owns the protocol: JSON-RPC, `initialize`, capability negotiation and
  transports.
- It registers each workflow as an MCP tool. The tool's name, description and
  `inputSchema` come from the workflow definition.
- It ships **stdio** and **streamable HTTP** transports, using the ones the
  official SDK provides.
- `core`, `workflow` and `state` do **not** depend on the official SDK. The
  engine stays protocol-free, which keeps the rule that each layer depends only
  on `core`.
- `@mcp-orchestrator/mcp` (client side) is not part of the MVP path. Moving it
  onto the official SDK's client is covered by a separate decision.

### 2. Two ways to hand control back to the LLM, behind one signal

Workflow authors declare a single point where they need input from the LLM:
a `needsInput(request)` step or signal. The server decides at runtime how to
honour it, based on the `elicitation` capability the client sent in
`initialize`.

**Mode A: Elicitation, when the client supports it.**
The server sends `elicitation/create` from inside the same `tools/call`. The run
waits for the reply and continues on the **same `runId`**. The LLM sees one tool
call.

**Mode B: Explicit pause, when the client does not support it.**
The server saves a checkpoint and returns a structured result instead of
blocking:

```json
{
  "status": "suspended",
  "runId": "…",
  "resumeToken": "…",
  "request": { "message": "…", "schema": { } }
}
```

The LLM answers by calling the tool again with `runId`, `resumeToken` and the
input. The executor resumes from the checkpoint. The resume can go through a
dedicated `resume` tool or through a reserved argument on the workflow's own
tool. That choice is made during implementation.

Rules:

- The author writes the workflow **once**. The server picks the mode.
- A developer can force Mode B on a server, or on a single workflow, to control
  the resume flow by hand. Mode B is **required** for clients without
  elicitation, and developers must implement against it in that case.
- Both modes use the existing checkpoint and resume mechanism. Mode A resumes
  after the elicitation reply. Mode B resumes on the next tool call.
- A `resumeToken` is single-use and tied to its `runId`. Resuming with a stale or
  wrong token fails without changing the run.

## Consequences

**Benefits**

- Any spec-compliant MCP client can reach workflows, including Claude sessions
  and IDE agents.
- Protocol conformance comes from the official SDK rather than code we write and
  maintain.
- Clients with elicitation get one seamless call. Every other client still works
  through Mode B.
- The engine packages stay protocol-free and replaceable.

**Costs and risks**

- The server layer takes on a runtime dependency on `@modelcontextprotocol/sdk`
  and follows its release cycle.
- Mode B makes the LLM drive the resume. Tool descriptions and the `suspended`
  payload must be clear enough for a model to resume correctly.
- In Mode A a run is held in memory while it waits for the reply. We need a
  timeout policy and must define what happens when the client disconnects (for
  example, fall back to a saved checkpoint).
- Suspended runs need a durable `CheckpointStore` in production. The in-memory
  store only fits tests and development.

## Work to do (none of it exists yet)

1. `mcp-server` package: register workflows as tools, read capabilities during
   `initialize`, build on the official SDK.
2. Transports: stdio and streamable HTTP.
3. Executor: a `needsInput` / suspend signal, and its mapping to elicitation or
   to the `suspended` result.
4. The resume contract in the tool interface: `runId`, `resumeToken`, input
   validation against the request schema.
5. Documentation: fix `docs/mcp-features.md` and the `mcp` README so they stop
   claiming conformance the code lacks, and document the two modes.

## Out of scope

- Calling an LLM from inside a workflow (an AI step or agent loop). The LLM sits
  outside, as the MCP client.
- Moving `@mcp-orchestrator/mcp` (client side) onto the official SDK.
- MCP `sampling` from the server.
