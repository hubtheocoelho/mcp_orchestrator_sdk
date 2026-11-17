import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { InputRequest } from "@mcp-orchestrator/workflow";

/** A run paused in Mode B, waiting for the client to resume it. */
export interface SuspendedRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId: string;
  readonly request: InputRequest;
  /** SHA-256 of the resume token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly createdAt: number;
}

/**
 * Storage for Mode B suspensions, keyed by `runId`. Use a durable
 * implementation in production, next to a durable `CheckpointStore`.
 */
export interface SuspensionStore {
  save(run: SuspendedRun): Promise<void>;
  get(runId: string): Promise<SuspendedRun | null>;
  /**
   * Atomically remove the entry when its `tokenHash` still matches, so a token
   * is consumed at most once. Returns whether it was removed.
   */
  take(runId: string, tokenHash: string): Promise<boolean>;
}

/** In-memory {@link SuspensionStore}, for tests and development. */
export class InMemorySuspensionStore implements SuspensionStore {
  private readonly runs = new Map<string, SuspendedRun>();

  async save(run: SuspendedRun): Promise<void> {
    this.runs.set(run.runId, { ...run });
  }

  async get(runId: string): Promise<SuspendedRun | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async take(runId: string, tokenHash: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.tokenHash !== tokenHash) return false;
    this.runs.delete(runId);
    return true;
  }
}

/** A fresh, unguessable resume token. */
export function newResumeToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of a presented token against a stored hash. */
export function tokenMatches(token: string, tokenHash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(tokenHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
