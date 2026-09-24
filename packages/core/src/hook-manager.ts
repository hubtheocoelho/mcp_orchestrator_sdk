import type { AgentConfig, JsonObject, ToolCall, ToolResult } from "./types.js";

/** Handle returned when subscribing to a hook; call to detach the handler. */
export interface Subscription {
  unsubscribe(): void;
}

/** A hook handler may be async; throwing from a `before*` hook vetoes the action. */
export type HookHandler<Payload> = (payload: Payload) => void | Promise<void>;

/** Payload for tool lifecycle hooks. `params` is mutable so hooks can rewrite it. */
export interface BeforeToolCallPayload {
  readonly toolId: string;
  readonly caller: string;
  params: JsonObject;
}

export interface AfterToolCallPayload {
  readonly call: ToolCall;
  readonly result: ToolResult;
}

export interface AgentEventPayload {
  readonly config: AgentConfig;
}

export interface ErrorEventPayload {
  readonly scope: string;
  readonly error: Error;
}

/** The standard set of lifecycle events emitted by the orchestrator. */
export type HookEventMap = {
  beforeToolCall: BeforeToolCallPayload;
  afterToolCall: AfterToolCallPayload;
  agentSpawn: AgentEventPayload;
  error: ErrorEventPayload;
};

/**
 * Event-driven hook manager. Handlers for an event run in registration order;
 * `emit` awaits each, so a `before*` handler can veto by throwing.
 */
export class HookManager<Events extends Record<string, unknown> = HookEventMap> {
  private readonly handlers = new Map<keyof Events, Set<HookHandler<unknown>>>();

  on<E extends keyof Events>(event: E, handler: HookHandler<Events[E]>): Subscription {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as HookHandler<unknown>);
    return {
      unsubscribe: () => {
        this.handlers.get(event)?.delete(handler as HookHandler<unknown>);
      },
    };
  }

  /** Register a handler that detaches itself after the first invocation. */
  once<E extends keyof Events>(event: E, handler: HookHandler<Events[E]>): Subscription {
    const sub = this.on(event, async (payload) => {
      sub.unsubscribe();
      await handler(payload);
    });
    return sub;
  }

  off<E extends keyof Events>(event: E, handler: HookHandler<Events[E]>): void {
    this.handlers.get(event)?.delete(handler as HookHandler<unknown>);
  }

  /** Run all handlers for an event sequentially, awaiting each. */
  async emit<E extends keyof Events>(event: E, payload: Events[E]): Promise<void> {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      await handler(payload);
    }
  }

  listenerCount<E extends keyof Events>(event: E): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  removeAll(event?: keyof Events): void {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
  }
}
