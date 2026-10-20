/**
 * Two halves: an injected spawn, which proves the runner's own logic without a
 * real child, and real `node -e` processes, which prove the parts a fake can
 * only assert about itself — that a shell really receives the quotes, that a
 * process tree really dies, that the child's environment really lacks the
 * operator's secrets.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSteppingClock } from "@nightshift/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepChunk } from "./run.js";
import { runVerificationSteps, SPAWN_FAILURE_EXIT_CODE, TIMEOUT_EXIT_CODE } from "./run.js";
import type { ChildOutputStream, SpawnedChild, SpawnLike, SpawnLikeOptions } from "./spawn.js";

const step = (
  id: string,
  command: string,
  time: { timeoutSeconds?: number; cleanupSeconds?: number } = {},
) => ({ id, command, ...time });
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Any directory that exists; nothing here writes into it. */
const CWD = tmpdir();

/** The bound above which an event may not carry output inline (A-08). */
const INLINE_EVENT_BOUND = 8192;

/**
 * `node -e` rather than a fixture script or a shell builtin: it exists on both
 * CI legs, and the same command string survives `sh -c` and `cmd /c` as long as
 * the script itself contains no double quote.
 */
const nodeCommand = (script: string): string => `"${process.execPath}" -e "${script}"`;

const expectedShellFile = process.platform === "win32" ? "cmd.exe" : "sh";

// ---------------------------------------------------------------------------
// The fake child
// ---------------------------------------------------------------------------

type CloseListener = (code: number | null, signal: string | null) => void;
type ErrorListener = (error: Error) => void;

class FakeStream implements ChildOutputStream {
  private readonly listeners: ((chunk: Uint8Array) => void)[] = [];
  on(_event: "data", listener: (chunk: Uint8Array) => void): void {
    this.listeners.push(listener);
  }
  emit(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const listener of this.listeners) listener(bytes);
  }
}

class FakeChild implements SpawnedChild {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  /**
   * Which signal ends the child: SIGTERM (the default, a step that cleans up
   * and exits), only SIGKILL (a step that ignores SIGTERM), or never (the
   * grace path).
   */
  dies: "on-sigterm" | "on-sigkill" | "never" = "on-sigterm";
  private readonly closeListeners: CloseListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];

  constructor(readonly pid: number | undefined = undefined) {}

  on(event: "close", listener: CloseListener): void;
  on(event: "error", listener: ErrorListener): void;
  on(event: "close" | "error", listener: CloseListener | ErrorListener): void {
    if (event === "close") this.closeListeners.push(listener as CloseListener);
    else this.errorListeners.push(listener as ErrorListener);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.dies === "never") return true;
    if (this.dies === "on-sigkill" && signal !== "SIGKILL") return true;
    this.close(null, typeof signal === "string" ? signal : "SIGKILL");
    return true;
  }

  close(code: number | null, signal: string | null = null): void {
    for (const listener of this.closeListeners) listener(code, signal);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnLikeOptions;
  readonly child: FakeChild;
}

/**
 * A spawn whose children behave as `behaviour` says, one microtask later — the
 * runner attaches its listeners synchronously after spawning, so anything
 * emitted in the same tick would be emitted into the void.
 */
const fakeSpawn = (
  behaviour: (child: FakeChild, call: SpawnCall) => void,
): { calls: SpawnCall[]; spawn: SpawnLike } => {
  const calls: SpawnCall[] = [];
  const spawn: SpawnLike = (file, args, options) => {
    const child = new FakeChild();
    const call: SpawnCall = { file, args, options, child };
    calls.push(call);
    queueMicrotask(() => behaviour(child, call));
    return child;
  };
  return { calls, spawn };
};

// ---------------------------------------------------------------------------

describe("runVerificationSteps, with an injected spawn", () => {
  it("runs each step through the platform shell in the given directory", async () => {
    const { calls, spawn } = fakeSpawn((child) => child.close(0));

    await runVerificationSteps({
      steps: [step("lint", "npm run lint")],
      cwd: CWD,
      spawn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(expectedShellFile);
    expect(calls[0]?.args.at(-1)).toContain("npm run lint");
    expect(calls[0]?.options.cwd).toBe(CWD);
    expect(calls[0]?.options.shell).toBe(false);
    // POSIX needs its own process group to kill; Windows needs verbatim args.
    expect(calls[0]?.options.detached).toBe(process.platform !== "win32");
    expect(calls[0]?.options.windowsVerbatimArguments).toBe(process.platform === "win32");
  });

  it("says as each step starts and ends, with its exit code (2026-10-13)", async () => {
    const { spawn } = fakeSpawn((child, call) =>
      child.close(call.args.at(-1)?.includes("bad") ? 3 : 0),
    );
    const events: unknown[] = [];
    await runVerificationSteps({
      steps: [step("lint", "npm run lint"), step("test", "npm run bad")],
      cwd: CWD,
      spawn,
      onStep: (event) => events.push(event),
    });
    expect(events).toEqual([
      { stepId: "lint", phase: "started" },
      expect.objectContaining({ stepId: "lint", phase: "finished", exitCode: 0, timedOut: false }),
      { stepId: "test", phase: "started" },
      expect.objectContaining({ stepId: "test", phase: "finished", exitCode: 3 }),
    ]);
  });

  it("runs a step through the wrapper it is given, with the wrapper's file, arguments and environment", async () => {
    const { calls, spawn } = fakeSpawn((child) => child.close(0));
    await runVerificationSteps({
      steps: [step("test", "npm test")],
      cwd: CWD,
      spawn,
      as: (invocation) => ({
        file: "sudo",
        args: ["-n", "-u", "worker-3", invocation.file, ...invocation.args],
        env: { PATH: invocation.env.PATH ?? "" },
      }),
    });
    expect(calls[0]?.file).toBe("sudo");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-n", "-u", "worker-3"]);
    expect(calls[0]?.args).toContain(expectedShellFile);
    expect(calls[0]?.args.at(-1)).toContain("npm test");
    expect(Object.keys(calls[0]?.options.env ?? {})).toEqual(["PATH"]);
  });

  it("does not pass a variable planted in process.env to the step", async () => {
    process.env.NIGHTSHIFT_TEST_SECRET = "must-not-leak";
    try {
      const { calls, spawn } = fakeSpawn((child) => child.close(0));

      await runVerificationSteps({
        steps: [step("test", "npm test")],
        cwd: CWD,
        env: { NIGHTSHIFT_STEP_EXTRA: "added-on-purpose" },
        spawn,
      });

      const env = calls[0]?.options.env ?? {};
      expect(Object.keys(env)).not.toContain("NIGHTSHIFT_TEST_SECRET");
      expect(Object.values(env)).not.toContain("must-not-leak");
      // Not vacuous: the base and the caller's addition are both there.
      expect(env.PATH).toBeDefined();
      expect(env.NIGHTSHIFT_STEP_EXTRA).toBe("added-on-purpose");
    } finally {
      delete process.env.NIGHTSHIFT_TEST_SECRET;
    }
  });

  it("records the exit code, the captured output and a duration from the clock", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout.emit("out-");
      child.stderr.emit("err");
      child.close(0);
    });

    const results = await runVerificationSteps({
      steps: [step("one", "true")],
      cwd: CWD,
      spawn,
      clock: createSteppingClock(1_000, 5),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stepId).toBe("one");
    expect(results[0]?.command).toBe("true");
    expect(results[0]?.exitCode).toBe(0);
    expect(results[0]?.timedOut).toBe(false);
    // The clock is read at the start, at the first output, and at the end.
    expect(results[0]?.quietMs).toBe(5);
    expect(results[0]?.durationMs).toBe(10);
    // Both pipes land in one buffer, in arrival order.
    expect(decode(results[0]?.output ?? new Uint8Array())).toBe("out-err");
  });

  it("runs steps sequentially and keeps going after a failure", async () => {
    const order: string[] = [];
    const { spawn } = fakeSpawn((child, call) => {
      const command = String(call.args.at(-1));
      order.push(command);
      child.close(command.includes("middle") ? 2 : 0);
    });

    const results = await runVerificationSteps({
      steps: [step("a", "first"), step("b", "middle"), step("c", "last")],
      cwd: CWD,
      spawn,
    });

    // A reader of the Verification wants to know the lint failed *and* whether
    // the tests did, so a failing step never short-circuits the rest.
    expect(results.map((result) => result.stepId)).toEqual(["a", "b", "c"]);
    expect(results.map((result) => result.exitCode)).toEqual([0, 2, 0]);
    expect(order.map((command) => command.includes("first") || command.includes("last"))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("reports a signalled step as 128 + the signal number", async () => {
    const { spawn } = fakeSpawn((child) => child.close(null, "SIGKILL"));

    const results = await runVerificationSteps({
      steps: [step("one", "true")],
      cwd: CWD,
      spawn,
    });

    expect(results[0]?.exitCode).toBe(137);
    expect(results[0]?.timedOut).toBe(false);
  });

  it("records a child that never ran as a failure, with the reason in the log", async () => {
    const { spawn } = fakeSpawn((child) => child.fail(new Error("spawn sh ENOENT")));

    const results = await runVerificationSteps({
      steps: [step("one", "true")],
      cwd: CWD,
      spawn,
    });

    expect(results[0]?.exitCode).toBe(SPAWN_FAILURE_EXIT_CODE);
    expect(decode(results[0]?.output ?? new Uint8Array())).toContain("spawn sh ENOENT");
  });

  it("records a step even when a spawn throws synchronously", async () => {
    const results = await runVerificationSteps({
      steps: [step("one", "true"), step("two", "true")],
      cwd: CWD,
      spawn: () => {
        throw new Error("ENOENT: no such directory");
      },
    });

    expect(results.map((result) => result.exitCode)).toEqual([
      SPAWN_FAILURE_EXIT_CODE,
      SPAWN_FAILURE_EXIT_CODE,
    ]);
    expect(decode(results[1]?.output ?? new Uint8Array())).toContain("no such directory");
  });

  it("feeds the sink every byte it later returns", async () => {
    const chunks: StepChunk[] = [];
    const { spawn } = fakeSpawn((child) => {
      child.stdout.emit("one");
      child.stderr.emit("two");
      child.close(0);
    });

    const results = await runVerificationSteps({
      steps: [step("s", "true")],
      cwd: CWD,
      spawn,
      sink: (chunk) => chunks.push(chunk),
    });

    expect(chunks.map((chunk) => chunk.stream)).toEqual(["stdout", "stderr"]);
    expect(chunks.every((chunk) => chunk.stepId === "s")).toBe(true);
    expect(chunks.map((chunk) => decode(chunk.bytes)).join("")).toBe(
      decode(results[0]?.output ?? new Uint8Array()),
    );
  });

  it("finishes the run when a sink throws", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout.emit("output");
      child.close(0);
    });

    const results = await runVerificationSteps({
      steps: [step("s", "true")],
      cwd: CWD,
      spawn,
      sink: () => {
        throw new Error("the log tail died");
      },
    });

    // Evidence outlives a misbehaving consumer of it.
    expect(decode(results[0]?.output ?? new Uint8Array())).toBe("output");
    expect(results[0]?.exitCode).toBe(0);
  });

  it("sends SIGTERM to a step that outlives its timeout and runs the next one", async () => {
    vi.useFakeTimers();
    try {
      const { calls, spawn } = fakeSpawn((child, call) => {
        if (call.args.join(" ").includes("sleep")) return;
        child.close(0);
      });

      const pending = runVerificationSteps({
        steps: [step("slow", "sleep 600", { timeoutSeconds: 1 }), step("after", "true")],
        cwd: CWD,
        spawn,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const results = await pending;

      expect(results[0]?.timedOut).toBe(true);
      expect(results[0]?.exitCode).toBe(TIMEOUT_EXIT_CODE);
      expect(calls[0]?.child.signals).toEqual(["SIGTERM"]);
      expect(results[1]?.timedOut).toBe(false);
      expect(results[1]?.exitCode).toBe(0);
      expect(results).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("a step that overruns its time", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const overrun = (
      dies: FakeChild["dies"],
      time: { timeoutSeconds: number; cleanupSeconds: number },
    ) => {
      vi.useFakeTimers();
      const { calls, spawn } = fakeSpawn((child) => {
        child.dies = dies;
      });
      const pending = runVerificationSteps({
        steps: [step("slow", "sleep 600", time)],
        cwd: CWD,
        spawn,
      });
      return { calls, pending };
    };

    it("dies on SIGTERM: gets only SIGTERM, and the cleanup timer is cleared", async () => {
      const { calls, pending } = overrun("on-sigterm", { timeoutSeconds: 1, cleanupSeconds: 5 });
      await vi.advanceTimersByTimeAsync(1_000);
      const results = await pending;
      // Past the cleanup time and the grace: nothing more is sent.
      await vi.advanceTimersByTimeAsync(10_000);

      expect(calls[0]?.child.signals).toEqual(["SIGTERM"]);
      expect(results[0]).toMatchObject({ timedOut: true, exitCode: TIMEOUT_EXIT_CODE });
      const log = decode(results[0]?.output ?? new Uint8Array());
      expect(log).toContain("exceeded its timeout of 1 seconds");
      expect(log).toContain("sent SIGTERM");
      expect(log).toContain("5 seconds to clean up");
      expect(log).not.toContain("ran out");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores SIGTERM: gets SIGKILL only after its cleanup time", async () => {
      const { calls, pending } = overrun("on-sigkill", { timeoutSeconds: 1, cleanupSeconds: 5 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls[0]?.child.signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls[0]?.child.signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(1);
      const results = await pending;

      expect(calls[0]?.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(results[0]).toMatchObject({ timedOut: true, exitCode: TIMEOUT_EXIT_CODE });
      const log = decode(results[0]?.output ?? new Uint8Array());
      expect(log).toContain("exceeded its timeout");
      expect(log).toContain("cleanup time of 5 seconds ran out");
      expect(log).toContain("killed");
    });

    it("never dies: is finished by the grace timer after the cleanup time", async () => {
      const { calls, pending } = overrun("never", { timeoutSeconds: 1, cleanupSeconds: 2 });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls[0]?.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await pending;

      expect(results[0]).toMatchObject({ timedOut: true, exitCode: TIMEOUT_EXIT_CODE });
      expect(decode(results[0]?.output ?? new Uint8Array())).toContain("ran out");
    });
  });

  it("sends no signal to a step that finishes inside its time, and keeps its exit code", async () => {
    vi.useFakeTimers();
    try {
      const { calls, spawn } = fakeSpawn((child) => child.close(3));
      const pending = runVerificationSteps({
        steps: [step("quick", "exit 3", { timeoutSeconds: 1, cleanupSeconds: 1 })],
        cwd: CWD,
        spawn,
      });
      const results = await pending;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(calls[0]?.child.signals).toEqual([]);
      expect(results[0]).toMatchObject({ timedOut: false, exitCode: 3 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runVerificationSteps, with real processes", () => {
  it("runs a passing sequence in order", async () => {
    const results = await runVerificationSteps({
      steps: [
        step("one", nodeCommand("process.stdout.write('first')")),
        step("two", nodeCommand("process.stdout.write('second')")),
      ],
      cwd: CWD,
    });

    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(results.map((result) => decode(result.output))).toEqual(["first", "second"]);
    expect(results.every((result) => result.timedOut)).toBe(false);
    expect(results.every((result) => result.durationMs >= 0)).toBe(true);
  });

  it("captures stderr as well as stdout, and a non-zero exit in the middle does not stop the last step", async () => {
    const results = await runVerificationSteps({
      steps: [
        step("lint", nodeCommand("process.stdout.write('lint ok')")),
        step("test", nodeCommand("process.stderr.write('boom'); process.exit(3)")),
        step("build", nodeCommand("process.stdout.write('build ok')")),
      ],
      cwd: CWD,
    });

    expect(results.map((result) => result.exitCode)).toEqual([0, 3, 0]);
    expect(decode(results[1]?.output ?? new Uint8Array())).toContain("boom");
    expect(decode(results[2]?.output ?? new Uint8Array())).toBe("build ok");
  });

  it("captures output larger than the inline event bound whole", async () => {
    const size = 40_000;
    expect(size).toBeGreaterThan(INLINE_EVENT_BOUND);

    const results = await runVerificationSteps({
      steps: [step("noisy", nodeCommand(`process.stdout.write('x'.repeat(${size}))`))],
      cwd: CWD,
    });

    // Bytes, not a string, and every one of them: this is what gets uploaded
    // as the step's log artifact.
    expect(results[0]?.output).toBeInstanceOf(Uint8Array);
    expect(results[0]?.output.byteLength).toBe(size);
    expect(decode(results[0]?.output ?? new Uint8Array())).toBe("x".repeat(size));
  });

  it("gives the step no variable planted in this process's environment", async () => {
    process.env.NIGHTSHIFT_TEST_SECRET = "must-not-leak";
    try {
      const results = await runVerificationSteps({
        steps: [
          step(
            "peek",
            nodeCommand(
              "process.stdout.write(String(process.env.NIGHTSHIFT_TEST_SECRET) + ':' + String(process.env.PATH !== undefined))",
            ),
          ),
        ],
        cwd: CWD,
      });

      // `undefined:true` — the secret is gone and PATH survived, so the
      // assertion is not passing because the environment was simply empty.
      expect(decode(results[0]?.output ?? new Uint8Array())).toBe("undefined:true");
    } finally {
      delete process.env.NIGHTSHIFT_TEST_SECRET;
    }
  });

  it("kills a step that outlives its timeout and runs the next one", async () => {
    const started = Date.now();
    const results = await runVerificationSteps({
      steps: [
        step("hang", nodeCommand("setInterval(function () {}, 50)"), { timeoutSeconds: 1 }),
        step("after", nodeCommand("process.stdout.write('still ran')")),
      ],
      cwd: CWD,
    });

    expect(results[0]?.timedOut).toBe(true);
    expect(results[0]?.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(results[1]?.timedOut).toBe(false);
    expect(decode(results[1]?.output ?? new Uint8Array())).toBe("still ran");
    // The point of the timeout is that it bounds the run.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("kills the whole process tree, not just the shell (POSIX)", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip(
        "POSIX-only: process groups do not exist on Windows, where taskkill /T walks the tree instead",
      );
      return;
    }

    // A pipeline leaves `sh` with two children that both hold the captured
    // pipe open. If only the direct child were killed, `close` would never
    // fire and this test would fail by timing out rather than by assertion.
    const results = await runVerificationSteps({
      steps: [
        step("tree", `${nodeCommand("setInterval(function () {}, 50)")} | cat`, {
          timeoutSeconds: 1,
        }),
      ],
      cwd: CWD,
    });

    expect(results[0]?.timedOut).toBe(true);
    expect(results[0]?.exitCode).toBe(TIMEOUT_EXIT_CODE);
    // And the tree really died on the signal: had the grandchildren survived,
    // the step would have been recorded by the two-second grace timer instead,
    // so anything under that proves `close` arrived because the tree went away.
    expect(results[0]?.durationMs).toBeLessThan(1_500);
  });

  it("lets a step clean up on SIGTERM before it ends (POSIX)", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip("POSIX-only: asserts sh traps and SIGTERM");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "nightshift-cleanup-"));
    try {
      const marker = join(dir, "cleaned");
      // On dash (this machine's /bin/sh), an EXIT-only trap does NOT fire on an
      // untrapped SIGTERM; trapping TERM as well is what makes the EXIT trap
      // run, and it is what a step's author must do too.
      const command = `trap 'echo cleaned > "${marker}"' EXIT; trap 'exit 143' TERM; sleep 30 & wait`;
      const results = await runVerificationSteps({
        steps: [step("tidy", command, { timeoutSeconds: 1, cleanupSeconds: 2 })],
        cwd: CWD,
      });

      expect(await readFile(marker, "utf8")).toBe("cleaned\n");
      expect(results[0]?.timedOut).toBe(true);
      expect(results[0]?.exitCode).toBe(TIMEOUT_EXIT_CODE);
      // It ended on the SIGTERM, well before the cleanup time ran out.
      expect(results[0]?.durationMs).toBeLessThan(2_900);
      expect(decode(results[0]?.output ?? new Uint8Array())).not.toContain("ran out");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills a step that ignores SIGTERM once its cleanup time runs out (POSIX)", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip("POSIX-only: asserts sh traps and SIGTERM");
      return;
    }
    const results = await runVerificationSteps({
      steps: [step("stubborn", "trap '' TERM; sleep 30", { timeoutSeconds: 1, cleanupSeconds: 1 })],
      cwd: CWD,
    });

    expect(results[0]?.timedOut).toBe(true);
    expect(results[0]?.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(2_000);
    expect(results[0]?.durationMs).toBeLessThan(6_000);
    expect(decode(results[0]?.output ?? new Uint8Array())).toContain(
      "cleanup time of 1 seconds ran out",
    );
  });

  it("leaves a step that finishes inside its time untouched (POSIX)", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip("POSIX-only: asserts sh traps and SIGTERM");
      return;
    }
    const results = await runVerificationSteps({
      steps: [step("quick", "trap 'echo got-term' TERM; echo fine; exit 7", { timeoutSeconds: 5 })],
      cwd: CWD,
    });

    expect(results[0]).toMatchObject({ timedOut: false, exitCode: 7 });
    expect(decode(results[0]?.output ?? new Uint8Array())).toBe("fine\n");
  });

  it("runs a command containing quotes through sh -c (POSIX)", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip("POSIX-only: this leg asserts sh quoting; the cmd.exe leg runs on Windows");
      return;
    }

    const results = await runVerificationSteps({
      steps: [step("quoted", `printf %s 'say "hi"'`)],
      cwd: CWD,
    });

    expect(results[0]?.exitCode).toBe(0);
    expect(decode(results[0]?.output ?? new Uint8Array())).toBe('say "hi"');
  });

  it("runs a command containing quotes through cmd /c (Windows)", async (ctx) => {
    if (process.platform !== "win32") {
      ctx.skip("Windows-only: this leg asserts cmd.exe quoting; the sh leg runs on this platform");
      return;
    }

    const results = await runVerificationSteps({
      steps: [step("quoted", 'echo say "hi"')],
      cwd: CWD,
    });

    expect(results[0]?.exitCode).toBe(0);
    expect(decode(results[0]?.output ?? new Uint8Array()).trim()).toBe('say "hi"');
  });
});

describe("a step's quiet start (D-P17-05)", () => {
  it("ends at the child's first byte, and lasts the whole step when it never speaks", async () => {
    let now = 0;
    const clock = { now: () => now };
    const { spawn } = fakeSpawn((child, call) => {
      if (call.args.join(" ").includes("quiet")) {
        now = 5_000;
        child.close(0);
        return;
      }
      now = 1_200;
      child.stdout.emit("starting\n");
      now = 4_000;
      child.close(0);
    });
    const [talks, quiet] = await runVerificationSteps({
      steps: [
        { id: "talks", command: "echo talks" },
        { id: "quiet", command: "echo quiet" },
      ],
      cwd: ".",
      spawn,
      clock,
    });
    expect(talks).toMatchObject({ quietMs: 1_200, durationMs: 4_000 });
    // Started at 4 000 on the same clock, and silent until it closed at 5 000.
    expect(quiet).toMatchObject({ quietMs: 1_000, durationMs: 1_000 });
  });
});
