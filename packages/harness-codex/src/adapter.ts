/**
 * The Codex harness adapter (P5, T3, D-P5-02).
 *
 * Everything Codex-specific in Nightshift is in this package, and everything in
 * this package is behind `Harness.start`. The execution layer never learns that
 * a worker is a `codex exec` child process, that its MCP server arrives as TOML
 * overrides, or that a `SIGTERM`ed Codex exits 0.
 *
 * The six implementer rules of `@nightshift/harness`, and where each is honoured:
 *
 * 1. *The identity is given.* `handle.agentId` is `input.agent.agentId`.
 * 2. *The lifecycle needs no help from the worker.* `agent.started` comes from
 *    `thread.started`, or is synthesised at settle time; the ending comes from
 *    the process exit. `stream.ts` has the table.
 * 3. *`exit` settles once and never rejects.* One `settle`, one flag. A launch
 *    that cannot happen returns a handle whose `exit` is already `failed`.
 * 4. *Nothing provider-specific escapes.* The exported surface is `Harness`.
 * 5. *No git write access.* The guard in `command.ts`; the enforcement is A-29.
 * 6. *One transport.* The MCP launch, passed through unchanged. `input.tools` is
 *    never called: a Codex worker is a local process that can be handed a server.
 *
 * ## EXIT MAPPING (measured on 0.154.0)
 *
 * | Observation                                        | `HarnessExit`              |
 * |----------------------------------------------------|----------------------------|
 * | `cancel` was called                                 | `cancelled`                |
 * | killed by a signal                                  | `interrupted { signal }`   |
 * | exit 0 **and** `turn.completed` **and** no failure  | `completed`                |
 * | exit 0 without `turn.completed`, or with a failure  | `failed { exitCode }`      |
 * | non-zero exit                                       | `failed { exitCode }`      |
 * | `spawn` failed, or the guard could not be written   | `failed { exitCode: 127 }` |
 *
 * The third row is the measured one. **A `SIGTERM`ed `codex exec` exits 0**
 * having printed `thread.started` and `turn.started` and nothing else; a
 * `SIGINT`ed one exits 1. Exit 0 alone would therefore record an abandoned run
 * as a finished one, as it would have for Claude. `turn.completed` is Codex's
 * own statement that the turn ended cleanly, and it is the condition.
 *
 * `usage` rides on `completed` and `failed` whenever a turn reported any.
 *
 * ## WINDOWS
 *
 * As the Claude adapter: no signals, no process groups, `taskkill /T /F` and no
 * cooperative stop. The `git` guard is a POSIX shell script and is **not
 * installed on Windows**; A-29 is the enforcement there as everywhere.
 */
import { posix } from "node:path";
import type { AgentStatus } from "@nightshift/contracts";
import type { Clock } from "@nightshift/core";
import { systemClock } from "@nightshift/core";
import type {
  Duration,
  Harness,
  HarnessExit,
  HarnessHandle,
  HarnessStartInput,
} from "@nightshift/harness";
import { agentStatusForExit, hookTypeForExit, promptFor } from "@nightshift/harness";
import {
  buildCodexArgs,
  buildGitGuard,
  CODEX_COMMAND,
  codexBriefAddendum,
  codexPrompt,
  VERIFIED_CODEX_VERSION,
} from "./command.js";
import { sanitizeCodexEnvironment } from "./environment.js";
import type { AdapterFileSystem, SpawnedChild, SpawnLike, TranscriptSink } from "./process.js";
import { killProcessTree, nodeFileSystem, nodeSpawn } from "./process.js";
import {
  createStreamInterpreter,
  optionalField,
  type StreamInterpreter,
  type StreamOutcome,
} from "./stream.js";

/** `Harness.id`, matching `RouteTarget.harness`. */
export const CODEX_HARNESS_ID = "codex";

/** Recorded for a child that never ran. The shell's own "could not execute". */
export const SPAWN_FAILURE_EXIT_CODE = 127;

const UNKNOWN_EXIT_CODE = 1;
const MAX_STDERR_TAIL_CHARS = 600;

/**
 * The cooperative stop, then the escalation (D-P5-02): `SIGINT` immediately,
 * `SIGTERM` at half the grace, `SIGKILL` on the whole tree when the grace is up.
 * Measured: a `SIGINT`ed `codex exec` was gone in 0.3 s.
 */
const COOPERATIVE_STOP: NodeJS.Signals = "SIGINT";
const SIGTERM_AT = 0.5;

interface RunState {
  readonly interpreter: StreamInterpreter;
  readonly exit: Promise<HarnessExit>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  child: SpawnedChild | undefined;
  guardDir: string | undefined;
  transcriptError: string | undefined;
  settledExit: HarnessExit | undefined;
  cancelRequested: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

export interface CodexHarnessOptions {
  readonly spawn?: SpawnLike;
  readonly fs?: AdapterFileSystem;
  readonly clock?: Clock;
  readonly platform?: NodeJS.Platform;
  /** The **parent** environment, which the allowlist is filtered out of. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export const createCodexHarness = (options: CodexHarnessOptions = {}): Harness => {
  const spawn = options.spawn ?? nodeSpawn;
  const fs = options.fs ?? nodeFileSystem;
  const clock = options.clock ?? systemClock;
  const platform = options.platform ?? process.platform;
  const parentEnv = options.env ?? process.env;
  const kill =
    options.kill ??
    ((pid, signal) => {
      process.kill(pid, signal);
    });

  const runs = new WeakMap<HarnessHandle, RunState>();

  /**
   * The `git` guard, and the `PATH` that puts it first **for the commands the
   * model runs** (see `command.ts`). Never the Codex process's own `PATH`: the
   * worker's Nightshift MCP server inherits that, and it is the one process that
   * must reach the real `git`. A machine with no `git` has nothing to guard.
   */
  const installGitGuard = (state: RunState): string | undefined => {
    if (platform === "win32") return undefined;
    const realGit = fs.findExecutable("git", state.env.PATH);
    if (realGit === undefined) return undefined;
    const guardDir = fs.makeTempDir("nightshift-codex-");
    state.guardDir = guardDir;
    // POSIX spelling on purpose: the guard exists only there, and a test that
    // injects `platform` must read the same path on a Windows CI leg.
    fs.writeExecutable(posix.join(guardDir, "git"), buildGitGuard(realGit));
    return `${guardDir}${posix.delimiter}${state.env.PATH ?? ""}`;
  };

  const start = async (input: HarnessStartInput): Promise<HarnessHandle> => {
    const prompt = promptFor(input, (brief, mcpServerName, tools) =>
      codexPrompt(brief, codexBriefAddendum({ mcpServerName, tools })),
    );

    let resolveExit: (exit: HarnessExit) => void = () => {};
    const exitPromise = new Promise<HarnessExit>((resolve) => {
      resolveExit = resolve;
    });

    const interpreter = createStreamInterpreter({
      sink: input.sink,
      clock,
      context: { agentId: input.agent.agentId },
    });

    const state: RunState = {
      interpreter,
      exit: exitPromise,
      cwd: input.worktree,
      env: sanitizeCodexEnvironment({ platform, parentEnv }),
      child: undefined,
      guardDir: undefined,
      transcriptError: undefined,
      settledExit: undefined,
      cancelRequested: false,
      timers: [],
    };

    /** Settles `exit` exactly once, emitting the one ending event as it goes. */
    const settle = (exit: HarnessExit, extra: Readonly<Record<string, unknown>> = {}): void => {
      if (state.settledExit !== undefined) return;
      state.settledExit = exit;
      for (const timer of state.timers) clearTimeout(timer);
      state.timers = [];
      interpreter.ensureStarted({ harnessVersion: VERIFIED_CODEX_VERSION });
      const outcome = interpreter.outcome;
      interpreter.emit(hookTypeForExit(exit), {
        outcome: exit.kind,
        ...optionalField("exitCode", exit.kind === "failed" ? exit.exitCode : undefined),
        ...optionalField("signal", exit.kind === "interrupted" ? exit.signal : undefined),
        turnCompleted: outcome.turnCompleted,
        ...optionalField("failure", outcome.failure),
        ...optionalField(
          "unparseableStreamLines",
          outcome.unparseableLines === 0 ? undefined : outcome.unparseableLines,
        ),
        ...optionalField("transcriptError", state.transcriptError),
        ...extra,
      });
      resolveExit(exit);
    };

    const failToLaunch = (reason: string): HarnessHandle => {
      if (state.guardDir !== undefined) fs.removeDir(state.guardDir);
      settle({ kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE }, { summary: reason });
      const handle: HarnessHandle = { agentId: input.agent.agentId, exit: exitPromise };
      runs.set(handle, state);
      return handle;
    };

    let shellPath: string | undefined;
    try {
      shellPath = installGitGuard(state);
    } catch (error) {
      return failToLaunch(`could not write the git guard: ${messageOf(error)}`);
    }

    let transcript: TranscriptSink | undefined;
    if (input.transcriptPath !== undefined) {
      try {
        transcript = fs.openTranscript(input.transcriptPath);
      } catch (error) {
        // The transcript is evidence, not the run.
        state.transcriptError = messageOf(error);
      }
    }

    const args = buildCodexArgs({
      prompt,
      model: input.model,
      worktree: input.worktree,
      ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
      shellPath,
      ...(input.resume === undefined ? {} : { resumeSessionId: input.resume.sessionId }),
    });

    let child: SpawnedChild;
    try {
      child = spawn(CODEX_COMMAND, args, {
        cwd: input.worktree,
        env: state.env,
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      transcript?.close();
      return failToLaunch(`could not start ${CODEX_COMMAND}: ${messageOf(error)}`);
    }
    state.child = child;

    let stderrTail = "";
    const decoder = new TextDecoder("utf-8");

    child.stdout?.on("data", (chunk) => {
      // The raw stream first, so a crash mid-parse still leaves the evidence.
      transcript?.write(chunk);
      interpreter.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${decoder.decode(chunk, { stream: true })}`.slice(
        -MAX_STDERR_TAIL_CHARS,
      );
    });

    const cleanUp = (): void => {
      interpreter.end();
      transcript?.close();
      if (state.guardDir !== undefined) fs.removeDir(state.guardDir);
    };

    child.on("error", (error) => {
      cleanUp();
      settle(
        { kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE },
        { summary: `${CODEX_COMMAND} failed to run: ${error.message}` },
      );
    });

    child.on("close", (code, signal) => {
      cleanUp();
      const extra = stderrTail.trim().length === 0 ? {} : { summary: stderrTail.trim() };
      settle(exitFor(state.cancelRequested, code, signal, interpreter.outcome), extra);
    });

    const handle: HarnessHandle = {
      agentId: input.agent.agentId,
      ...optionalField("pid", child.pid),
      exit: exitPromise,
      ...optionalField("transcript", transcript === undefined ? undefined : input.transcriptPath),
    };
    runs.set(handle, state);
    return handle;
  };

  const cancel = async (handle: HarnessHandle, grace: Duration): Promise<void> => {
    const state = runs.get(handle);
    if (state === undefined) return;
    if (state.settledExit !== undefined) return;
    if (state.cancelRequested) {
      await state.exit;
      return;
    }
    state.cancelRequested = true;

    const child = state.child;
    if (child === undefined) {
      await state.exit;
      return;
    }

    const signalTree = (signal: NodeJS.Signals): void =>
      killProcessTree({
        pid: child.pid,
        platform,
        signal,
        child,
        cwd: state.cwd,
        env: state.env,
        spawn,
        kill,
      });

    if (platform === "win32") {
      signalTree("SIGKILL");
    } else {
      signalTree(COOPERATIVE_STOP);
      const at = (fraction: number, signal: NodeJS.Signals): void => {
        const timer = setTimeout(
          () => {
            if (state.settledExit !== undefined) return;
            signalTree(signal);
          },
          Math.max(0, Math.round(grace.ms * fraction)),
        );
        timer.unref?.();
        state.timers.push(timer);
      };
      at(SIGTERM_AT, "SIGTERM");
      at(1, "SIGKILL");
    }

    await state.exit;
  };

  const status = async (handle: HarnessHandle): Promise<AgentStatus> => {
    const state = runs.get(handle);
    if (state === undefined) return "created";
    const settled = state.settledExit;
    return settled === undefined ? "started" : agentStatusForExit(settled);
  };

  return { id: CODEX_HARNESS_ID, capabilities: { usage: true }, start, cancel, status };
};

/** The exit mapping, as the table at the top of this file states it. */
const exitFor = (
  cancelRequested: boolean,
  code: number | null,
  signal: string | null,
  outcome: StreamOutcome,
): HarnessExit => {
  if (cancelRequested) return { kind: "cancelled" };
  if (signal !== null) return { kind: "interrupted", signal };
  // P8: the thread a question can resume (D-P8-15), and whether the route could
  // not start at all (D-P8-06).
  const said = {
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    ...(outcome.threadId === undefined ? {} : { sessionId: outcome.threadId }),
  };
  if (code === 0 && outcome.turnCompleted && outcome.failure === undefined) {
    return {
      kind: "completed",
      ...said,
      ...(outcome.lastMessage === undefined ? {} : { result: outcome.lastMessage }),
    };
  }
  return {
    kind: "failed",
    exitCode: code ?? UNKNOWN_EXIT_CODE,
    ...said,
    ...(outcome.unavailable === undefined ? {} : { unavailable: outcome.unavailable }),
  };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
