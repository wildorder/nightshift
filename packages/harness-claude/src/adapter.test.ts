/**
 * The adapter, driven entirely by fakes.
 *
 * No `claude` process is spawned anywhere in this file and none of it touches
 * the filesystem: the spawn, the filesystem and the process-group kill are all
 * injected. That is the point of D-P3-11 — `npm test` must stay runnable with no
 * Claude Code sign-in, no credentials and no network — and it is also what lets
 * the exit matrix be exhaustive rather than illustrative.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionNode, RouteTarget, Scope } from "@nightshift/contracts";
import {
  createFixtures,
  createSteppingClock,
  makeAgent,
  makeJobContract,
  makeProgramContract,
  makeRootNode,
} from "@nightshift/core";
import type { HarnessExit, HarnessStartInput, HookEvent, McpLaunch } from "@nightshift/harness";
import { millis, refusingWorkerTools } from "@nightshift/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeHarness, SPAWN_FAILURE_EXIT_CODE } from "./adapter.js";
import { HEADLESS_CLAUDE_ENV } from "./environment.js";
import type { AdapterFileSystem, SpawnedChild, SpawnLike, SpawnOptions } from "./process.js";
import { IDLE_GRACE_MS } from "./session.js";

/** What the recording's `result` frame says the run cost (contract v1, D-P5-01). */
const RECORDED_USAGE = {
  inputTokens: 10,
  outputTokens: 900,
  cacheReadTokens: 71406,
  cacheWriteTokens: 18486,
  actualCostUsd: 0.1266714,
  latencyMs: 24172,
};

/** The recording's own session, which every exit now carries (P8, D-P8-15). */
const RECORDED_SESSION = "9cb83dd4-77b4-4d5d-91f4-b44452cfeb3a";

/** The recording's final message, which a completed exit now carries (P8, an answerer's answers). */
const RECORDED_RESULT =
  "Done. Added `farewell` to greet.js, confirmed README.md's first line is `# sample`, and reported progress/completion to nightshift.";

const RECORDING = readFileSync(
  new URL("./__fixtures__/claude-stream-success.jsonl", import.meta.url),
  "utf8",
);

const encoder = new TextEncoder();

// ── fakes ───────────────────────────────────────────────────────────────────

/** A child process with hand-operated pipes and exit. */
class FakeChild implements SpawnedChild {
  readonly pid: number | undefined = 4242;
  readonly signals: NodeJS.Signals[] = [];
  private readonly stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly stderrListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly closeListeners: ((code: number | null, signal: string | null) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private closed = false;

  /** What the adapter wrote to stdin, and whether it closed it. */
  readonly written: string[] = [];
  stdinEnded = false;
  readonly stdin = {
    write: (data: string) => this.written.push(data),
    end: () => {
      this.stdinEnded = true;
    },
    on: (_: "error", _listener: (error: Error) => void) => undefined,
  };

  readonly stdout = {
    on: (_: "data", l: (chunk: Uint8Array) => void) => this.stdoutListeners.push(l),
  };
  readonly stderr = {
    on: (_: "data", l: (chunk: Uint8Array) => void) => this.stderrListeners.push(l),
  };

  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close" | "error", listener: never): void {
    if (event === "close") this.closeListeners.push(listener);
    else this.errorListeners.push(listener);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push((signal ?? "SIGTERM") as NodeJS.Signals);
    return true;
  }

  emitStdout(text: string): void {
    for (const listener of this.stdoutListeners) listener(encoder.encode(text));
  }

  emitStderr(text: string): void {
    for (const listener of this.stderrListeners) listener(encoder.encode(text));
  }

  emitError(message: string): void {
    for (const listener of this.errorListeners) listener(new Error(message));
  }

  close(code: number | null, signal: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(code, signal);
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

const fakeSpawn = () => {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnLike = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
};

/**
 * The temporary directory the fake hands out, and the two files inside it.
 *
 * Built with `join`, not written as literals: the adapter joins them with
 * `node:path`, so on Windows the paths it produces use `\` and a literal
 * `"/fake-tmp/…/mcp.json"` would be asserting against a separator this
 * platform never emits. Found by CI, on the windows leg.
 */
const TEMP_DIR = "/fake-tmp/nightshift-claude-1";
const MCP_CONFIG_PATH = join(TEMP_DIR, "mcp.json");
const SETTINGS_PATH = join(TEMP_DIR, "settings.json");

const fakeFileSystem = () => {
  const written = new Map<string, string>();
  const transcripts = new Map<string, string>();
  const removed: string[] = [];
  const opened: string[] = [];
  const fs: AdapterFileSystem = {
    makeTempDir: (prefix) => `/fake-tmp/${prefix}1`,
    writeConfigFile: (path, contents) => void written.set(path, contents),
    openTranscript: (path) => {
      opened.push(path);
      transcripts.set(path, "");
      return {
        write: (chunk) =>
          void transcripts.set(
            path,
            `${transcripts.get(path) ?? ""}${new TextDecoder().decode(chunk)}`,
          ),
        close: () => {},
      };
    },
    removeDir: (path) => void removed.push(path),
  };
  return { fs, written, transcripts, removed, opened };
};

// ── inputs ──────────────────────────────────────────────────────────────────

const MCP: McpLaunch = {
  name: "nightshift",
  command: "/usr/local/bin/nightshift-mcp",
  args: ["--stdio"],
  env: { NIGHTSHIFT_ROLE: "worker", NIGHTSHIFT_AGENT_ID: "agent_from_launch" },
};

const MODEL: RouteTarget = { harness: "claude", provider: "anthropic", model: "claude-sonnet-5" };

const startInput = (
  overrides: {
    readonly permissions?: readonly string[];
    readonly transcriptPath?: string;
    readonly events?: HookEvent[];
  } = {},
): HarnessStartInput => {
  const fixtures = createFixtures();
  const node: ExecutionNode = makeRootNode(fixtures, {
    scope: {
      includes: ["src/**"],
      excludes: [],
      permissions: [...(overrides.permissions ?? ["fs.read", "fs.write"])],
      forbiddenActions: ["deploy"],
    } satisfies Scope,
  });
  const events = overrides.events ?? [];
  return {
    agent: makeAgent(fixtures, node.executionNodeId),
    node,
    job: makeJobContract(fixtures),
    program: makeProgramContract(fixtures),
    worktree: "/state/nightshift/worktrees/run_1/node_1",
    model: MODEL,
    mcp: MCP,
    tools: refusingWorkerTools("the adapter's unit tests start no real job"),
    sink: { emit: (event) => void events.push(event) },
    ...(overrides.transcriptPath === undefined ? {} : { transcriptPath: overrides.transcriptPath }),
  };
};

const harnessWith = (
  spawn: SpawnLike,
  fs: AdapterFileSystem,
  extra: {
    readonly platform?: NodeJS.Platform;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
) =>
  createClaudeHarness({
    spawn,
    fs,
    clock: createSteppingClock(Date.UTC(2026, 8, 15, 12, 0, 0), 1),
    platform: extra.platform ?? "darwin",
    env: { PATH: "/usr/bin", HOME: "/home/operator", NIGHTSHIFT_ROLE: "orchestrator" },
    ...(extra.kill === undefined ? {} : { kill: extra.kill }),
  });

const endings = (events: readonly HookEvent[]): readonly HookEvent[] =>
  events.filter((event) =>
    ["agent.completed", "agent.failed", "agent.cancelled", "agent.interrupted"].includes(
      event.type,
    ),
  );

afterEach(() => {
  vi.useRealTimers();
});

// ── the launch ──────────────────────────────────────────────────────────────

describe("the launch, against a fake spawn", () => {
  it("runs `claude` in the worktree with the documented command line", async () => {
    const { spawn, calls } = fakeSpawn();
    const { fs } = fakeFileSystem();
    await harnessWith(spawn, fs).start(startInput({ permissions: ["fs.read"] }));

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.file).toBe("claude");
    expect(call?.options.cwd).toBe("/state/nightshift/worktrees/run_1/node_1");
    expect(call?.args.slice(0, 3)).toEqual(["-p", "--input-format", "stream-json"]);
    expect(call?.args.slice(3)).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-sonnet-5",
      "--mcp-config",
      MCP_CONFIG_PATH,
      "--strict-mcp-config",
      "--settings",
      SETTINGS_PATH,
      "--setting-sources",
      "",
      "--permission-mode",
      "bypassPermissions",
      "--disallowedTools",
      expect.stringContaining("Bash(git push:*)"),
    ]);
  });

  it("writes the brief to stdin as one user message, carrying both halves of it", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    await harnessWith(spawn, fs).start(startInput());

    const written = children[0]?.written ?? [];
    expect(written).toHaveLength(1);
    const message = JSON.parse(written[0] ?? "{}") as { message: { content: string } };
    const prompt = message.message.content;
    // T1's half.
    expect(prompt).toContain("You are a Nightshift worker.");
    expect(prompt).toContain("HOW YOUR WORK IS COLLECTED — do not commit");
    // This adapter's half, and in that order.
    expect(prompt).toContain("mcp__nightshift__job_complete");
    expect(prompt.indexOf("You are a Nightshift worker.")).toBeLessThan(
      prompt.indexOf("mcp__nightshift__job_complete"),
    );
  });

  it("hands the child a sanitized environment, with none of the parent's identity", async () => {
    const { spawn, calls } = fakeSpawn();
    const { fs } = fakeFileSystem();
    await harnessWith(spawn, fs).start(startInput());

    expect(calls[0]?.options.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      // A headless session cannot be woken by a background task, so it has none.
      ...HEADLESS_CLAUDE_ENV,
    });
    expect(calls[0]?.options.env.NIGHTSHIFT_ROLE).toBeUndefined();
  });

  it("gives the identity to the MCP server's own process instead, unchanged", async () => {
    const { spawn } = fakeSpawn();
    const files = fakeFileSystem();
    await harnessWith(spawn, files.fs).start(startInput());

    const config = JSON.parse(files.written.get(MCP_CONFIG_PATH) ?? "{}");
    expect(config.mcpServers.nightshift.env).toEqual(MCP.env);
  });

  it("keeps stdin open while the session works, and closes it once the session is done", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, calls, children } = fakeSpawn();
      const { fs } = fakeFileSystem();
      await harnessWith(spawn, fs).start(startInput());
      expect(calls[0]?.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
      const child = children[0] as FakeChild;
      const frame = (value: unknown) => child.emitStdout(`${JSON.stringify(value)}\n`);

      // A turn that started a background command, then went idle: still open.
      frame({ type: "system", subtype: "session_state_changed", state: "running" });
      frame({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1" }] });
      frame({ type: "system", subtype: "session_state_changed", state: "idle" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.stdinEnded).toBe(false);

      // The command finished and the woken turn started at once: still open.
      frame({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      frame({ type: "system", subtype: "session_state_changed", state: "running" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.stdinEnded).toBe(false);

      // Idle with nothing left: closed after the grace.
      frame({ type: "system", subtype: "session_state_changed", state: "idle" });
      await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS + 1);
      expect(child.stdinEnded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a finished session even with something still running in the background", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, children } = fakeSpawn();
      const { fs } = fakeFileSystem();
      await harnessWith(spawn, fs).start(startInput());
      const child = children[0] as FakeChild;
      const frame = (value: unknown) => child.emitStdout(`${JSON.stringify(value)}\n`);
      frame({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "dev" }] });
      frame({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "mcp__nightshift__job_complete", input: {} },
          ],
        },
      });
      frame({ type: "system", subtype: "session_state_changed", state: "idle" });
      await vi.advanceTimersByTimeAsync(IDLE_GRACE_MS + 1);
      expect(child.stdinEnded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches on POSIX so cancel can signal the tree, and not on Windows", async () => {
    const posix = fakeSpawn();
    const windows = fakeSpawn();
    await harnessWith(posix.spawn, fakeFileSystem().fs).start(startInput());
    await harnessWith(windows.spawn, fakeFileSystem().fs, { platform: "win32" }).start(
      startInput(),
    );
    expect(posix.calls[0]?.options.detached).toBe(true);
    expect(windows.calls[0]?.options.detached).toBe(false);
  });

  it("carries the identity it was given on the handle, and the pid it was told", async () => {
    const { spawn } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const input = startInput();
    const handle = await harnessWith(spawn, fs).start(input);
    expect(handle.agentId).toBe(input.agent.agentId);
    expect(handle.pid).toBe(4242);
  });

  it("writes both configuration files before the child starts, and removes them after", async () => {
    const { spawn, children } = fakeSpawn();
    const files = fakeFileSystem();
    const handle = await harnessWith(spawn, files.fs).start(startInput());
    expect([...files.written.keys()]).toEqual([MCP_CONFIG_PATH, SETTINGS_PATH]);
    children[0]?.close(0);
    await handle.exit;
    expect(files.removed).toEqual([TEMP_DIR]);
  });
});

// ── the transcript ──────────────────────────────────────────────────────────

describe("the transcript", () => {
  it("is written as the stream arrives and named on the handle", async () => {
    const { spawn, children } = fakeSpawn();
    const files = fakeFileSystem();
    const path = "/state/nightshift/runs/run_1/agents/agent_1/transcript.jsonl";
    const handle = await harnessWith(spawn, files.fs).start(startInput({ transcriptPath: path }));

    expect(handle.transcript).toBe(path);
    const half = Math.floor(RECORDING.length / 2);
    children[0]?.emitStdout(RECORDING.slice(0, half));
    // Written before the process ends: a crashed run still leaves evidence.
    expect(files.transcripts.get(path)).toBe(RECORDING.slice(0, half));
    children[0]?.emitStdout(RECORDING.slice(half));
    children[0]?.close(0);
    await handle.exit;
    expect(files.transcripts.get(path)).toBe(RECORDING);
  });

  it("is absent from the handle when no path was asked for", async () => {
    const { spawn } = fakeSpawn();
    const files = fakeFileSystem();
    const handle = await harnessWith(spawn, files.fs).start(startInput());
    expect(handle.transcript).toBeUndefined();
    expect(files.opened).toEqual([]);
  });

  it("does not fail the job when it cannot be opened", async () => {
    const { spawn, children } = fakeSpawn();
    const files = fakeFileSystem();
    const failing: AdapterFileSystem = {
      ...files.fs,
      openTranscript: () => {
        throw new Error("EROFS: read-only file system");
      },
    };
    const events: HookEvent[] = [];
    const handle = await harnessWith(spawn, failing).start(
      startInput({ transcriptPath: "/nope/transcript.jsonl", events }),
    );
    expect(handle.transcript).toBeUndefined();
    children[0]?.emitStdout(RECORDING);
    children[0]?.close(0);
    expect(await handle.exit).toEqual({
      kind: "completed",
      usage: RECORDED_USAGE,
      sessionId: RECORDED_SESSION,
      result: RECORDED_RESULT,
    });
    // Exactly one start, and the reason is on the ending rather than lost.
    expect(events.filter((event) => event.type === "agent.started")).toHaveLength(1);
    expect(endings(events)[0]?.payload.transcriptError).toContain("EROFS");
  });
});

// ── the exit mapping ────────────────────────────────────────────────────────

describe("the exit mapping", () => {
  const run = async (
    act: (child: FakeChild) => void,
    options: { readonly platform?: NodeJS.Platform } = {},
  ): Promise<{ readonly exit: HarnessExit; readonly events: readonly HookEvent[] }> => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const events: HookEvent[] = [];
    const harness = harnessWith(spawn, fs, options);
    const handle = await harness.start(startInput({ events }));
    const child = children[0];
    if (child === undefined) throw new Error("no child was spawned");
    act(child);
    const exit = await handle.exit;
    expect(await harness.status(handle)).toBe(
      exit.kind === "completed"
        ? "completed"
        : exit.kind === "failed"
          ? "failed"
          : exit.kind === "interrupted"
            ? "interrupted"
            : "cancelled",
    );
    return { exit, events };
  };

  it("maps exit 0 with a non-error result to completed", async () => {
    const { exit } = await run((child) => {
      child.emitStdout(RECORDING);
      child.close(0);
    });
    expect(exit).toEqual({
      kind: "completed",
      usage: RECORDED_USAGE,
      sessionId: RECORDED_SESSION,
      result: RECORDED_RESULT,
    });
  });

  it("maps a stream that ends without a result to failed, even on exit 0", async () => {
    const { exit } = await run((child) => {
      child.emitStdout(RECORDING.split("\n").slice(0, 6).join("\n"));
      child.close(0);
    });
    expect(exit).toEqual({ kind: "failed", exitCode: 0, sessionId: RECORDED_SESSION });
  });

  it("maps exit 0 with an error result to failed — the interrupted-run case", async () => {
    // Measured on 2.1.273: a SIGINT during a `-p` run exits 0 and prints this.
    const { exit, events } = await run((child) => {
      child.emitStdout(
        `${JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        })}\n`,
      );
      child.close(0);
    });
    expect(exit).toEqual({ kind: "failed", exitCode: 0 });
    expect(endings(events)[0]?.payload.terminalReason).toBe("aborted_streaming");
  });

  it("maps a non-zero exit to failed, carrying the code", async () => {
    const { exit, events } = await run((child) => {
      child.emitStderr("Error: When using --print, --output-format=stream-json requires --verbose");
      child.close(1);
    });
    expect(exit).toEqual({ kind: "failed", exitCode: 1 });
    expect(endings(events)[0]?.payload.summary).toContain("requires --verbose");
  });

  it("maps a killing signal to interrupted, carrying the signal", async () => {
    const { exit } = await run((child) => child.close(null, "SIGKILL"));
    expect(exit).toEqual({ kind: "interrupted", signal: "SIGKILL" });
  });

  it("maps a close with neither a code nor a signal to failed", async () => {
    const { exit } = await run((child) => child.close(null, null));
    expect(exit).toEqual({ kind: "failed", exitCode: 1 });
  });

  it("maps an externally killed process on Windows to failed, because there is no signal", async () => {
    // Documented in `adapter.ts`: Windows reports no signal, and `taskkill` sets
    // exit code 1. SC-P3-11 wants durable state, not the label.
    const { exit } = await run((child) => child.close(1, null), { platform: "win32" });
    expect(exit).toEqual({ kind: "failed", exitCode: 1 });
  });

  it("maps a child that never ran to failed rather than a rejection", async () => {
    const { exit, events } = await run((child) => child.emitError("spawn claude ENOENT"));
    expect(exit).toEqual({ kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE });
    expect(endings(events)[0]?.payload.summary).toContain("ENOENT");
  });
});

describe("exit settles exactly once", () => {
  it("keeps the first outcome when the process closes twice", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const events: HookEvent[] = [];
    const handle = await harnessWith(spawn, fs).start(startInput({ events }));
    children[0]?.close(3);
    // A second close cannot happen on a real child, but a second *settle* can if
    // an error and a close race. Both paths go through the same guard.
    children[0]?.emitError("late error");
    const first = await handle.exit;
    expect(await handle.exit).toEqual(first);
    expect(first).toEqual({ kind: "failed", exitCode: 3 });
    expect(endings(events)).toHaveLength(1);
  });

  it("never rejects, even when the configuration cannot be written", async () => {
    const { spawn, calls } = fakeSpawn();
    const files = fakeFileSystem();
    const events: HookEvent[] = [];
    const broken: AdapterFileSystem = {
      ...files.fs,
      writeConfigFile: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    };
    const handle = await harnessWith(spawn, broken).start(startInput({ events }));
    expect(await handle.exit).toEqual({ kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE });
    expect(calls).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.failed"]);
    expect(endings(events)[0]?.payload.summary).toContain("ENOSPC");
  });

  it("never rejects when the spawn itself throws", async () => {
    const throwing: SpawnLike = () => {
      throw new Error("EACCES: permission denied");
    };
    const { fs } = fakeFileSystem();
    const events: HookEvent[] = [];
    const handle = await harnessWith(throwing, fs).start(startInput({ events }));
    expect(await handle.exit).toEqual({ kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE });
    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.failed"]);
  });
});

// ── D-P3-09 ─────────────────────────────────────────────────────────────────

describe("the hook channel without the worker's cooperation (D-P3-09)", () => {
  it("reports a start and one ending for a run that called no tool and exited non-zero", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const events: HookEvent[] = [];
    const handle = await harnessWith(spawn, fs).start(startInput({ events }));
    // Not one byte of stdout: no init frame, no result, no tool call.
    children[0]?.close(42);
    await handle.exit;

    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.failed"]);
    expect(events[1]?.payload.exitCode).toBe(42);
    expect(events[1]?.payload.sawResult).toBe(false);
  });

  it("emits the start before the ending, always", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const events: HookEvent[] = [];
    const handle = await harnessWith(spawn, fs).start(startInput({ events }));
    children[0]?.close(0);
    await handle.exit;
    expect(events[0]?.type).toBe("agent.started");
    expect(endings(events)).toHaveLength(1);
  });

  it("emits exactly one start when the stream did print an init frame", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const events: HookEvent[] = [];
    const handle = await harnessWith(spawn, fs).start(startInput({ events }));
    children[0]?.emitStdout(RECORDING);
    children[0]?.close(0);
    await handle.exit;
    expect(events.filter((event) => event.type === "agent.started")).toHaveLength(1);
    expect(events[0]?.payload.sessionId).toBe("9cb83dd4-77b4-4d5d-91f4-b44452cfeb3a");
  });

  it("attributes every event to the agent it was given", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const events: HookEvent[] = [];
    const input = startInput({ events });
    const handle = await harnessWith(spawn, fs).start(input);
    children[0]?.emitStdout(RECORDING);
    children[0]?.close(0);
    await handle.exit;
    for (const event of events) expect(event.payload.agentId).toBe(input.agent.agentId);
  });
});

// ── cancel ──────────────────────────────────────────────────────────────────

describe("cancel escalation", () => {
  const cancellable = async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const events: HookEvent[] = [];
    const killed: { pid: number; signal: NodeJS.Signals }[] = [];
    const harness = harnessWith(spawn, fs, {
      kill: (pid, signal) => void killed.push({ pid, signal }),
    });
    const handle = await harness.start(startInput({ events }));
    const child = children[0];
    if (child === undefined) throw new Error("no child was spawned");
    return { harness, handle, child, events, killed };
  };

  it("sends SIGINT first, SIGTERM at half the grace, and SIGKILL when it is up", async () => {
    vi.useFakeTimers();
    const { harness, handle, child, killed } = await cancellable();

    const cancelling = harness.cancel(handle, millis(4_000));
    // The cooperative stop, immediately, to the whole process group.
    expect(killed).toEqual([{ pid: -4242, signal: "SIGINT" }]);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(killed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(killed[1]).toEqual({ pid: -4242, signal: "SIGTERM" });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(killed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(killed[2]).toEqual({ pid: -4242, signal: "SIGKILL" });

    child.close(null, "SIGKILL");
    await cancelling;
    expect(await handle.exit).toEqual({ kind: "cancelled" });
  });

  it("stops escalating once the process has gone", async () => {
    vi.useFakeTimers();
    const { harness, handle, child, killed } = await cancellable();
    const cancelling = harness.cancel(handle, millis(4_000));
    child.close(0);
    await cancelling;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(killed).toEqual([{ pid: -4242, signal: "SIGINT" }]);
  });

  it("settles as cancelled whatever the process reported on the way out", async () => {
    for (const [code, signal] of [
      [0, null],
      [1, null],
      [null, "SIGTERM"],
      [null, "SIGKILL"],
    ] as const) {
      const { harness, handle, child, events } = await cancellable();
      const cancelling = harness.cancel(handle, millis(10));
      child.close(code, signal);
      await cancelling;
      expect(await handle.exit).toEqual({ kind: "cancelled" });
      expect(endings(events).map((event) => event.type)).toEqual(["agent.cancelled"]);
      expect(await harness.status(handle)).toBe("cancelled");
    }
  });

  it("resolves only once exit has settled", async () => {
    const { harness, handle, child } = await cancellable();
    let settled = false;
    const cancelling = harness.cancel(handle, millis(50)).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    child.close(null, "SIGINT");
    await cancelling;
    expect(settled).toBe(true);
  });

  it("is a no-op on a handle that has already settled", async () => {
    const { harness, handle, child, killed } = await cancellable();
    child.close(0);
    await handle.exit;
    await expect(harness.cancel(handle, millis(1_000))).resolves.toBeUndefined();
    expect(killed).toEqual([]);
    // The outcome it already had is kept.
    expect(await handle.exit).toEqual({ kind: "failed", exitCode: 0 });
  });

  it("treats a second cancel as waiting for the first, not a second escalation", async () => {
    const { harness, handle, child, killed } = await cancellable();
    const first = harness.cancel(handle, millis(20));
    const second = harness.cancel(handle, millis(20));
    child.close(null, "SIGINT");
    await Promise.all([first, second]);
    expect(killed.filter((k) => k.signal === "SIGINT")).toHaveLength(1);
  });

  it("goes straight to a tree kill on Windows, where no cooperative stop exists", async () => {
    const { spawn, children, calls } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const harness = harnessWith(spawn, fs, { platform: "win32" });
    const handle = await harness.start(startInput());
    const cancelling = harness.cancel(handle, millis(4_000));
    // `taskkill /pid <pid> /T /F`, spawned rather than signalled.
    expect(calls[1]?.file).toBe("taskkill");
    expect(calls[1]?.args).toEqual(["/pid", "4242", "/T", "/F"]);
    children[0]?.close(1, null);
    await cancelling;
    expect(await handle.exit).toEqual({ kind: "cancelled" });
  });

  it("falls back to signalling the child when the group kill throws", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const harness = harnessWith(spawn, fs, {
      kill: () => {
        throw new Error("ESRCH");
      },
    });
    const handle = await harness.start(startInput());
    const cancelling = harness.cancel(handle, millis(10));
    expect(children[0]?.signals).toEqual(["SIGINT"]);
    children[0]?.close(null, "SIGINT");
    await cancelling;
    expect(await handle.exit).toEqual({ kind: "cancelled" });
  });
});

describe("status", () => {
  it("reports started while the worker runs", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const harness = harnessWith(spawn, fs);
    const handle = await harness.start(startInput());
    expect(await harness.status(handle)).toBe("started");
    children[0]?.close(0);
    await handle.exit;
    expect(await harness.status(handle)).toBe("failed");
  });

  it("keeps reporting the terminal status, however often it is asked", async () => {
    const { spawn, children } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const harness = harnessWith(spawn, fs);
    const handle = await harness.start(startInput());
    children[0]?.emitStdout(RECORDING);
    children[0]?.close(0);
    await handle.exit;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await harness.status(handle)).toBe("completed");
    }
  });

  it("says created for a handle it did not start", async () => {
    const { spawn } = fakeSpawn();
    const { fs } = fakeFileSystem();
    const harness = harnessWith(spawn, fs);
    const foreign = { agentId: "agent_x", exit: Promise.resolve({ kind: "completed" } as const) };
    expect(await harness.status(foreign as never)).toBe("created");
  });
});

describe("the adapter's identity", () => {
  it("is `claude`, matching RouteTarget.harness", () => {
    expect(createClaudeHarness().id).toBe("claude");
  });
});
