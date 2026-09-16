/**
 * Running a Program Contract's verification steps (D-P3-06).
 *
 * This module produces evidence and decides nothing. It does not know what a
 * node is, it writes no `Verification` record, it touches no git worktree and
 * no S3 bucket. The execution layer supplies a clean checkout's directory, gets
 * back one `StepResult` per step, and is the only writer of the record that
 * results (A-05). Keeping the three apart is what makes "only Nightshift
 * asserts verification" structural rather than a convention.
 *
 * Two properties the rest of the system depends on:
 *
 * - **Every step runs.** A failing step does not stop the ones after it,
 *   because the `Verification` record carries the whole `commands` array and a
 *   reader wants to know whether the lint failed as well as the tests.
 * - **Nothing hangs.** A step that outlives its timeout has its process tree
 *   killed and is recorded with a non-zero exit code and `timedOut: true`.
 */

import { constants } from "node:os";
import type { VerificationStep } from "@nightshift/contracts";
import type { Clock } from "@nightshift/core";
import { systemClock } from "@nightshift/core";
import { sanitizeEnvironment } from "./environment.js";
import type { SpawnedChild, SpawnLike } from "./spawn.js";
import { killProcessTree, nodeSpawn, shellInvocation } from "./spawn.js";

export interface StepResult {
  readonly stepId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /** The captured combined stdout and stderr, as bytes. */
  readonly output: Uint8Array;
  /** True when the per-step timeout killed the process tree. */
  readonly timedOut: boolean;
}

export interface StepChunk {
  readonly stepId: string;
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
}

/** Receives output as it arrives, for later streaming. Must never throw. */
export type StepSink = (chunk: StepChunk) => void;

export interface RunVerificationInput {
  readonly steps: readonly VerificationStep[];
  readonly cwd: string;
  /** Added to the sanitized base environment, never replacing it. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Injectable process spawning, so a test needs no real child. */
  readonly spawn?: SpawnLike;
  readonly sink?: StepSink;
  /** Injected so durations are deterministic under test. */
  readonly clock?: Clock;
}

/**
 * The exit code recorded for a step the timeout killed. 124 is what GNU
 * `timeout` reports, and it is forced rather than derived: a process killed
 * mid-exit can still report 0, and a timed-out step that looks like a pass
 * would let unverified work through.
 */
export const TIMEOUT_EXIT_CODE = 124;

/**
 * The exit code recorded when the child never ran at all — a missing shell, an
 * unusable `cwd`. 127 is the shell's own "could not execute".
 */
export const SPAWN_FAILURE_EXIT_CODE = 127;

/** A process killed by a signal reports no code; shells report 128 + signal. */
const SIGNAL_EXIT_BASE = 128;

/**
 * How long after the kill we wait for `close` before recording the step
 * anyway. The kill normally lands in microseconds; this exists for the case it
 * does not (a process in an uninterruptible wait, a Windows handle that will
 * not close), where waiting forever would stall the whole run.
 */
const KILL_GRACE_MS = 2_000;

const SIGNAL_NUMBERS: ReadonlyMap<string, number> = new Map(Object.entries(constants.signals));

const encoder = new TextEncoder();

/** Node reports either a code or a signal. Map both onto one integer. */
const exitCodeFor = (code: number | null, signal: string | null): number => {
  if (code !== null) return code;
  const signalNumber = signal === null ? undefined : SIGNAL_NUMBERS.get(signal);
  return SIGNAL_EXIT_BASE + (signalNumber ?? 0);
};

interface StepRunInput {
  readonly step: VerificationStep;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly spawn: SpawnLike;
  readonly sink: StepSink | undefined;
  readonly clock: Clock;
  readonly platform: NodeJS.Platform;
}

const runStep = (input: StepRunInput): Promise<StepResult> =>
  new Promise<StepResult>((resolve) => {
    const { step } = input;
    const startedAt = input.clock.now();
    const captured: Uint8Array[] = [];
    let timedOut = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const record = (stream: "stdout" | "stderr", bytes: Uint8Array): void => {
      captured.push(bytes);
      if (input.sink === undefined) return;
      try {
        input.sink({ stepId: step.id, stream, bytes });
      } catch {
        // A sink is a streaming consumer, documented as never throwing. If one
        // does anyway, the evidence still has to be collected: losing a
        // verification run to a misbehaving log tail would be the worse bug.
      }
    };

    const note = (text: string): void => record("stderr", encoder.encode(text));

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve({
        stepId: step.id,
        command: step.command,
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
        // The contract wants a non-negative integer, and an injected clock is
        // under no obligation to move forward.
        durationMs: Math.max(0, Math.round(input.clock.now() - startedAt)),
        output: concatChunks(captured),
        timedOut,
      });
    };

    const invocation = shellInvocation(input.platform, step.command);
    let child: SpawnedChild;
    try {
      child = input.spawn(invocation.file, invocation.args, {
        cwd: input.cwd,
        env: input.env,
        // POSIX: its own process group, so the timeout can kill the tree.
        detached: input.platform !== "win32",
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: input.platform === "win32",
      });
    } catch (error) {
      // `spawn` can also throw synchronously, on a bad `cwd` or out of handles.
      note(`nightshift: could not start step ${step.id}: ${messageOf(error)}\n`);
      finish(SPAWN_FAILURE_EXIT_CODE);
      return;
    }

    child.stdout?.on("data", (chunk) => record("stdout", chunk));
    child.stderr?.on("data", (chunk) => record("stderr", chunk));

    child.on("error", (error) => {
      // The child never ran, or could not be signalled. Either way the reason
      // belongs in the log: it is the only place a human will look.
      note(`nightshift: step ${step.id} failed to run: ${error.message}\n`);
      finish(SPAWN_FAILURE_EXIT_CODE);
    });

    child.on("close", (code, signal) => finish(exitCodeFor(code, signal)));

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      note(`nightshift: step ${step.id} exceeded ${input.timeoutMs}ms and was killed\n`);
      // Armed before the kill, not after: a child that dies synchronously would
      // otherwise leave this timer behind, holding the event loop open.
      graceTimer = setTimeout(() => finish(TIMEOUT_EXIT_CODE), KILL_GRACE_MS);
      killProcessTree({
        pid: child.pid,
        platform: input.platform,
        child,
        cwd: input.cwd,
        env: input.env,
        spawn: input.spawn,
        kill: (pid, signal) => {
          process.kill(pid, signal);
        },
      });
    }, input.timeoutMs);
  });

/**
 * Run every step in order and return one result each.
 *
 * Sequential on purpose: verification steps in a Program Contract are written
 * for one working directory, and two of them running at once would race over
 * build output, ports and lock files. The `await` in the loop is the point.
 */
export const runVerificationSteps = async (
  input: RunVerificationInput,
): Promise<readonly StepResult[]> => {
  const platform = process.platform;
  const env = sanitizeEnvironment({ platform, parentEnv: process.env, extra: input.env });
  const spawn = input.spawn ?? nodeSpawn;
  const clock = input.clock ?? systemClock;
  const results: StepResult[] = [];
  for (const step of input.steps) {
    results.push(
      await runStep({
        step,
        cwd: input.cwd,
        env,
        timeoutMs: input.timeoutMs,
        spawn,
        sink: input.sink,
        clock,
        platform,
      }),
    );
  }
  return results;
};

/**
 * Join the captured chunks. Output is bytes rather than a string throughout,
 * because a build tool is free to emit invalid UTF-8 and decoding here would
 * corrupt the log before anyone could read it. Interleaving of the two pipes is
 * arrival order, which is the best a pair of pipes can offer.
 */
const concatChunks = (chunks: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
