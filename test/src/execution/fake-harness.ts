/**
 * A harness that runs its "worker" in this process.
 *
 * T5's tests are about the execution layer, not about a child process, so the
 * fake is deliberately in-process: a script gets the worktree and the identity,
 * does whatever a worker would do — edit files, call the worker-side functions,
 * exit — and the runner cannot tell the difference, because it only ever sees
 * `@nightshift/harness`.
 *
 * T9's scripted harness is the out-of-process one, spawning a real `node` child
 * that speaks to a real worker MCP server over stdio. Both exist, and neither
 * replaces the other: this one isolates the execution layer, that one proves the
 * stdio lifecycle and the role split.
 *
 * The fake emits `agent.started` and exactly one ending through the `HookSink`
 * **without the script's cooperation**, which is the version-0 promise every
 * adapter makes (D-P3-09).
 */

import { writeFile } from "node:fs/promises";
import type { AgentId, AgentStatus, ExecutionNodeId, JobContractId } from "@nightshift/contracts";
import type { WorkerIdentity } from "@nightshift/execution";
import type {
  Duration,
  Harness,
  HarnessExit,
  HarnessHandle,
  HarnessStartInput,
  HookSink,
} from "@nightshift/harness";
import { agentStatusForExit, hookTypeForExit } from "@nightshift/harness";

export interface ScriptContext {
  readonly worktree: string;
  readonly identity: WorkerIdentity;
  /** The script may emit its own hook events, as a real adapter's parser would. */
  readonly sink: HookSink;
  readonly input: HarnessStartInput;
  /** Resolves once `cancel` has been called, for a script that waits to be stopped. */
  readonly cancelled: Promise<void>;
}

/** What a scripted worker does. Its return value is how the process "exits". */
export type HarnessScript = (context: ScriptContext) => Promise<HarnessExit>;

export interface FakeHarnessOptions {
  readonly script: HarnessScript;
  readonly id?: string;
  /** Called at the top of `start`, before anything else, for SC-P3-02. */
  readonly onStart?: (input: HarnessStartInput) => Promise<void> | void;
  /** Writes this to the transcript path, so the upload path is exercised. */
  readonly transcript?: string;
  /**
   * Emit no ending at all, standing in for an adapter that reports nothing.
   *
   * D-P3-09 requires terminal state from observing a process rather than from
   * an adapter's cooperation, so the runner has a backstop; this is how a test
   * makes that backstop the only emitter. See `lifecycle.test.ts`.
   */
  readonly silentEnding?: boolean;
}

interface FakeState {
  settled: HarnessExit | undefined;
  cancelling: boolean;
}

/**
 * The ending a well-behaved adapter emits, from the shared mapping.
 *
 * Its own function so `silentEnding` is one line at the call site rather than a
 * branch wrapped around fifteen.
 */
const emitEnding = (sink: HookSink, settled: HarnessExit): void => {
  sink.emit({
    type: hookTypeForExit(settled),
    occurredAt: new Date().toISOString(),
    payload:
      settled.kind === "failed"
        ? { exitCode: settled.exitCode }
        : settled.kind === "interrupted"
          ? { signal: settled.signal }
          : {},
  });
};

export const createFakeHarness = (options: FakeHarnessOptions): Harness => {
  const states = new Map<AgentId, FakeState>();
  const cancels = new Map<AgentId, () => void>();

  return {
    id: options.id ?? "fake",
    capabilities: { usage: false },

    start: async (input) => {
      // Before anything: the caller's chance to assert that the central record
      // already knows about this work (SC-P3-02, A-04).
      await options.onStart?.(input);

      const state: FakeState = { settled: undefined, cancelling: false };
      states.set(input.agent.agentId, state);

      const now = new Date().toISOString();
      input.sink.emit({
        type: "agent.started",
        occurredAt: now,
        payload: { harness: options.id ?? "fake", model: input.model.model },
      });

      if (options.transcript !== undefined && input.transcriptPath !== undefined) {
        await writeFile(input.transcriptPath, options.transcript, "utf8");
      }

      const identity: WorkerIdentity = {
        scope: {
          projectId: input.node.projectId,
          programId: input.node.programId,
          runId: input.node.runId,
        },
        executionNodeId: input.node.executionNodeId as ExecutionNodeId,
        jobContractId: input.job.jobContractId as JobContractId,
        agentId: input.agent.agentId,
        worktree: input.worktree,
      };

      let releaseCancel = (): void => {};
      const cancelled = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      cancels.set(input.agent.agentId, releaseCancel);

      const exit = (async (): Promise<HarnessExit> => {
        let outcome: HarnessExit;
        try {
          outcome = await options.script({
            worktree: input.worktree,
            identity,
            sink: input.sink,
            input,
            cancelled,
          });
        } catch (error) {
          // A script that threw is a worker process that crashed.
          outcome = { kind: "failed", exitCode: 1 };
          void error;
        }
        // A cancel in flight wins: the process stopped because we asked.
        const settled = state.cancelling ? ({ kind: "cancelled" } as const) : outcome;
        state.settled = settled;
        if (options.silentEnding !== true) emitEnding(input.sink, settled);
        return settled;
      })();

      const handle: HarnessHandle = {
        agentId: input.agent.agentId,
        pid: 424242,
        exit,
        ...(input.transcriptPath === undefined || options.transcript === undefined
          ? {}
          : { transcript: input.transcriptPath }),
      };
      return handle;
    },

    cancel: async (handle: HarnessHandle, _grace: Duration) => {
      const state = states.get(handle.agentId);
      if (state === undefined || state.settled !== undefined) return;
      state.cancelling = true;
      cancels.get(handle.agentId)?.();
      await handle.exit;
    },

    status: async (handle: HarnessHandle): Promise<AgentStatus> => {
      const state = states.get(handle.agentId);
      if (state?.settled !== undefined) return agentStatusForExit(state.settled);
      return "started";
    },
  };
};
