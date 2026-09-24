import type { Agent, AgentConfig } from "./types.js";

/** Thrown when referencing an agent id that is not registered. */
export class AgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

/** Thrown when registering an agent id that already exists. */
export class DuplicateAgentError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent already registered: ${agentId}`);
    this.name = "DuplicateAgentError";
  }
}

/** Concrete agent handle built from a declarative config. */
class RegisteredAgent implements Agent {
  constructor(readonly config: AgentConfig) {}

  /**
   * Resolve which of the currently-registered tool ids this agent may call.
   * When `config.tools` is omitted the agent may use all tools; otherwise it is
   * restricted to the intersection of its allowlist and what actually exists.
   */
  allowedTools(all: readonly string[]): string[] {
    if (!this.config.tools) return [...all];
    const allowed = new Set(this.config.tools);
    return all.filter((id) => allowed.has(id));
  }
}

/** Declarative registry for agent lifecycle: register, look up and list agents. */
export class AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();

  /** Register a new agent. Throws {@link DuplicateAgentError} on id collision. */
  register(config: AgentConfig): Agent {
    if (this.agents.has(config.id)) throw new DuplicateAgentError(config.id);
    const agent = new RegisteredAgent(config);
    this.agents.set(config.id, agent);
    return agent;
  }

  /** Register or replace an agent, ignoring any existing one with the same id. */
  upsert(config: AgentConfig): Agent {
    const agent = new RegisteredAgent(config);
    this.agents.set(config.id, agent);
    return agent;
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /** Look up an agent or throw {@link AgentNotFoundError}. */
  require(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentNotFoundError(agentId);
    return agent;
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  ids(): string[] {
    return [...this.agents.keys()];
  }

  unregister(agentId: string): boolean {
    return this.agents.delete(agentId);
  }
}
