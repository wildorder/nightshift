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
 * `usage` rides on every variant (`cancelled` and `interrupted` included) that
 * saw a `turn.completed`, as `usageScope: "session"`: Codex's figure is the
 * thread-cumulative total. `coverage` is `complete` for a clean turn, `partial`
 * for usage without one, and `unknown` when none was seen.
 *
 * ## MEASUREMENT CAPTURE (P20 S-03)
 *
 * Only when `HarnessStartInput.measurements` is present; absent, the adapter
 * does exactly what it did before (no receiver, no `otel` arguments, no
 * rollout read, nothing emitted). Three sources, none trusted alone:
 *
 * - **The rollout** (`rollout.ts`, `<CODEX_HOME>/sessions/.../rollout-*-<thread>.jsonl`,
 *   metadata only) is the source of requests: response ids, ordinals, the
 *   thread total. A resume's launch boundary is the rollout's next ordinal,
 *   read BEFORE spawning (time boundary, and a gap, if that read fails).
 * - **OTLP log telemetry** (`telemetry.ts`, a loopback receiver journalling an
 *   allowlisted, filtered, typed reduction) corroborates the rollout by
 *   position and count, and stands in for it only where no rollout is readable
 *   and no retry or unverified transport could have replayed a completion.
 * - **The stream** (`stream.ts`) supplies the exit's thread-cumulative usage,
 *   `usageScope: "session"`, unchanged.
 *
 * The reconciliation and the coverage rule are pure (`capture.ts`); the I/O
 * around them is `capture-run.ts`. Nothing there throws out of `close` or waits
 * beyond bounded timeouts: a failure is a named gap and `partial` coverage.
 * `complete` needs every source to agree and no native child to go unseen.
 *
 * ## WINDOWS
 *
 * As the Claude adapter: no signals, no process groups, `taskkill /T /F` and no
 * cooperative stop. The `git` guard is a POSIX shell script and is **not
 * installed on Windows**; A-29 is the enforcement there as everywhere.
 */
import { posix, win32 } from "node:path";
import { type AgentStatus, declaredSecrets } from "@nightshift/contracts";
import type { Clock } from "@nightshift/core";
import { systemClock } from "@nightshift/core";
import type {
  Duration,
  ExitMeasures,
  Harness,
  HarnessExit,
  HarnessHandle,
  HarnessLineStartInput,
  HarnessStartInput,
  HookSink,
  RunAs,
} from "@nightshift/harness";
import {
  agentStatusForExit,
  type CliLauncher,
  cancelAtDeadline,
  commandAs,
  hookTypeForExit,
  nullHookSink,
  promptFor,
  renderLineBrief,
  startLocalReceiver,
  withTmpDir,
} from "@nightshift/harness";
import { beginCapture, type CaptureRun, type StartReceiver } from "./capture-run.js";
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
  /** Who the process runs as (D-P10-25), for signalling it as that user. */
  runAs: RunAs | undefined;
  transcriptError: string | undefined;
  settledExit: HarnessExit | undefined;
  cancelRequested: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

/**
 * One launch, normalised: what `start` and `startLine` both reduce to, so the
 * command, permission and process code below is written once.
 */
interface Launch {
  readonly agentId: HarnessHandle["agentId"];
  readonly prompt: string;
  readonly worktree: string;
  readonly tmpDir?: string | undefined;
  readonly model: HarnessStartInput["model"];
  readonly mcp?: HarnessStartInput["mcp"];
  readonly runAs?: RunAs | undefined;
  readonly sink: HookSink;
  readonly measurements?: HarnessStartInput["measurements"];
  readonly transcriptPath?: string | undefined;
  readonly resume?: HarnessStartInput["resume"];
  /** The environment the allowlist is filtered out of. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Added past the allowlist: declared secrets, or a line agent's whole handed-in environment. */
  readonly extraEnv: Readonly<Record<string, string>>;
  /** Let the model's shell see credential-named variables (declared secrets only). */
  readonly passSecrets?: boolean;
  /** No file edits: the examiner's sandbox. */
  readonly readOnly?: boolean;
}

export interface CodexHarnessOptions {
  /**
   * What is spawned in place of `codex` by name: `file ...args <cli args>`
   * (P16 S-01). On a machine, the image's Node and the CLI's script, so a
   * project's pinned Node first on `PATH` cannot run the CLI. Absent, `codex`
   * is found on `PATH` as before.
   */
  readonly launcher?: CliLauncher;
  readonly spawn?: SpawnLike;
  readonly fs?: AdapterFileSystem;
  readonly clock?: Clock;
  readonly platform?: NodeJS.Platform;
  /** The **parent** environment, which the allowlist is filtered out of. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** The loopback telemetry receiver (P20 S-03); a test injects a fake. */
  readonly startReceiver?: StartReceiver;
}

export const createCodexHarness = (options: CodexHarnessOptions = {}): Harness => {
  const spawn = options.spawn ?? nodeSpawn;
  const fs = options.fs ?? nodeFileSystem;
  const clock = options.clock ?? systemClock;
  const platform = options.platform ?? process.platform;
  const parentEnv = options.env ?? process.env;
  const launcher = options.launcher;
  const startReceiver = options.startReceiver ?? startLocalReceiver;
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

  const launch = async (input: Launch): Promise<HarnessHandle> => {
    const prompt = input.prompt;

    let resolveExit: (exit: HarnessExit) => void = () => {};
    const exitPromise = new Promise<HarnessExit>((resolve) => {
      resolveExit = resolve;
    });

    const interpreter = createStreamInterpreter({
      sink: input.sink,
      clock,
      context: { agentId: input.agentId },
      ...(input.runAs === undefined ? {} : { started: { user: input.runAs.user } }),
    });

    const state: RunState = {
      interpreter,
      exit: exitPromise,
      cwd: input.worktree,
      env: withTmpDir(
        sanitizeCodexEnvironment({
          platform,
          parentEnv: input.parentEnv,
          extra: input.extraEnv,
        }),
        input.tmpDir,
      ),
      child: undefined,
      guardDir: undefined,
      runAs: input.runAs,
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
      const handle: HarnessHandle = { agentId: input.agentId, exit: exitPromise };
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

    // P20 S-03: only when the execution layer asked for measurements.
    let capture: CaptureRun | undefined;
    if (input.measurements !== undefined) {
      try {
        capture = await beginCapture({
          fs,
          startReceiver,
          clock,
          env: state.env,
          runAs: input.runAs,
          sink: input.measurements,
          resumeSessionId: input.resume?.sessionId,
          join: platform === "win32" ? win32.join : posix.join,
        });
      } catch {
        // Measurement is evidence, not the run.
      }
    }

    const args = buildCodexArgs({
      model: input.model,
      worktree: input.worktree,
      ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
      shellPath,
      ...(input.resume === undefined ? {} : { resumeSessionId: input.resume.sessionId }),
      ...(capture?.otel === undefined ? {} : { otel: capture.otel }),
      passSecrets: input.readOnly !== true && input.passSecrets === true,
      ...(input.readOnly === true ? { readOnly: true } : {}),
    });

    let child: SpawnedChild;
    try {
      // Another user runs the process (D-P10-25): the git guard becomes its to run.
      if (input.runAs !== undefined && state.guardDir !== undefined) {
        await input.runAs.grant(state.guardDir);
      }
      const command = commandAs(
        input.runAs,
        launcher?.file ?? CODEX_COMMAND,
        [...(launcher?.args ?? []), ...args],
        state.env,
      );
      child = spawn(command.file, command.args, {
        cwd: input.worktree,
        env: command.env,
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      transcript?.close();
      await capture?.discard();
      return failToLaunch(`could not start ${CODEX_COMMAND}: ${messageOf(error)}`);
    }
    state.child = child;
    // The brief, whole, on stdin, which then closes: `codex exec -` reads it
    // to the end and starts.
    child.stdin?.on("error", () => {
      // The child went before reading it; `close` reports how.
    });
    child.stdin?.end(prompt);

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
      void capture?.discard();
      settle(
        { kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE },
        { summary: `${CODEX_COMMAND} failed to run: ${error.message}` },
      );
    });

    child.on("close", (code, signal) => {
      cleanUp();
      if (state.settledExit !== undefined) return;
      const extra = stderrTail.trim().length === 0 ? {} : { summary: stderrTail.trim() };
      const exit = exitFor(state.cancelRequested, code, signal, interpreter.outcome);
      if (capture === undefined) {
        settle(exit, extra);
        return;
      }
      // Every step of the capture is bounded and failure-tolerant; the exit
      // settles after it, with the coverage it found.
      void capture
        .finish({ outcome: interpreter.outcome, exitKind: exit.kind })
        .catch(() => undefined)
        .then((measured) => {
          settle(
            measured === undefined
              ? exit
              : {
                  ...exit,
                  coverage: measured.coverage,
                  ...(measured.observedModel === undefined
                    ? {}
                    : { observedModel: measured.observedModel }),
                },
            { ...extra, ...measured?.hook },
          );
        });
    });

    const handle: HarnessHandle = {
      agentId: input.agentId,
      ...optionalField("pid", child.pid),
      exit: exitPromise,
      ...optionalField("transcript", transcript === undefined ? undefined : input.transcriptPath),
    };
    runs.set(handle, state);
    return handle;
  };

  const start = (input: HarnessStartInput): Promise<HarnessHandle> =>
    launch({
      agentId: input.agent.agentId,
      prompt: promptFor(input, (brief, mcpServerName, tools) =>
        codexPrompt(brief, codexBriefAddendum({ mcpServerName, tools })),
      ),
      worktree: input.worktree,
      tmpDir: input.tmpDir,
      model: input.model,
      ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
      runAs: input.runAs,
      sink: input.sink,
      ...(input.measurements === undefined ? {} : { measurements: input.measurements }),
      transcriptPath: input.transcriptPath,
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      parentEnv,
      // A-62: the project's secrets the program declares, as this process holds them.
      extraEnv: declaredSecrets(input.program.secrets, parentEnv),
      passSecrets: Object.keys(declaredSecrets(input.program.secrets, parentEnv)).length > 0,
    });

  /**
   * The line owner's resolver or examiner: no MCP server, no run-scoped records,
   * the environment handed in and none of the engine's. Git writes are refused
   * by the same guard as a worker's; an examiner runs in a read-only sandbox.
   */
  const startLine = async (input: HarnessLineStartInput): Promise<HarnessHandle> => {
    const handle = await launch({
      agentId: input.agentId,
      prompt: `${renderLineBrief(input.task).trimEnd()}\n`,
      worktree: input.worktree,
      tmpDir: input.tmpDir,
      model: input.model,
      runAs: input.runAs,
      sink: nullHookSink,
      parentEnv: {},
      extraEnv: input.env,
      readOnly: input.role === "line_examiner",
    });
    cancelAtDeadline({ handle, deadline: input.deadline, nowMs: clock.now(), cancel });
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
        kill: state.runAs?.kill === undefined ? kill : state.runAs.kill.bind(state.runAs),
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

  return {
    id: CODEX_HARNESS_ID,
    capabilities: { usage: true, observations: true },
    start,
    startLine,
    cancel,
    status,
  };
};

/** The exit mapping, as the table at the top of this file states it. */
const exitFor = (
  cancelRequested: boolean,
  code: number | null,
  signal: string | null,
  outcome: StreamOutcome,
): HarnessExit => {
  const clean = outcome.turnCompleted && outcome.failure === undefined;
  const measured = (complete: boolean): ExitMeasures =>
    outcome.usage === undefined
      ? { coverage: "unknown" }
      : {
          usage: outcome.usage,
          usageScope: "session",
          coverage: complete ? "complete" : "partial",
        };
  // A stopped run's figure is whatever the last finished turn had reported.
  if (cancelRequested) return { kind: "cancelled", ...measured(false) };
  if (signal !== null) return { kind: "interrupted", signal, ...measured(false) };
  const measures = measured(clean);
  // P8: the thread a question can resume (D-P8-15), and whether the route could
  // not start at all (D-P8-06).
  const said = {
    ...measures,
    ...(outcome.threadId === undefined ? {} : { sessionId: outcome.threadId }),
  };
  if (code === 0 && clean) {
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
    ...(outcome.unavailable === undefined
      ? {}
      : {
          unavailable: outcome.unavailable,
          ...(outcome.availableAgainAt === undefined
            ? {}
            : { availableAgainAt: outcome.availableAgainAt }),
          ...(outcome.workBegan === true ? { workBegan: true } : {}),
        }),
  };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
