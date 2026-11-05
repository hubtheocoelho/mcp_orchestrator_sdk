import type { ExpressionScope } from "./expression.js";

/** Snapshot of a workflow execution state at a specific step. */
export interface WorkflowCheckpoint {
  readonly workflowId: string;
  /** The run this checkpoint belongs to; concurrent runs never share a checkpoint. */
  readonly runId: string;
  readonly stepIndex: number;
  readonly state: ExpressionScope;
  readonly timestamp: number;
}

/** Abstract storage backend for workflow checkpoints, keyed by `workflowId` + `runId`. */
export interface CheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  /**
   * Load the checkpoint of a specific run, or — when `runId` is omitted — the
   * most recently saved checkpoint of any run of the workflow.
   */
  load(workflowId: string, runId?: string): Promise<WorkflowCheckpoint | null>;
  /** Remove one run's checkpoint, every checkpoint of a workflow, or everything. */
  clear(workflowId?: string, runId?: string): Promise<void>;
}

/** In-memory checkpoint store suitable for tests and ephemeral runs. */
export class InMemoryCheckpointStore implements CheckpointStore {
  /** workflowId → runId → checkpoint (Map keeps save order for "latest"). */
  private readonly store = new Map<string, Map<string, WorkflowCheckpoint>>();

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    let runs = this.store.get(checkpoint.workflowId);
    if (!runs) {
      runs = new Map();
      this.store.set(checkpoint.workflowId, runs);
    }
    runs.delete(checkpoint.runId); // re-insert so the latest save is last
    runs.set(checkpoint.runId, { ...checkpoint });
  }

  async load(workflowId: string, runId?: string): Promise<WorkflowCheckpoint | null> {
    const runs = this.store.get(workflowId);
    if (!runs) return null;
    const cp = runId !== undefined ? runs.get(runId) : [...runs.values()].at(-1);
    return cp ? { ...cp } : null;
  }

  async clear(workflowId?: string, runId?: string): Promise<void> {
    if (workflowId === undefined) {
      this.store.clear();
      return;
    }
    if (runId === undefined) {
      this.store.delete(workflowId);
      return;
    }
    const runs = this.store.get(workflowId);
    runs?.delete(runId);
    if (runs?.size === 0) this.store.delete(workflowId);
  }
}
