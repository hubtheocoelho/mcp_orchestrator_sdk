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

## Documentation

| Guide | Contents |
|-------|----------|
| [Getting started](docs/getting-started.md) | Install, first orchestrator, hooks, agents, workflows, MCP |
| [Architecture](docs/architecture.md) | Package graph, layers and design principles |
| [Workflow reference](docs/workflows.md) | Definition format, expression syntax, runtime semantics |
| [Extending](docs/extending.md) | Custom tools, transports, state backends, audit sinks, hooks |
| [Security model](docs/security.md) | What is enforced, what is not, known limitations |
| [API reference](docs/api-reference.md) | Public surface of every package |
| [Examples](examples) | Four runnable programs |

See also the [changelog](CHANGELOG.md) and the [contributing guide](CONTRIBUTING.md).

## License

[MIT](LICENSE)
