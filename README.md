# MCP Orchestrator SDK

A modular, type-safe SDK for orchestrating AI agents, tools, MCP integrations and
deterministic workflows. It abstracts a previously monolithic orchestration
architecture into independent, composable packages.

## Packages

| Package | Description |
|---------|-------------|
| [`@mcp-orchestrator/core`](packages/core) | Orchestration engine: tool registry, agent registry, hook manager, orchestrator |
| [`@mcp-orchestrator/mcp`](packages/mcp) | MCP abstraction: transport-agnostic client and multi-MCP pool |
| [`@mcp-orchestrator/state`](packages/state) | Entity-based state management with pluggable, reactive backends |
| [`@mcp-orchestrator/workflow`](packages/workflow) | Deterministic workflow runtime with expression interpolation and audit trails |
| [`@mcp-orchestrator/reference-impl`](packages/reference-impl) | Reference domains showing how to wire everything together |

## Getting started

```bash
npm install
npm run build
npm test
```

## Design goals

- **Decoupled** — each layer can be replaced or extended independently.
- **Type-safe** — TypeScript + Zod across the whole pipeline.
- **Transport-agnostic** — MCPs over any transport (in-process, stdio, HTTP, …).
- **Composable** — workflows and agents are first-class, declarative values.
- **Observable** — structured audit trails for every tool and workflow call.

See [`docs/architecture.md`](docs/architecture.md) for the full design and
[`examples/`](examples) for runnable usage.

## License

MIT
