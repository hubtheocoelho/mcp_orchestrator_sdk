import type { ExpressionScope } from "./expression.js";

/** Snapshot of a workflow execution state at a specific step. */
export interface WorkflowCheckpoint {
  readonly workflowId: string;
  readonly stepIndex: number;
  readonly state: ExpressionScope;
  readonly timestamp: number;
}

/** Abstract storage backend for workflow checkpoints. */
export interface CheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  load(workflowId: string): Promise<WorkflowCheckpoint | null>;
  clear(workflowId?: string): Promise<void>;
  delete?(workflowId: string): Promise<void>;
}

/** In-memory checkpoint store suitable for tests and ephemeral runs. */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly store = new Map<string, WorkflowCheckpoint>();

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    this.store.set(checkpoint.workflowId, { ...checkpoint });
  }

  async load(workflowId: string): Promise<WorkflowCheckpoint | null> {
    const cp = this.store.get(workflowId);
    return cp ? { ...cp } : null;
  }

  async clear(workflowId?: string): Promise<void> {
    if (workflowId) {
      this.store.delete(workflowId);
    } else {
      this.store.clear();
    }
  }

  async delete(workflowId: string): Promise<void> {
    await this.clear(workflowId);
  }
}
