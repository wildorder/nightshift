/**
 * Two halves: an injected spawn, which proves the runner's own logic without a
 * real child, and real `node -e` processes, which prove the parts a fake can
 * only assert about itself — that a shell really receives the quotes, that a
 * process tree really dies, that the child's environment really lacks the
 * operator's secrets.
 */

import { tmpdir } from "node:os";
import { createSteppingClock } from "@nightshift/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepChunk } from "./run.js";
import { runVerificationSteps, SPAWN_FAILURE_EXIT_CODE, TIMEOUT_EXIT_CODE } from "./run.js";
import type { ChildOutputStream, SpawnedChild, SpawnLike, SpawnLikeOptions } from "./spawn.js";

const step = (id: string, command: string) => ({ id, command });
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
  /** False models a process that ignores the kill — the grace path. */
  dieOnKill = true;
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
    if (this.dieOnKill) this.close(null, "SIGKILL");
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
      timeoutMs: 1_000,
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

  it("does not pass a variable planted in process.env to the step", async () => {
    process.env.NIGHTSHIFT_TEST_SECRET = "must-not-leak";
    try {
      const { calls, spawn } = fakeSpawn((child) => child.close(0));

      await runVerificationSteps({
        steps: [step("test", "npm test")],
        cwd: CWD,
        env: { NIGHTSHIFT_STEP_EXTRA: "added-on-purpose" },
        timeoutMs: 1_000,
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
      timeoutMs: 1_000,
      spawn,
      clock: createSteppingClock(1_000, 5),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stepId).toBe("one");
    expect(results[0]?.command).toBe("true");
    expect(results[0]?.exitCode).toBe(0);
    expect(results[0]?.timedOut).toBe(false);
    expect(results[0]?.durationMs).toBe(5);
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
      timeoutMs: 1_000,
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
      timeoutMs: 1_000,
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
      timeoutMs: 1_000,
      spawn,
    });

    expect(results[0]?.exitCode).toBe(SPAWN_FAILURE_EXIT_CODE);
    expect(decode(results[0]?.output ?? new Uint8Array())).toContain("spawn sh ENOENT");
  });

  it("records a step even when a spawn throws synchronously", async () => {
    const results = await runVerificationSteps({
      steps: [step("one", "true"), step("two", "true")],
      cwd: CWD,
      timeoutMs: 1_000,
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
      timeoutMs: 1_000,
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
      timeoutMs: 1_000,
      spawn,
      sink: () => {
        throw new Error("the log tail died");
      },
    });

    // Evidence outlives a misbehaving consumer of it.
    expect(decode(results[0]?.output ?? new Uint8Array())).toBe("output");
    expect(results[0]?.exitCode).toBe(0);
  });

  it("kills a step that outlives its timeout", async () => {
    const { calls, spawn } = fakeSpawn(() => {});

    const results = await runVerificationSteps({
      steps: [step("slow", "sleep 600"), step("after", "true")],
      cwd: CWD,
      timeoutMs: 20,
      spawn,
    });

    expect(results[0]?.timedOut).toBe(true);
    expect(results[0]?.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(calls[0]?.child.signals).toEqual(["SIGKILL"]);
    // The step after a timeout still runs.
    expect(results[1]?.timedOut).toBe(true);
    expect(results).toHaveLength(2);
  });

  describe("a process that will not die", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is recorded anyway, rather than stalling the run", async () => {
      vi.useFakeTimers();
      const { calls, spawn } = fakeSpawn((child) => {
        child.dieOnKill = false;
      });

      const pending = runVerificationSteps({
        steps: [step("zombie", "sleep 600")],
        cwd: CWD,
        timeoutMs: 100,
        spawn,
      });
      // Past the step timeout, then past the grace the kill is given.
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await pending;

      expect(calls[0]?.child.signals).toEqual(["SIGKILL"]);
      expect(results[0]?.timedOut).toBe(true);
      expect(results[0]?.exitCode).toBe(TIMEOUT_EXIT_CODE);
      expect(decode(results[0]?.output ?? new Uint8Array())).toContain("exceeded 100ms");
    });
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
      timeoutMs: 15_000,
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
      timeoutMs: 15_000,
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
      timeoutMs: 15_000,
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
        timeoutMs: 15_000,
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
        step("hang", nodeCommand("setInterval(function () {}, 50)")),
        step("after", nodeCommand("process.stdout.write('still ran')")),
      ],
      cwd: CWD,
      timeoutMs: 500,
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
      steps: [step("tree", `${nodeCommand("setInterval(function () {}, 50)")} | cat`)],
      cwd: CWD,
      timeoutMs: 500,
    });

    expect(results[0]?.timedOut).toBe(true);
    expect(results[0]?.exitCode).toBe(TIMEOUT_EXIT_CODE);
    // And the tree really died on the signal: had the grandchildren survived,
    // the step would have been recorded by the two-second grace timer instead,
    // so anything under that proves `close` arrived because the tree went away.
    expect(results[0]?.durationMs).toBeLessThan(1_500);
  });

  it("runs a command containing quotes through sh -c (POSIX)", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip("POSIX-only: this leg asserts sh quoting; the cmd.exe leg runs on Windows");
      return;
    }

    const results = await runVerificationSteps({
      steps: [step("quoted", `printf %s 'say "hi"'`)],
      cwd: CWD,
      timeoutMs: 15_000,
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
      timeoutMs: 15_000,
    });

    expect(results[0]?.exitCode).toBe(0);
    expect(decode(results[0]?.output ?? new Uint8Array()).trim()).toBe('say "hi"');
  });
});
