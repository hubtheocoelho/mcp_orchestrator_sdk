import type { Entity, StateBackend } from "../types.js";

/**
 * A simple in-memory backend. Stores a deep copy of each entity so callers can
 * never mutate stored state by holding a reference. Suitable for tests, caches
 * and single-process deployments; swap it for a durable backend in production.
 */
export class InMemoryBackend implements StateBackend {
  private readonly store = new Map<string, Map<string, Entity>>();

  async get(collection: string, id: string): Promise<Entity | undefined> {
    const entity = this.store.get(collection)?.get(id);
    return entity ? clone(entity) : undefined;
  }

  async set(collection: string, id: string, entity: Entity): Promise<void> {
    let col = this.store.get(collection);
    if (!col) {
      col = new Map();
      this.store.set(collection, col);
    }
    col.set(id, clone(entity));
  }

  async delete(collection: string, id: string): Promise<boolean> {
    const col = this.store.get(collection);
    if (!col) return false;
    const existed = col.delete(id);
    if (col.size === 0) this.store.delete(collection);
    return existed;
  }

  async list(collection: string): Promise<Entity[]> {
    return [...(this.store.get(collection)?.values() ?? [])].map(clone);
  }

  async collections(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
