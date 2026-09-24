import type { JsonObject, JsonValue } from "@mcp-orchestrator/core";

/** A stored entity: any JSON object identified by a string `id`. */
export type Entity = JsonObject & { id: string };

/** Equality filter over entity fields, with an optional result cap. */
export interface EntityQuery {
  /** Match entities whose fields deep-equal each of these values. */
  where?: Record<string, JsonValue>;
  limit?: number;
}

/** A full-text search hit. */
export interface SearchResult {
  readonly collection: string;
  readonly entity: Entity;
  /** Number of field matches; higher is more relevant. */
  readonly score: number;
}

export type StateChangeType = "set" | "update" | "delete";

/** Emitted whenever an entity is created, updated or removed. */
export interface StateChangeEvent {
  readonly type: StateChangeType;
  readonly collection: string;
  readonly id: string;
  /** The entity after the change (absent for deletes). */
  readonly entity?: Entity;
  /** The entity before the change (absent for the first `set`). */
  readonly previous?: Entity;
}

/**
 * The pluggable persistence contract. Backends are pure storage — they know
 * nothing about querying, search or reactivity, which the StateManager layers
 * on top. Implement this to back state with SQL, a document store, a graph, etc.
 */
export interface StateBackend {
  get(collection: string, id: string): Promise<Entity | undefined>;
  set(collection: string, id: string, entity: Entity): Promise<void>;
  delete(collection: string, id: string): Promise<boolean>;
  /** Every entity in a collection. */
  list(collection: string): Promise<Entity[]>;
  /** Names of all non-empty collections. */
  collections(): Promise<string[]>;
}
