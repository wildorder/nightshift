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
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import { sanitizeEnvironment } from "@nightshift/verification";
import { SCRIPTS, type ScriptName, taggedScript, type WorkerSurface } from "./scripts.js";

export { SCRIPT_NAMES, type ScriptName } from "./scripts.js";

/**
 * Which transport carries the worker's four operations (rule 6: exactly one).
 *
 * `mcp`, the default, is a child process speaking to a worker-role MCP server
 * over stdio: what a local adapter does. `functions` runs the same script in
 * this process and calls `HarnessStartInput.tools` directly: what P10's remote
 * adapter will do, tested offline now (A-37).
 */
export type ScriptedTransport = "mcp" | "functions";
export const TRANSPORT_ENV = "NIGHTSHIFT_SCRIPTED_TRANSPORT";

export const SCRIPT_ENV = "NIGHTSHIFT_SCRIPT";

/** How the child is told what to do and who to talk to. */
export const WORKER_SCRIPT_ENV = "NIGHTSHIFT_WORKER_SCRIPT";
export const WORKER_MCP_ENV = "NIGHTSHIFT_WORKER_MCP";
export const WORKER_WORKTREE_ENV = "NIGHTSHIFT_WORKER_WORKTREE";
/** The arguments of the objective's tag, as JSON. */
export const WORKER_ARGS_ENV = "NIGHTSHIFT_WORKER_ARGS";
/** `job` or `sub-program`: which Nightshift role the child's MCP server plays. */
export const WORKER_KIND_ENV = "NIGHTSHIFT_WORKER_KIND";

/**
 * Which script a start input gets (P6): a sub-program is orchestrated; a job
 * whose objective carries a tag does what the tag says; anything else does what
 * this harness was configured to do, as it always has.
 */
export const scriptFor = (
  input: HarnessStartInput,
  fallback: ScriptName,
): { readonly script: ScriptName; readonly args: readonly string[] } => {
  if (input.node.kind === "program") {
    // The root of a planned run (P7): told which run, and which strands the plan has.
    return {
      script: "follow-plan",
      args: [input.node.runId, ...(input.program.strands ?? []).map((strand) => strand.id)],
    };
  }
  if (input.node.kind === "sub-program") {
    const anywhere = input.job.strandId !== undefined;
    return { script: "orchestrate", args: taggedScript(input.job.objective, anywhere)?.args ?? [] };
  }
  const fromLaunch = input.mcp.env[WORKER_SCRIPT_ENV] as ScriptName | undefined;
  return taggedScript(input.job.objective) ?? { script: fromLaunch ?? fallback, args: [] };
};

/** The built child entry point, resolved from this module's own location. */
export const workerEntry = (): string => fileURLToPath(new URL("./worker.js", import.meta.url));

export interface ScriptedHarnessOptions {
  readonly script: ScriptName;
  /** `mcp` unless said otherwise. */
  readonly transport?: ScriptedTransport;
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

/**
 * The function transport: the script runs here, over `input.tools`.
 *
 * No child and no MCP server, so there is no pid and no stream to parse; the
 * lifecycle events come from this harness observing its own script, which is as
 * uncooperative a source as a process exit. `input.mcp` is never launched — one
 * transport per worker.
 */
const createFunctionHarness = (options: ScriptedHarnessOptions): Harness => {
  interface InProcess {
    settled: HarnessExit | undefined;
    cancelling: boolean;
    release: () => void;
  }
  const running = new Map<AgentId, InProcess>();

  return {
    id: "scripted",
    capabilities: { usage: false },

    start: async (input: HarnessStartInput): Promise<HarnessHandle> => {
      const emit = (type: string, payload: Record<string, unknown>): void => {
        if (!isHookEventType(type)) return;
        input.sink.emit({ type, occurredAt: new Date().toISOString(), payload });
      };
      const { script, args } = scriptFor(input, options.script);
      emit("agent.started", { harness: "scripted", script, transport: "functions" });

      let release = (): void => {};
      const cancelled = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state: InProcess = { settled: undefined, cancelling: false, release };
      running.set(input.agent.agentId, state);

      const observed = async <T>(tool: string, call: () => Promise<T>): Promise<T> => {
        emit("tool.called", { tool });
        const result = await call();
        emit("tool.completed", { tool, ok: true });
        return result;
      };
      const surface: WorkerSurface = {
        // A function caller was handed the job; there is nothing to fetch.
        get: async () => {},
        progress: (message, percent) =>
          observed("job.progress", () => input.tools.progress(message, percent)),
        decide: async (decision) => {
          await observed("decision.record", () => input.tools.recordDecision(decision));
        },
        complete: async (summary) =>
          (await observed("job.complete", () => input.tools.complete(summary))).kind,
        fail: (reason) => observed("job.fail", () => input.tools.fail(reason)),
      };

      const exit = (async (): Promise<HarnessExit> => {
        let outcome: HarnessExit;
        let failure = "";
        try {
          const code = await SCRIPTS[script]({
            surface,
            worktree: input.worktree,
            cancelled,
            args,
            note: (text) => {
              failure += `${text}\n`;
            },
          });
          outcome = code === 0 ? { kind: "completed" } : { kind: "failed", exitCode: code };
        } catch (error) {
          failure += error instanceof Error ? error.message : String(error);
          outcome = { kind: "failed", exitCode: 1 };
        }
        const final = state.cancelling ? ({ kind: "cancelled" } as const) : outcome;
        state.settled = final;
        emit(hookTypeForExit(final), { ...exitPayload(final), ...tail(failure) });
        return final;
      })();

      return { agentId: input.agent.agentId, exit };
    },

    cancel: async (handle: HarnessHandle): Promise<void> => {
      const state = running.get(handle.agentId);
      if (state === undefined || state.settled !== undefined) return;
      state.cancelling = true;
      state.release();
      await handle.exit;
    },

    status: async (handle: HarnessHandle): Promise<AgentStatus> => {
      const state = running.get(handle.agentId);
      return state?.settled === undefined ? "started" : agentStatusForExit(state.settled);
    },
  };
};

export const createScriptedHarness = (options: ScriptedHarnessOptions): Harness => {
  if (options.transport === "functions") return createFunctionHarness(options);
  const running = new Map<AgentId, Running>();

  return {
    id: "scripted",
    capabilities: { usage: false },

    start: async (input: HarnessStartInput): Promise<HarnessHandle> => {
      const emit = (type: string, payload: Record<string, unknown>): void => {
        if (!isHookEventType(type)) return;
        input.sink.emit({ type, occurredAt: new Date().toISOString(), payload });
      };

      const { script, args } = scriptFor(input, options.script);
      // Before anything the child does, and without its cooperation.
      emit("agent.started", { harness: "scripted", script });

      const child = spawn(options.node ?? process.execPath, [options.entry ?? workerEntry()], {
        cwd: input.worktree,
        env: {
          // A small, allowlisted environment, as a real adapter builds (T4, T8)
          // — through the same function, so this harness cannot be the reason a
          // child starts on one platform and not another. On Windows a child
          // given only `PATH` and `HOME` does not start.
          ...sanitizeEnvironment({
            platform: process.platform,
            parentEnv: process.env,
            extra: undefined,
          }),
          [WORKER_SCRIPT_ENV]: script,
          [WORKER_ARGS_ENV]: JSON.stringify(args),
          [WORKER_KIND_ENV]: input.node.kind,
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
      // Kept as the transcript too: what the "provider" said, line for line, which
      // is what a real adapter keeps (SC-P5-09).
      const transcript: string[] = [];
      readFrames(child, (frame) => {
        transcript.push(JSON.stringify(frame));
        if (frame.hook !== undefined) emit(frame.hook, frame.payload ?? {});
      });
      const keepTranscript = async (): Promise<void> => {
        if (input.transcriptPath === undefined || transcript.length === 0) return;
        await mkdir(dirname(input.transcriptPath), { recursive: true });
        await writeFile(input.transcriptPath, `${transcript.join("\n")}\n`, "utf8");
      };
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
          // Written before `exit` settles, because the execution layer reads it
          // the moment it does. A transcript that cannot be written is not a
          // reason for a worker's ending to go unreported.
          void keepTranscript()
            .catch(() => {})
            .then(() => resolve(final));
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
        ...(input.transcriptPath === undefined ? {} : { transcript: input.transcriptPath }),
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
    transport: process.env[TRANSPORT_ENV] === "functions" ? "functions" : "mcp",
  });
