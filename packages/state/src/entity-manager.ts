import type { JsonObject, JsonValue, Subscription } from "@mcp-orchestrator/core";
import { InMemoryBackend } from "./backends/memory.js";
import type {
  Entity,
  EntityQuery,
  SearchResult,
  StateBackend,
  StateChangeEvent,
} from "./types.js";

type ChangeHandler = (event: StateChangeEvent) => void;

/**
 * Entity-based state manager. It wraps a pluggable {@link StateBackend} with the
 * higher-level concerns the backend deliberately omits: partial-update merging,
 * equality queries, naive full-text search and a reactive layer (per-entity
 * `watch` and global `onChanged`). It satisfies core's structural `StateAccess`,
 * so an Orchestrator can use it directly.
 */
export class StateManager {
  private readonly backend: StateBackend;
  private readonly globalHandlers = new Set<ChangeHandler>();
  private readonly watchers = new Map<string, Set<ChangeHandler>>();
  private disposed = false;

  constructor(backend: StateBackend = new InMemoryBackend()) {
    this.backend = backend;
  }

  // --- CRUD ---------------------------------------------------------------

  async get(collection: string, id: string): Promise<Entity | undefined> {
    return this.backend.get(collection, id);
  }

  async set(collection: string, id: string, entity: Entity): Promise<void> {
    const previous = await this.backend.get(collection, id);
    const next: Entity = { ...entity, id };
    await this.backend.set(collection, id, next);
    this.emit({ type: "set", collection, id, entity: next, previous });
  }

  /** Shallow-merge `patch` onto the existing entity, creating it if absent. */
  async update(collection: string, id: string, patch: JsonObject): Promise<Entity> {
    const previous = await this.backend.get(collection, id);
    const next: Entity = { ...(previous ?? {}), ...patch, id };
    await this.backend.set(collection, id, next);
    this.emit({ type: "update", collection, id, entity: next, previous });
    return next;
  }

  async delete(collection: string, id: string): Promise<boolean> {
    const previous = await this.backend.get(collection, id);
    const existed = await this.backend.delete(collection, id);
    if (existed) this.emit({ type: "delete", collection, id, previous });
    return existed;
  }

  // --- Query & search -----------------------------------------------------

  async query(collection: string, filter: EntityQuery = {}): Promise<Entity[]> {
    let entities = await this.backend.list(collection);
    if (filter.where) {
      const where = filter.where;
      entities = entities.filter((entity) =>
        Object.entries(where).every(([key, value]) => deepEqual(entity[key], value)),
      );
    }
    return typeof filter.limit === "number" ? entities.slice(0, filter.limit) : entities;
  }

  /** Naive full-text search: scores entities by how many fields contain `text`. */
  async search(text: string): Promise<SearchResult[]> {
    const needle = text.toLowerCase();
    const results: SearchResult[] = [];
    for (const collection of await this.backend.collections()) {
      for (const entity of await this.backend.list(collection)) {
        const score = Object.values(entity).filter((value) =>
          JSON.stringify(value).toLowerCase().includes(needle),
        ).length;
        if (score > 0) results.push({ collection, entity, score });
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }

  // --- Reactive -----------------------------------------------------------

  /** Watch a single entity for changes. */
  watch(collection: string, id: string, callback: (event: StateChangeEvent) => void): Subscription {
    const key = `${collection}\u0000${id}`;
    let set = this.watchers.get(key);
    if (!set) {
      set = new Set();
      this.watchers.set(key, set);
    }
    set.add(callback);
    return {
      unsubscribe: () => {
        this.watchers.get(key)?.delete(callback);
      },
    };
  }

  /** Observe every change across all collections. */
  onChanged(callback: (event: StateChangeEvent) => void): Subscription {
    this.globalHandlers.add(callback);
    return {
      unsubscribe: () => {
        this.globalHandlers.delete(callback);
      },
    };
  }

  private emit(event: StateChangeEvent): void {
    if (this.disposed) return;
    for (const handler of [...this.globalHandlers]) handler(event);
    const key = `${event.collection}\u0000${event.id}`;
    for (const handler of [...(this.watchers.get(key) ?? [])]) handler(event);
  }

  // --- Lifecycle ----------------------------------------------------------

  /**
   * Gracefully dispose the state manager, clearing active watchers and listeners.
   * Idempotent — calling dispose() twice is safe.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.globalHandlers.clear();
    this.watchers.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

function deepEqual(a: JsonValue | undefined, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
