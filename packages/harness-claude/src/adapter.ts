/**
 * The Claude Code harness adapter (T8, D-P3-03).
 *
 * Everything Claude-specific in Nightshift is in this package, and everything in
 * this package is behind `Harness.start`. The execution layer never learns that
 * a worker is a `claude` child process, that its output is newline-delimited
 * JSON, that its tool policy is three comma-separated flags, or that its
 * cooperative stop is `SIGINT`.
 *
 * The five rules `packages/harness/src/harness.ts` states for an implementer,
 * and where each is honoured:
 *
 * 1. *The identity is given to you.* `handle.agentId` is `input.agent.agentId`,
 *    copied and never minted.
 * 2. *Emit the lifecycle without the worker's help.* `agent.started` comes from
 *    the stream's `init` frame, or is synthesised at settle time when the
 *    process died before printing one; the ending comes from the process exit.
 *    Neither asks the worker for anything. `stream.ts` has the table.
 * 3. *`exit` settles exactly once and never rejects.* One `settle` function
 *    guarded by one flag. `start` never rejects either: a failure to write the
 *    configuration files, and a `spawn` that throws, both return a handle whose
 *    `exit` is already `failed` — which is the outcome the execution layer has a
 *    node to move to, where a rejection would leave it with an exception.
 * 4. *Nothing provider-specific escapes.* The exported surface is `Harness`,
 *    plus the injection points a test needs. No Claude type crosses it.
 * 5. *The worker never gets git write access.* `permissions.ts`, unconditionally.
 *
 * ## EXIT MAPPING
 *
 * | Observation                                          | `HarnessExit`              |
 * |------------------------------------------------------|----------------------------|
 * | `cancel` was called                                   | `cancelled`                |
 * | killed by a signal (POSIX)                            | `interrupted { signal }`   |
 * | exit 0 **and** a `result` frame that is not an error  | `completed`                |
 * | exit 0 with an error `result`, or with no `result`     | `failed { exitCode }`      |
 * | non-zero exit                                         | `failed { exitCode }`      |
 * | `spawn` failed, or configuration could not be written | `failed { exitCode: 127 }` |
 *
 * The third row is not what the task spec said, and the difference was measured
 * rather than reasoned: **a `SIGINT`-interrupted `claude -p` exits 0 and still
 * prints a `result` frame**, with `is_error: true` and `terminal_reason:
 * "aborted_streaming"`. Treating "exit 0 with a result" as completion would
 * therefore record an abandoned run as a finished one, and the node would go on
 * to verification with a half-written worktree. A *non-error* result is the
 * condition. A stream that ends with no `result` at all is `failed`, which is
 * the same rule seen from the other side.
 *
 * ## WINDOWS
 *
 * Windows has no signals and no process groups. `taskkill /T /F` is the only
 * tree kill available and it is unconditional, so there is no cooperative stop
 * to send first; a killed process reports **no signal and exit code 1**, which
 * lands in the `failed` row above rather than `interrupted`. That is deliberate
 * and it is what the contract asks for: SC-P3-11 wants durable state, not the
 * label. A `cancel` still settles as `cancelled` on Windows, because the adapter
 * knows it was the one that did the killing — it is only an *external* kill that
 * is indistinguishable from a crash there.
 */

import { join } from "node:path";
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
import { agentStatusForExit, hookTypeForExit, renderWorkerBrief } from "@nightshift/harness";
import {
  buildClaudeArgs,
  buildMcpConfig,
  buildSettings,
  CLAUDE_COMMAND,
  claudeBriefAddendum,
  claudePrompt,
  VERIFIED_CLAUDE_VERSION,
} from "./command.js";
import { sanitizeClaudeEnvironment } from "./environment.js";
import { claudeToolPolicy } from "./permissions.js";
import type { AdapterFileSystem, SpawnedChild, SpawnLike, TranscriptSink } from "./process.js";
import { killProcessTree, nodeFileSystem, nodeSpawn } from "./process.js";
import { createStreamInterpreter, optionalField, type StreamInterpreter } from "./stream.js";

/** `Harness.id`, matching `RouteTarget.harness`. */
export const CLAUDE_HARNESS_ID = "claude";

/**
 * Recorded for a child that never ran: a missing binary, an unusable worktree,
 * unwritable configuration. 127 is the shell's own "could not execute", and T4
 * records a spawn failure the same way.
 */
export const SPAWN_FAILURE_EXIT_CODE = 127;

/** Recorded when the process ended with neither a code nor a signal. */
const UNKNOWN_EXIT_CODE = 1;

/** How much of the child's stderr is kept for a failure payload. */
const MAX_STDERR_TAIL_CHARS = 600;

/**
 * The cooperative stop.
 *
 * `SIGINT` is what a terminal's Ctrl-C sends and what the CLI honours: verified
 * on 2.1.273 against a running `claude -p`, which exited 334 ms after the signal
 * having written a `[Request interrupted by user]` turn and a `result` frame.
 * There is no other cooperative channel for a `-p` run — `claude stop` addresses
 * background sessions by id, and the stdin control protocol requires
 * `--input-format stream-json`, which this adapter does not use.
 */
const COOPERATIVE_STOP: NodeJS.Signals = "SIGINT";

/**
 * Cancel escalation, as fractions of the caller's grace.
 *
 * `SIGINT` immediately, `SIGTERM` at half the grace, `SIGKILL` on the whole
 * tree when the grace is up — so "SIGKILL after the grace" is literally true and
 * a caller's single number bounds the whole sequence. The execution layer's
 * shutdown budget is the grace it passes; nothing here can outlive it.
 */
const SIGTERM_AT = 0.5;

interface RunState {
  readonly interpreter: StreamInterpreter;
  readonly exit: Promise<HarnessExit>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  child: SpawnedChild | undefined;
  configDir: string | undefined;
  /** Why the transcript could not be opened, if it could not. Reported on the ending. */
  transcriptError: string | undefined;
  settledExit: HarnessExit | undefined;
  cancelRequested: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

export interface ClaudeHarnessOptions {
  /** Injected so a test can assert the command line without a real CLI. */
  readonly spawn?: SpawnLike;
  /** Injected so a test needs no temporary directory. */
  readonly fs?: AdapterFileSystem;
  /** Injected so event timestamps are deterministic under test. */
  readonly clock?: Clock;
  /** Injected so the environment allowlist is testable off the real platform. */
  readonly platform?: NodeJS.Platform;
  /**
   * The **parent** process environment, the one this adapter filters an
   * allowlist out of. Not the child's: what reaches the worker is
   * `sanitizeClaudeEnvironment`'s output and nothing else. `apps/mcp`'s
   * composition root passes its own `process.env` here; a test passes a fake.
   * Defaults to `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected so the POSIX process-group kill is testable. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Builds the Claude Code adapter.
 *
 * A factory rather than a class so the injection points are one object and the
 * returned value is exactly the `Harness` interface — `apps/mcp`'s composition
 * module (T6) is the only place that calls this.
 */
export const createClaudeHarness = (options: ClaudeHarnessOptions = {}): Harness => {
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

  /** Handle → run state. Weak so a completed run is collectable. */
  const runs = new WeakMap<HarnessHandle, RunState>();

  const start = async (input: HarnessStartInput): Promise<HarnessHandle> => {
    const policy = claudeToolPolicy({ scope: input.node.scope, mcpServerName: input.mcp.name });
    const prompt = claudePrompt(
      renderWorkerBrief({
        job: input.job,
        node: input.node,
        program: input.program,
        worktree: input.worktree,
      }),
      claudeBriefAddendum({ mcpServerName: input.mcp.name, policy }),
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

    const env = sanitizeClaudeEnvironment({ platform, parentEnv });

    const state: RunState = {
      interpreter,
      exit: exitPromise,
      cwd: input.worktree,
      env,
      child: undefined,
      configDir: undefined,
      transcriptError: undefined,
      settledExit: undefined,
      cancelRequested: false,
      timers: [],
    };

    /**
     * Settles `exit` exactly once, emitting the one ending event as it goes.
     *
     * The ending is emitted here rather than from the stream so that it cannot
     * disagree with `exit`: `hookTypeForExit` is the shared mapping, so no
     * adapter can report an ending the execution layer would translate
     * differently.
     */
    const settle = (exit: HarnessExit, extra: Readonly<Record<string, unknown>> = {}): void => {
      if (state.settledExit !== undefined) return;
      state.settledExit = exit;
      for (const timer of state.timers) clearTimeout(timer);
      state.timers = [];
      // D-P3-09's invariant, in its hardest case: a worker that printed nothing
      // still produced a start, and it comes before the ending.
      interpreter.ensureStarted({ harnessVersion: VERIFIED_CLAUDE_VERSION });
      const outcome = interpreter.outcome;
      interpreter.emit(hookTypeForExit(exit), {
        outcome: exit.kind,
        ...optionalField("exitCode", exit.kind === "failed" ? exit.exitCode : undefined),
        ...optionalField("signal", exit.kind === "interrupted" ? exit.signal : undefined),
        sawResult: outcome.sawResult,
        ...optionalField("resultSubtype", outcome.resultSubtype),
        ...optionalField("terminalReason", outcome.terminalReason),
        ...optionalField(
          "unparseableStreamLines",
          outcome.unparseableLines === 0 ? undefined : outcome.unparseableLines,
        ),
        ...optionalField("transcriptError", state.transcriptError),
        ...extra,
      });
      resolveExit(exit);
    };

    /** A launch that never got off the ground. Rule 3: `failed`, not a rejection. */
    const failToLaunch = (reason: string): HarnessHandle => {
      if (state.configDir !== undefined) fs.removeDir(state.configDir);
      settle({ kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE }, { summary: reason });
      const handle: HarnessHandle = { agentId: input.agent.agentId, exit: exitPromise };
      runs.set(handle, state);
      return handle;
    };

    let configDir: string;
    let mcpConfigPath: string;
    let settingsPath: string;
    try {
      configDir = fs.makeTempDir("nightshift-claude-");
      mcpConfigPath = join(configDir, "mcp.json");
      settingsPath = join(configDir, "settings.json");
      fs.writeConfigFile(mcpConfigPath, buildMcpConfig(input.mcp));
      fs.writeConfigFile(settingsPath, buildSettings());
    } catch (error) {
      return failToLaunch(`could not write the Claude configuration: ${messageOf(error)}`);
    }
    state.configDir = configDir;

    let transcript: TranscriptSink | undefined;
    if (input.transcriptPath !== undefined) {
      try {
        transcript = fs.openTranscript(input.transcriptPath);
      } catch (error) {
        // The transcript is evidence, not the run. A state directory that cannot
        // be written is worth recording on the ending event, but it is not worth
        // failing a job over, and it must not become a second `agent.started`.
        state.transcriptError = messageOf(error);
      }
    }

    const args = buildClaudeArgs({
      prompt,
      model: input.model,
      mcpConfigPath,
      settingsPath,
      policy,
    });

    let child: SpawnedChild;
    try {
      child = spawn(CLAUDE_COMMAND, args, {
        cwd: input.worktree,
        env,
        // POSIX: its own process group, so cancel can signal the tree.
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      transcript?.close();
      return failToLaunch(`could not start ${CLAUDE_COMMAND}: ${messageOf(error)}`);
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

    child.on("error", (error) => {
      // The child never ran, or could not be signalled. Either way this is the
      // only place the reason exists.
      interpreter.end();
      transcript?.close();
      fs.removeDir(configDir);
      settle(
        { kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE },
        { summary: `${CLAUDE_COMMAND} failed to run: ${error.message}` },
      );
    });

    child.on("close", (code, signal) => {
      interpreter.end();
      transcript?.close();
      fs.removeDir(configDir);
      const outcome = interpreter.outcome;
      const extra = stderrTail.trim().length === 0 ? {} : { summary: stderrTail.trim() };
      if (state.cancelRequested) {
        settle({ kind: "cancelled" }, extra);
        return;
      }
      if (signal !== null) {
        settle({ kind: "interrupted", signal }, extra);
        return;
      }
      if (code === 0 && outcome.sawResult && !outcome.resultErrored) {
        settle({ kind: "completed" }, extra);
        return;
      }
      settle({ kind: "failed", exitCode: code ?? UNKNOWN_EXIT_CODE }, extra);
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
    // Idempotent both ways: a settled handle is a no-op, and a second cancel
    // waits for the first rather than starting a second escalation.
    if (state.settledExit !== undefined) return;
    if (state.cancelRequested) {
      await state.exit;
      return;
    }
    state.cancelRequested = true;

    const child = state.child;
    if (child === undefined) {
      // Nothing was ever spawned; `exit` has already settled or is about to.
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
      // No cooperative stop exists here: `taskkill /T /F` is unconditional. The
      // escalation below would be three identical kills, so it is not run.
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
        // Do not hold the event loop open waiting to escalate a process that
        // has already gone.
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
    if (state === undefined) {
      // A handle this adapter did not create. P9 answers this from the control
      // plane; in P3 the honest answer is that nothing here started it.
      return "created";
    }
    const settled = state.settledExit;
    // `agentStatusForExit` is the shared mapping in `@nightshift/harness`, used
    // here rather than repeated so no adapter can answer `status` and `exit`
    // differently — which is the property the conformance suite checks.
    return settled === undefined ? "started" : agentStatusForExit(settled);
  };

  return { id: CLAUDE_HARNESS_ID, start, cancel, status };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
