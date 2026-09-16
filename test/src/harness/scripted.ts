/**
 * The scripted harness (T9 deliverable 2).
 *
 * A real `Harness`, spawning a **real child process** that speaks to a **real
 * worker-role MCP server** over stdio with the SDK's own client. What it does
 * not have is a model: the child follows a named script instead of thinking.
 *
 * ## Why not just fake the worker in-process
 *
 * Because the things the slice suite is meant to prove are exactly the things an
 * in-process fake would skip: that the worker role's tool surface works over
 * stdio, that the identity reaches the child through its environment, that a
 * killed process leaves durable state, and that hook events arrive from
 * *observing a process* rather than from a worker's cooperation. `test/src/
 * execution/fake-harness.ts` is the in-process one, and it isolates the
 * execution layer; this one proves the seams between processes.
 *
 * ## How the hook channel works here
 *
 * The same way a real adapter's does. The child writes a structured stream to
 * its stdout; this harness parses it and emits `tool.called` through the
 * `HookSink`. That is the child standing in for the *harness CLI's* output
 * stream, not for the model — which is why `silent-exit`, a script that calls
 * nothing and prints nothing, still yields `agent.started` and `agent.failed`
 * from the process lifecycle alone (SC-P3-12).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentId, AgentStatus } from "@nightshift/contracts";
import {
  agentStatusForExit,
  type Duration,
  type Harness,
  type HarnessExit,
  type HarnessHandle,
  type HarnessStartInput,
  hookTypeForExit,
  isHookEventType,
} from "@nightshift/harness";

/** What a scripted worker does. Chosen per test, or by `NIGHTSHIFT_SCRIPT`. */
export type ScriptName =
  /** Read a file, edit it, add a test, report progress twice, complete, exit 0. */
  | "implement"
  /** As `implement`, but the added test fails. */
  | "implement-broken"
  /** Edit a file outside the job's includes, then complete. */
  | "out-of-scope"
  /** Report progress once, then wait until killed. */
  | "hang"
  /** Call `job.fail` with a reason, exit 0. */
  | "fail"
  /** Edit, then exit 1 without reporting anything at all. */
  | "silent-exit";

export const SCRIPT_NAMES: readonly ScriptName[] = [
  "implement",
  "implement-broken",
  "out-of-scope",
  "hang",
  "fail",
  "silent-exit",
];

export const SCRIPT_ENV = "NIGHTSHIFT_SCRIPT";

/** How the child is told what to do and who to talk to. */
export const WORKER_SCRIPT_ENV = "NIGHTSHIFT_WORKER_SCRIPT";
export const WORKER_MCP_ENV = "NIGHTSHIFT_WORKER_MCP";
export const WORKER_WORKTREE_ENV = "NIGHTSHIFT_WORKER_WORKTREE";

/** The built child entry point, resolved from this module's own location. */
export const workerEntry = (): string => fileURLToPath(new URL("./worker.js", import.meta.url));

export interface ScriptedHarnessOptions {
  readonly script: ScriptName;
  /** Node executable. The current one unless a test wants otherwise. */
  readonly node?: string;
  readonly entry?: string;
}

interface Running {
  readonly child: ChildProcess;
  settled: HarnessExit | undefined;
  cancelling: boolean;
}

/** One line of the child's structured stream. */
interface ChildFrame {
  readonly hook?: string;
  readonly payload?: Record<string, unknown>;
  readonly note?: string;
}

/** Reads the child's newline-delimited frames, tolerating partial chunks. */
const readFrames = (child: ChildProcess, onFrame: (frame: ChildFrame) => void): void => {
  let buffered = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    // The last element is whatever came after the final newline: a partial line,
    // or an empty string. Either way it waits for the next chunk.
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        onFrame(JSON.parse(line) as ChildFrame);
      } catch {
        // Not a frame. A real adapter's stream carries lines it does not
        // recognise too, and skipping one is not a reason to stop reading.
      }
    }
  });
};

/** How a closed process ended: a signal, a clean exit, or a code. */
const closedAs = (code: number | null, signal: NodeJS.Signals | null): HarnessExit => {
  if (signal !== null) return { kind: "interrupted", signal };
  return code === 0 ? { kind: "completed" } : { kind: "failed", exitCode: code ?? 1 };
};

const exitPayload = (exit: HarnessExit): Record<string, unknown> => {
  if (exit.kind === "failed") return { exitCode: exit.exitCode };
  if (exit.kind === "interrupted") return { signal: exit.signal };
  return {};
};

/** The end of the child's stderr, bounded, for a failure a human has to read. */
const tail = (stderr: string): Record<string, unknown> =>
  stderr === "" ? {} : { stderr: stderr.slice(-500) };

export const createScriptedHarness = (options: ScriptedHarnessOptions): Harness => {
  const running = new Map<AgentId, Running>();

  return {
    id: "scripted",

    start: async (input: HarnessStartInput): Promise<HarnessHandle> => {
      const emit = (type: string, payload: Record<string, unknown>): void => {
        if (!isHookEventType(type)) return;
        input.sink.emit({ type, occurredAt: new Date().toISOString(), payload });
      };

      // Before anything the child does, and without its cooperation.
      emit("agent.started", {
        harness: "scripted",
        script: (input.mcp.env[WORKER_SCRIPT_ENV] as string | undefined) ?? options.script,
      });

      // The script is this harness's, unless the start input names one. A real
      // adapter's behaviour is fixed by the CLI it drives; this harness is asked
      // to play several parts, and the per-start override is how the conformance
      // fixture gets a completing worker and a hanging one from one harness.
      const script = (input.mcp.env[WORKER_SCRIPT_ENV] as ScriptName | undefined) ?? options.script;

      const child = spawn(options.node ?? process.execPath, [options.entry ?? workerEntry()], {
        cwd: input.worktree,
        env: {
          // A small, explicit environment, as a real adapter builds (T4, T8).
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          [WORKER_SCRIPT_ENV]: script,
          [WORKER_WORKTREE_ENV]: input.worktree,
          // The worker's own MCP server: command, args and the seven identity
          // variables, passed through byte for byte.
          [WORKER_MCP_ENV]: JSON.stringify(input.mcp),
        },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so a cancel can kill the child *and* the MCP
        // server it spawned rather than orphaning the grandchild.
        detached: process.platform !== "win32",
      });

      const state: Running = { child, settled: undefined, cancelling: false };
      running.set(input.agent.agentId, state);

      // The child's stdout is this harness's "output stream": the same place a
      // real adapter reads its provider's events from.
      readFrames(child, (frame) => {
        if (frame.hook !== undefined) emit(frame.hook, frame.payload ?? {});
      });
      // Kept, not printed: a test that fails wants to see what the child said.
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const exit = new Promise<HarnessExit>((resolve) => {
        const settle = (outcome: HarnessExit): void => {
          if (state.settled !== undefined) return;
          // A cancel in flight wins: the process stopped because we asked.
          const final = state.cancelling ? ({ kind: "cancelled" } as const) : outcome;
          state.settled = final;
          emit(hookTypeForExit(final), { ...exitPayload(final), ...tail(stderr) });
          resolve(final);
        };

        // A spawn that never happened is a failure, never a rejected promise.
        child.on("error", () => {
          settle({ kind: "failed", exitCode: 127 });
        });
        child.on("close", (code, signal) => {
          settle(closedAs(code, signal));
        });
      });

      return {
        agentId: input.agent.agentId,
        exit,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
      };
    },

    cancel: async (handle: HarnessHandle, grace: Duration): Promise<void> => {
      const state = running.get(handle.agentId);
      if (state === undefined || state.settled !== undefined) return;
      state.cancelling = true;

      const { child } = state;
      const pid = child.pid;
      // The whole group, so the worker's own MCP server goes with it. A cancel
      // that left the grandchild running would leave a process holding the
      // worktree and writing events after the node was recorded as stopped.
      const signalGroup = (signal: NodeJS.Signals): void => {
        try {
          if (pid !== undefined && process.platform !== "win32") process.kill(-pid, signal);
          else child.kill(signal);
        } catch {
          // Already gone.
        }
      };

      signalGroup("SIGTERM");
      const hardKill = setTimeout(
        () => {
          signalGroup("SIGKILL");
        },
        Math.max(grace.ms, 0),
      );
      try {
        await handle.exit;
      } finally {
        clearTimeout(hardKill);
      }
    },

    status: async (handle: HarnessHandle): Promise<AgentStatus> => {
      const state = running.get(handle.agentId);
      return state?.settled === undefined ? "started" : agentStatusForExit(state.settled);
    },
  };
};

/**
 * The factory the MCP server's composition root loads through
 * `NIGHTSHIFT_HARNESS_MODULE`.
 *
 * That seam is what lets the slice suite run **the real server binary** against
 * this harness: a suite that tested a differently-wired server would prove
 * nothing about the one an operator runs.
 */
export const createHarness = (): Harness =>
  createScriptedHarness({
    script: (process.env[WORKER_SCRIPT_ENV] ??
      process.env[SCRIPT_ENV] ??
      "implement") as ScriptName,
  });
