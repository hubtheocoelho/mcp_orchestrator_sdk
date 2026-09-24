# @mcp-orchestrator/examples

Runnable programs demonstrating the SDK. Build the workspace first (`npm run
build` at the repo root), then run any example with `tsx`.

| Example | Command | Shows |
|---------|---------|-------|
| [`basic-agent.ts`](src/basic-agent.ts) | `npm run -w @mcp-orchestrator/examples basic-agent` | Tool + agent allowlist, hooks, audit |
| [`workflow-execution.ts`](src/workflow-execution.ts) | `npm run -w @mcp-orchestrator/examples workflow` | Multi-step workflow, interpolation, conditional gate, JSONL audit |
| [`custom-mcp.ts`](src/custom-mcp.ts) | `npm run -w @mcp-orchestrator/examples custom-mcp` | In-process MCP via `InMemoryTransport`, discovery into the orchestrator |
| [`multi-agent-dispatch.ts`](src/multi-agent-dispatch.ts) | `npm run -w @mcp-orchestrator/examples multi-agent` | Reader/writer agents over a reactive state manager |

You can also run a file directly:

```bash
npx tsx examples/src/basic-agent.ts
```
