/**
 * The Claude Code harness adapter (T8, D-P3-03).
 *
 * Everything Claude-specific in Nightshift is in this package, and everything in
 * this package is behind `Harness.start`. The execution layer never learns that
 * a worker is a `claude` child process, that its output is newline-delimited
 * JSON, that its git guard is a comma-separated deny flag, or that its
 * cooperative stop is `SIGINT`.
 *
 * The six rules `packages/harness/src/harness.ts` states for an implementer,
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
 * 6. *One transport per worker.* The MCP launch, through `--mcp-config`.
 *    `input.tools` is never called: a Claude Code worker is a local process.
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
import { type AgentStatus, declaredSecrets } from "@nightshift/contracts";
import type { Clock } from "@nightshift/core";
import { systemClock } from "@nightshift/core";
import type {
  Duration,
  ExitMeasures,
  Harness,
  HarnessExit,
  HarnessHandle,
  HarnessStartInput,
  HookSink,
  MeasurementSink,
  RunAs,
} from "@nightshift/harness";
import {
  agentStatusForExit,
  type CliLauncher,
  commandAs,
  hookTypeForExit,
  millis,
  promptFor,
  withTmpDir,
} from "@nightshift/harness";
import {
  type ClaudeCapture,
  type ClaudeCaptureResult,
  claudeTelemetryHeaderEnv,
  claudeTelemetryHeadersFile,
  claudeTelemetryHeadersHelper,
  startClaudeCapture,
} from "./capture.js";
import {
  buildClaudeArgs,
  buildEmptyMcpConfig,
  buildMcpConfig,
  buildSettings,
  CLAUDE_COMMAND,
  claudeBriefAddendum,
  claudeInputLine,
  claudePrompt,
  VERIFIED_CLAUDE_VERSION,
} from "./command.js";
import { HEADLESS_CLAUDE_ENV, sanitizeClaudeEnvironment } from "./environment.js";
import { type ClaudeToolPolicy, claudeMcpToolName, claudeToolPolicy } from "./permissions.js";
import type { AdapterFileSystem, SpawnedChild, SpawnLike, TranscriptSink } from "./process.js";
import { killProcessTree, nodeFileSystem, nodeSpawn } from "./process.js";
import { createSessionCloser } from "./session.js";
import {
  createStreamInterpreter,
  optionalField,
  type StreamInterpreter,
  type StreamOutcome,
} from "./stream.js";

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
 * Still the stop under `--input-format stream-json`: closing stdin would only
 * end the session once its turn had finished, which is not a stop.
 */
const COOPERATIVE_STOP: NodeJS.Signals = "SIGINT";

/**
 * The Nightshift tools that end an agent's work, in every role. After one, an
 * idle session is over even with something left running in the background.
 */
const FINISHING_TOOLS: readonly string[] = [
  "job.complete",
  "job.fail",
  "subprogram.complete",
  "subprogram.fail",
  "run.finish",
  "examination.ask",
  "examination.submit",
  "finding.rule",
];

/** {@link FINISHING_TOOLS} as Claude spells them, through the named server. None without one. */
const finishingToolsFor = (mcpServerName: string | undefined): ReadonlySet<string> =>
  new Set(
    mcpServerName === undefined
      ? []
      : FINISHING_TOOLS.map((tool) => claudeMcpToolName(mcpServerName, tool)),
  );

/**
 * Cancel escalation, as fractions of the caller's grace.
 *
 * `SIGINT` immediately, `SIGTERM` at half the grace, `SIGKILL` on the whole
 * tree when the grace is up — so "SIGKILL after the grace" is literally true and
 * a caller's single number bounds the whole sequence. The execution layer's
 * shutdown budget is the grace it passes; nothing here can outlive it.
 */
const SIGTERM_AT = 0.5;

/** How long the receiver gets to flush and report at an ending. */
const CAPTURE_STOP_GRACE_MS = 1500;
/** The bound on the whole stop, so a stalled receiver cannot hold `exit` open. */
const CAPTURE_STOP_BOUND_MS = 2000;

/** Where a launch's request measurements come from. */
export type ClaudeCaptureMode = "otlp" | "stream" | "none";

/** What the adapter hands `onCapture` at an ending, while the journal still exists. */
export interface ClaudeCaptureReport {
  readonly agentId: string;
  readonly mode: ClaudeCaptureMode;
  /** The receiver's result. Absent when capture did not run or its stop failed. */
  readonly result?: ClaudeCaptureResult;
  /** The receiver journal; valid only for the duration of the `onCapture` call. */
  readonly journalPath?: string;
  /** Why capture could not start, when the launch fell back to stream mode. */
  readonly startError?: string;
  /** Why the capture result is missing, when `stop` rejected or timed out. */
  readonly stopError?: string;
}

export interface ClaudeRequestCaptureOptions {
  /** Default true. False keeps request measurement to the stream. */
  readonly enabled?: boolean;
  /** The exporter's flush interval, for a test that cannot wait a second. */
  readonly exportIntervalMs?: number;
}

interface RunState {
  readonly interpreter: StreamInterpreter;
  readonly exit: Promise<HarnessExit>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  child: SpawnedChild | undefined;
  configDir: string | undefined;
  /** Per-run capture state: the receiver, its directory, and the mode it implies. */
  readonly mode: ClaudeCaptureMode;
  readonly capture: ClaudeCapture | undefined;
  captureDir: string | undefined;
  captureStartError: string | undefined;
  /** True once the one `finish` sequence has begun. */
  finishing: boolean;
  /** Who the process runs as (D-P10-25), for signalling it as that user. */
  runAs: RunAs | undefined;
  /** Why the transcript could not be opened, if it could not. Reported on the ending. */
  transcriptError: string | undefined;
  settledExit: HarnessExit | undefined;
  cancelRequested: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

/**
 * One launch, normalised: what `start` reduces to, so the
 * command, permission and process code below is written once.
 */
interface Launch {
  readonly agentId: HarnessHandle["agentId"];
  readonly prompt: string;
  readonly policy: ClaudeToolPolicy;
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
}

export interface ClaudeHarnessOptions {
  /**
   * What is spawned in place of `claude` by name: `file ...args <cli args>`
   * (P16 S-01). On a machine, the image's Node and the CLI's script, so a
   * project's pinned Node first on `PATH` cannot run the CLI. Absent, `claude`
   * is found on `PATH` as before.
   */
  readonly launcher?: CliLauncher;
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
  /** Request capture (P20 S-02); on by default whenever a launch supplies `measurements`. */
  readonly requestCapture?: ClaudeRequestCaptureOptions;
  /**
   * Called once per launch at its ending, synchronously, before the capture and
   * config directories are removed. Errors in it are swallowed.
   */
  readonly onCapture?: (report: ClaudeCaptureReport) => void;
  /** Injected so a test needs no real receiver process. */
  readonly startCapture?: typeof startClaudeCapture;
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
  const launcher = options.launcher;
  const startCapture = options.startCapture ?? startClaudeCapture;
  const captureEnabled = options.requestCapture?.enabled !== false;
  const kill =
    options.kill ??
    ((pid, signal) => {
      process.kill(pid, signal);
    });

  /** Handle → run state. Weak so a completed run is collectable. */
  const runs = new WeakMap<HarnessHandle, RunState>();

  const launch = async (input: Launch): Promise<HarnessHandle> => {
    const policy = input.policy;
    const prompt = input.prompt;

    let resolveExit: (exit: HarnessExit) => void = () => {};
    const exitPromise = new Promise<HarnessExit>((resolve) => {
      resolveExit = resolve;
    });

    // Request capture starts first: whether the stream also derives request
    // observations depends on it. A start failure is never a launch failure.
    let capture: ClaudeCapture | undefined;
    let captureDir: string | undefined;
    let captureStartError: string | undefined;
    if (input.measurements !== undefined && captureEnabled) {
      try {
        captureDir = fs.makeTempDir("nightshift-claude-capture-");
        capture = await startCapture({
          journalPath: join(captureDir, "telemetry.ndjson"),
          sink: input.measurements,
          fallbackVersion: VERIFIED_CLAUDE_VERSION,
          ...(options.requestCapture?.exportIntervalMs === undefined
            ? {}
            : { exportIntervalMs: options.requestCapture.exportIntervalMs }),
        });
      } catch (error) {
        captureStartError = messageOf(error);
        if (captureDir !== undefined) fs.removeDir(captureDir);
        captureDir = undefined;
      }
    }
    const mode: ClaudeCaptureMode =
      input.measurements === undefined ? "none" : capture === undefined ? "stream" : "otlp";

    // Counts the stream-derived request observations, for the exit's coverage.
    let streamedRequests = 0;
    const streamSink: MeasurementSink | undefined =
      input.measurements === undefined
        ? undefined
        : {
            observe: (observation) => {
              if (observation.kind === "request") streamedRequests += 1;
              input.measurements?.observe(observation);
            },
          };

    // Closing stdin ends the session; this decides when (`session.ts`). The
    // child is spawned below, so the closer reaches it through the state.
    const closer = createSessionCloser({ close: () => state.child?.stdin?.end() });
    const interpreter = createStreamInterpreter({
      sink: input.sink,
      clock,
      context: { agentId: input.agentId },
      finishingTools: finishingToolsFor(input.mcp?.name),
      onActivity: closer.onActivity,
      ...(streamSink === undefined ? {} : { measurements: streamSink }),
      streamRequests: mode !== "otlp",
      ...(input.runAs === undefined ? {} : { started: { user: input.runAs.user } }),
    });

    // The capability is in neither this environment nor the argv derived from
    // it, except on win32 where no other user runs the process (module header).
    const env = withTmpDir(
      sanitizeClaudeEnvironment({
        platform,
        parentEnv: input.parentEnv,
        extra: {
          ...input.extraEnv,
          ...HEADLESS_CLAUDE_ENV,
          ...(capture === undefined ? {} : capture.env),
          ...(capture !== undefined && platform === "win32"
            ? claudeTelemetryHeaderEnv(capture.capability)
            : {}),
        },
      }),
      input.tmpDir,
    );

    const state: RunState = {
      interpreter,
      exit: exitPromise,
      cwd: input.worktree,
      env,
      child: undefined,
      configDir: undefined,
      mode,
      capture,
      captureDir,
      captureStartError,
      finishing: false,
      runAs: input.runAs,
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
    const settle = (given: HarnessExit, extra: Readonly<Record<string, unknown>> = {}): void => {
      if (state.settledExit !== undefined) return;
      // A failure carries its summary on the exit too, for callers with no sink.
      const exit: HarnessExit =
        given.kind === "failed" && given.detail === undefined && typeof extra.summary === "string"
          ? { ...given, detail: extra.summary }
          : given;
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

    /** Stops the receiver within a bound; never rejects, never outlives the bound. */
    const stopCapture = async (): Promise<{
      result?: ClaudeCaptureResult;
      stopError?: string;
    }> => {
      if (state.capture === undefined) return {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const bound = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), CAPTURE_STOP_BOUND_MS);
        });
        const stopped = await Promise.race([
          state.capture.stop(millis(CAPTURE_STOP_GRACE_MS)),
          bound,
        ]);
        return stopped === "timeout"
          ? { stopError: "capture stop timed out" }
          : { result: stopped };
      } catch (error) {
        return { stopError: messageOf(error) };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    /**
     * The one ending sequence, run once whatever the ending: stop the capture,
     * hand `onCapture` the journal while it exists, remove the capture then the
     * config directory, and only then settle. `build` makes the exit from what
     * the capture reported. Nothing in it can keep `exit` from settling.
     */
    const finish = (
      build: (capture: CaptureEnding) => {
        readonly exit: HarnessExit;
        readonly extra?: Readonly<Record<string, unknown>>;
      },
    ): void => {
      if (state.finishing) return;
      state.finishing = true;
      void (async () => {
        let ending: CaptureEnding = { mode, requestsStreamed: streamedRequests };
        try {
          const stopped = await stopCapture();
          ending = {
            mode,
            requestsStreamed: streamedRequests,
            ...optionalField("result", stopped.result),
            ...optionalField("stopError", stopped.stopError),
            ...optionalField("startError", state.captureStartError),
          };
          if (options.onCapture !== undefined && mode !== "none") {
            try {
              options.onCapture({
                agentId: input.agentId,
                mode,
                ...optionalField("result", stopped.result),
                ...(state.captureDir === undefined
                  ? {}
                  : { journalPath: join(state.captureDir, "telemetry.ndjson") }),
                ...optionalField("startError", state.captureStartError),
                ...optionalField("stopError", stopped.stopError),
              });
            } catch {
              // An observer's fault is not the run's.
            }
          }
        } finally {
          if (state.captureDir !== undefined) fs.removeDir(state.captureDir);
          if (state.configDir !== undefined) fs.removeDir(state.configDir);
        }
        const built = build(ending);
        settle(built.exit, { ...built.extra, ...capturePayload(ending) });
      })().catch(() => {
        // Unreachable by construction; `exit` must settle regardless.
        settle({ kind: "failed", exitCode: UNKNOWN_EXIT_CODE });
      });
    };

    /** A launch that never got off the ground. Rule 3: `failed`, not a rejection. */
    const failToLaunch = (reason: string): HarnessHandle => {
      finish((ending) => ({
        exit: {
          kind: "failed",
          exitCode: SPAWN_FAILURE_EXIT_CODE,
          ...measuresFor(interpreter.outcome, ending, false),
        },
        extra: { summary: reason },
      }));
      const handle: HarnessHandle = { agentId: input.agentId, exit: exitPromise };
      runs.set(handle, state);
      return handle;
    };

    let configDir: string;
    let mcpConfigPath: string;
    let settingsPath: string;
    try {
      configDir = fs.makeTempDir("nightshift-claude-");
      state.configDir = configDir;
      mcpConfigPath = join(configDir, "mcp.json");
      settingsPath = join(configDir, "settings.json");
      fs.writeConfigFile(
        mcpConfigPath,
        input.mcp === undefined ? buildEmptyMcpConfig() : buildMcpConfig(input.mcp),
      );
      let otelHeadersHelper: string | undefined;
      if (capture !== undefined) {
        // 0600, before the grant below hands the directory to the agent's user.
        // On win32 there is no helper and the header travels in the environment.
        const headersPath = join(configDir, "otel-headers.json");
        otelHeadersHelper = claudeTelemetryHeadersHelper(headersPath, platform);
        if (otelHeadersHelper !== undefined) {
          fs.writeConfigFile(headersPath, claudeTelemetryHeadersFile(capture.capability));
        }
      }
      fs.writeConfigFile(
        settingsPath,
        buildSettings(otelHeadersHelper === undefined ? {} : { otelHeadersHelper }),
      );
      // Another user runs the process (D-P10-25): the configuration, which
      // carries this agent's own token and launch, becomes that user's to read.
      // The capture directory is never granted: the journal stays the engine's.
      if (input.runAs !== undefined) await input.runAs.grant(configDir);
    } catch (error) {
      return failToLaunch(`could not write the Claude configuration: ${messageOf(error)}`);
    }

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
      model: input.model,
      mcpConfigPath,
      settingsPath,
      policy,
      ...(input.resume === undefined ? {} : { resumeSessionId: input.resume.sessionId }),
    });

    let child: SpawnedChild;
    try {
      const command = commandAs(
        input.runAs,
        launcher?.file ?? CLAUDE_COMMAND,
        [...(launcher?.args ?? []), ...args],
        env,
      );
      child = spawn(command.file, command.args, {
        cwd: input.worktree,
        env: command.env,
        // POSIX: its own process group, so cancel can signal the tree.
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      transcript?.close();
      return failToLaunch(`could not start ${CLAUDE_COMMAND}: ${messageOf(error)}`);
    }
    state.child = child;
    // The brief, as the session's first message. Stdin stays open: closing it
    // is how the session ends, and `closer` decides when.
    child.stdin?.on("error", () => {
      // The child went before reading it; `close` reports how.
    });
    child.stdin?.write(claudeInputLine(prompt));

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
      finish((ending) => ({
        exit: {
          kind: "failed",
          exitCode: SPAWN_FAILURE_EXIT_CODE,
          ...measuresFor(interpreter.outcome, ending, false),
        },
        extra: { summary: `${CLAUDE_COMMAND} failed to run: ${error.message}` },
      }));
    });

    child.on("close", (code, signal) => {
      closer.dispose();
      interpreter.end();
      transcript?.close();
      const extra = stderrTail.trim().length === 0 ? {} : { summary: stderrTail.trim() };
      finish((ending) => ({
        exit: exitFor(
          state.cancelRequested,
          code,
          signal,
          interpreter.outcome,
          measuresFor(interpreter.outcome, ending, state.cancelRequested || signal !== null),
        ),
        extra,
      }));
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
        claudePrompt(brief, claudeBriefAddendum({ mcpServerName, tools })),
      ),
      policy: claudeToolPolicy(),
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
    });

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
        // Another user's processes are signalled as that user (D-P10-25).
        kill: state.runAs?.kill === undefined ? kill : state.runAs.kill.bind(state.runAs),
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
      // A handle this adapter did not create. P10 answers this from the control
      // plane; in P3 the honest answer is that nothing here started it.
      return "created";
    }
    const settled = state.settledExit;
    // `agentStatusForExit` is the shared mapping in `@nightshift/harness`, used
    // here rather than repeated so no adapter can answer `status` and `exit`
    // differently — which is the property the conformance suite checks.
    return settled === undefined ? "started" : agentStatusForExit(settled);
  };

  return {
    id: CLAUDE_HARNESS_ID,
    capabilities: { usage: true, observations: true },
    start,
    cancel,
    status,
  };
};

/** What the capture reported at an ending, as the exit and the payload read it. */
interface CaptureEnding {
  readonly mode: ClaudeCaptureMode;
  /** Stream-derived request observations emitted (stream mode only). */
  readonly requestsStreamed: number;
  readonly result?: ClaudeCaptureResult;
  readonly startError?: string;
  readonly stopError?: string;
}

/**
 * The exit's measures: the stream's usage and scope merged with the capture's
 * verdict. `complete` needs all of: a complete, uninterrupted stream result;
 * the otlp mode; and a complete capture result. Otherwise `partial` when
 * anything was seen, `unknown` when nothing was.
 */
const measuresFor = (
  outcome: StreamOutcome,
  ending: CaptureEnding,
  interrupted: boolean,
): ExitMeasures => {
  const measures = outcome.measures;
  const requestsSeen = ending.requestsStreamed + (ending.result?.requests ?? 0);
  const coverage =
    !interrupted &&
    measures.resultCoverage === "complete" &&
    ending.mode === "otlp" &&
    ending.result?.complete === true
      ? "complete"
      : measures.usage !== undefined || requestsSeen > 0
        ? "partial"
        : "unknown";
  return {
    ...(measures.usage === undefined
      ? {}
      : {
          usage: measures.usage,
          ...optionalField("counters", measures.counters),
          usageScope: measures.usageScope,
          inclusion: measures.inclusion,
        }),
    ...optionalField("observedModel", measures.observedModel),
    coverage,
  };
};

/** The bounded `capture` field of the ending payload. */
const capturePayload = (ending: CaptureEnding): Readonly<Record<string, unknown>> => {
  if (ending.mode === "none") return {};
  const result = ending.result;
  const reasons: string[] = [
    ...(result?.reasons ?? []),
    ...(ending.mode === "stream" ? ["stream_only"] : []),
    ...(ending.stopError === undefined ? [] : ["capture_stop_failed"]),
  ];
  return {
    capture: {
      mode: ending.mode,
      requests: ending.mode === "otlp" ? (result?.requests ?? 0) : ending.requestsStreamed,
      apiErrors: result?.apiErrors ?? 0,
      dropped: (result?.droppedRecords ?? 0) + (result?.unidentifiedRequests ?? 0),
      complete: ending.mode === "otlp" && result?.complete === true,
      reasons: reasons.slice(0, 8),
      ...optionalField("gap", result?.gap),
      ...optionalField("startError", ending.startError?.slice(0, 200)),
      ...optionalField("stopError", ending.stopError?.slice(0, 200)),
    },
  };
};

/** The exit mapping, as the table at the top of this file states it. */
const exitFor = (
  cancelRequested: boolean,
  code: number | null,
  signal: string | null,
  outcome: StreamOutcome,
  measured: ExitMeasures,
): HarnessExit => {
  if (cancelRequested) return { kind: "cancelled", ...measured };
  if (signal !== null) return { kind: "interrupted", signal, ...measured };
  // Contract v1: what the run cost rides on the exit, where Claude said. P8: so
  // do the session a question can resume (D-P8-15) and, when the provider
  // refused before any work, that the route could not start (D-P8-06).
  const said = {
    ...measured,
    ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
  };
  if (code === 0 && outcome.sawResult && !outcome.resultErrored) {
    return {
      kind: "completed",
      ...said,
      ...(outcome.resultText === undefined ? {} : { result: outcome.resultText }),
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
