import type { OrchestratorEvent } from "./orchestrator-event.js";

/** Thrown when an operation is aborted via AbortSignal. */
export class OrchestratorAbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "OrchestratorAbortError";
  }
}

export interface PumpOptions {
  signal?: AbortSignal;
  /** Workflow id used for the synthetic terminal events the pump may add. */
  workflowId?: string;
  /** Event yielded when the signal aborts (defaults to `workflow.failed`). */
  onAbort?: () => OrchestratorEvent;
}

const isTerminal = (e: OrchestratorEvent): boolean =>
  e.type === "workflow.finished" || e.type === "workflow.failed";

/**
 * Bridge a callback-style producer to an async generator.
 *
 * - Events are yielded in emission order.
 * - The consumer is woken on every emit, when `run` settles, **and** when the
 *   signal aborts — so a tool that ignores its AbortSignal can never hang the
 *   stream. After an abort, a single abort event is yielded, later events are
 *   dropped, and `run` is left to settle in the background.
 * - When `workflowId` is set and `run` settles without a terminal event, a
 *   `workflow.finished` / `workflow.failed` event is synthesized.
 */
export async function* pumpEvents(
  run: (emit: (event: OrchestratorEvent) => void) => Promise<unknown>,
  options: PumpOptions = {},
): AsyncGenerator<OrchestratorEvent> {
  const { signal, workflowId } = options;
  const queue: OrchestratorEvent[] = [];
  let wake: (() => void) | undefined;
  const poke = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  let settled = false;
  let value: unknown;
  let error: unknown;
  let failed = false;
  let sawTerminal = false;

  const onAbort = () => poke();
  signal?.addEventListener("abort", onAbort, { once: true });

  run((event) => {
    if (settled || signal?.aborted) return;
    queue.push(event);
    poke();
  }).then(
    (v) => {
      value = v;
      settled = true;
      poke();
    },
    (e) => {
      error = e;
      failed = true;
      settled = true;
      poke();
    },
  );

  try {
    for (;;) {
      if (signal?.aborted) {
        if (!sawTerminal) {
          yield options.onAbort?.() ?? {
            type: "workflow.failed",
            workflowId: workflowId ?? "",
            error: new OrchestratorAbortError(),
          };
        }
        return;
      }
      const next = queue.shift();
      if (next) {
        if (isTerminal(next)) sawTerminal = true;
        yield next;
        continue;
      }
      if (settled) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    if (workflowId !== undefined && !sawTerminal) {
      yield failed
        ? { type: "workflow.failed", workflowId, error: error instanceof Error ? error : new Error(String(error)) }
        : { type: "workflow.finished", workflowId, result: value };
    } else if (failed && workflowId === undefined) {
      throw error;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
