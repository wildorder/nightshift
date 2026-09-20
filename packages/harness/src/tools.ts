/**
 * The worker operations, as functions (contract v1, D-P5-01, A-37).
 *
 * A worker reaches Nightshift through exactly four operations: say what it is
 * doing, say it is done, say it is stuck, and record a decision. Version 0 of
 * the contract offered one way to carry them, "spawn this MCP server next to the
 * worker", which is the right transport for a harness that is a local process
 * and an impossible one for a harness that is not.
 *
 * So the execution layer hands every adapter the operations themselves, beside
 * the MCP launch. A local-process adapter ignores these and passes the launch
 * through, and the worker-role MCP server it spawns calls this same
 * implementation. An adapter whose harness can call back into the adapter's own
 * process (P9's) uses these directly. **Exactly one transport per worker**: an
 * adapter that offered a worker both would let one job be reported twice.
 *
 * There is one implementation, in `@nightshift/execution`, and it is built over
 * stores that hold the *worker's* execution token (A-35), so an operation called
 * here is written as the worker, never as the human who launched the run.
 *
 * Deliberately four and no more. Anything else a harness wants belongs behind
 * `Harness.start`.
 */
import type {
  CommitSha,
  Decision,
  DecisionAlternative,
  Reversibility,
} from "@nightshift/contracts";

/** What `complete` found. The job is already durably recorded either way. */
export type WorkerCompletion =
  | {
      readonly kind: "implemented";
      readonly commitSha: CommitSha;
      readonly changedPaths: readonly string[];
    }
  | {
      /**
       * The snapshot touched paths outside the node's effective scope. The job is
       * **already durably failed** by the time this is returned; the worker is
       * being told, not asked.
       */
      readonly kind: "scope_violation";
      readonly offending: readonly string[];
      readonly reason: string;
    };

export interface WorkerDecisionInput {
  readonly context: string;
  readonly alternatives: readonly DecisionAlternative[];
  readonly choice: string;
  readonly rationale: string;
  readonly reversibility: Reversibility;
}

/** Raised by `recordDecision` when the run has no checkpoint to record against. */
export class NoCheckpointError extends Error {
  override readonly name = "NoCheckpointError";
  constructor() {
    super("this run has no checkpoint to record a decision against");
  }
}

export interface WorkerTools {
  /** Intent, not ground truth: recorded as `node.progress` with source `mcp` (A-30). */
  progress(message: string, percent?: number): Promise<void>;
  /**
   * Snapshots the worktree into one Nightshift-authored commit, checks every
   * changed path against the node's scope, and moves the node to `implemented`
   * and no further (A-05, A-29).
   */
  complete(summary: string): Promise<WorkerCompletion>;
  /** Durable failure with the worker's own reason. */
  fail(reason: string): Promise<void>;
  /** A decision on the worker's own node, against the run's latest checkpoint. */
  recordDecision(input: WorkerDecisionInput): Promise<Decision>;
}

/**
 * Tools that refuse every call, for a start input that describes no real job: an
 * adapter's unit test, or a fixture that only exercises a handle's lifecycle.
 */
export const refusingWorkerTools = (why: string): WorkerTools => {
  const refuse = async (): Promise<never> => {
    throw new Error(why);
  };
  return { progress: refuse, complete: refuse, fail: refuse, recordDecision: refuse };
};
