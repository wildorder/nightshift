/**
 * The Codex adapter against a fake process (T3 deliverable 6).
 *
 * No Codex, no network: a hand-operated child, a fake filesystem, and streams
 * taken from real runs on 0.154.0. What is tested is the adapter's own logic —
 * what it launches, what it lets through, and how it names an ending.
 */
import { join } from "node:path";
import type { ExecutionNode, RouteTarget, Scope } from "@nightshift/contracts";
import {
  createFixtures,
  makeAgent,
  makeJobContract,
  makeProgramContract,
  makeRootNode,
} from "@nightshift/core";
import type { HarnessStartInput, HookEvent, McpLaunch } from "@nightshift/harness";
import { millis, refusingWorkerTools } from "@nightshift/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexHarness, SPAWN_FAILURE_EXIT_CODE } from "./adapter.js";
import type { AdapterFileSystem, SpawnedChild, SpawnLike, SpawnOptions } from "./process.js";

const encoder = new TextEncoder();
const lines = (...frames: readonly unknown[]): string =>
  frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");

/** As recorded: a turn that ended cleanly, with Codex's own token counts. */
const CLEAN_RUN = lines(
  { type: "thread.started", thread_id: "01a0b9e2-a874-71d2-8293-67ec5bcf67fb" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "READY" } },
  {
    type: "turn.completed",
    usage: { input_tokens: 14028, cached_input_tokens: 11520, output_tokens: 5 },
  },
);

/** As recorded: what a SIGTERMed `codex exec` had printed when it exited 0. */
const ABANDONED_RUN = lines(
  { type: "thread.started", thread_id: "01a0b9e4-33f5-73d3-b75f-278e14dec33d" },
  { type: "turn.started" },
);

class FakeChild implements SpawnedChild {
  readonly pid: number | undefined = 4242;
  readonly signals: NodeJS.Signals[] = [];
  private readonly out: ((chunk: Uint8Array) => void)[] = [];
  private readonly err: ((chunk: Uint8Array) => void)[] = [];
  private readonly closers: ((code: number | null, signal: string | null) => void)[] = [];
  private readonly errors: ((error: Error) => void)[] = [];
  private closed = false;

  readonly stdout = { on: (_: "data", l: (chunk: Uint8Array) => void) => this.out.push(l) };
  readonly stderr = { on: (_: "data", l: (chunk: Uint8Array) => void) => this.err.push(l) };

  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close" | "error", listener: never): void {
    if (event === "close") this.closers.push(listener);
    else this.errors.push(listener);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push((signal ?? "SIGTERM") as NodeJS.Signals);
    return true;
  }

  emitStdout(text: string): void {
    for (const listener of this.out) listener(encoder.encode(text));
  }
  emitStderr(text: string): void {
    for (const listener of this.err) listener(encoder.encode(text));
  }
  emitError(message: string): void {
    for (const listener of this.errors) listener(new Error(message));
  }
  close(code: number | null, signal: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closers) listener(code, signal);
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

const GUARD_DIR = "/fake-tmp/nightshift-codex-1";

const fakes = (overrides: { git?: string | undefined; failWrites?: boolean } = {}) => {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnLike = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const executables = new Map<string, string>();
  const transcripts = new Map<string, string>();
  const removed: string[] = [];
  const fs: AdapterFileSystem = {
    makeTempDir: (prefix) => `/fake-tmp/${prefix}1`,
    writeExecutable: (path, contents) => {
      if (overrides.failWrites === true) throw new Error("EACCES");
      executables.set(path, contents);
    },
    findExecutable: (name) => ("git" in overrides ? overrides.git : `/usr/bin/${name}`),
    openTranscript: (path) => {
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
  return { spawn, fs, calls, children, executables, transcripts, removed };
};

const MCP: McpLaunch = {
  name: "nightshift",
  command: "/usr/local/bin/node",
  args: ["/opt/nightshift-mcp.js"],
  env: { NIGHTSHIFT_ROLE: "worker", NIGHTSHIFT_EXECUTION_TOKEN: "worker-token" },
};
const MODEL: RouteTarget = { harness: "codex", provider: "openai", model: "gpt-5.5" };

const PARENT_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/op",
  CODEX_HOME: "/Users/op/.codex",
  NIGHTSHIFT_API_TOKEN: "the operator's session",
  AWS_PROFILE: "nightshift",
  OPENAI_API_KEY: "sk-operator",
};

const startInput = (
  events: HookEvent[],
  overrides: { permissions?: readonly string[]; transcriptPath?: string } = {},
): HarnessStartInput => {
  const fixtures = createFixtures();
  const node: ExecutionNode = makeRootNode(fixtures, {
    scope: {
      includes: ["src/**"],
      excludes: [],
      permissions: [...(overrides.permissions ?? ["fs.read", "fs.write", "shell.exec"])],
      forbiddenActions: [],
    } satisfies Scope,
  });
  return {
    agent: makeAgent(fixtures, node.executionNodeId),
    node,
    job: makeJobContract(fixtures),
    program: makeProgramContract(fixtures),
    worktree: "/state/wt/run_1/node_1",
    model: MODEL,
    mcp: MCP,
    tools: refusingWorkerTools("the adapter's unit tests start no real job"),
    sink: { emit: (event) => void events.push(event) },
    ...(overrides.transcriptPath === undefined ? {} : { transcriptPath: overrides.transcriptPath }),
  };
};

const run = async (
  drive: (child: FakeChild) => void,
  options: {
    platform?: NodeJS.Platform;
    transcriptPath?: string;
    permissions?: readonly string[];
  } = {},
) => {
  const world = fakes();
  const events: HookEvent[] = [];
  const harness = createCodexHarness({
    spawn: world.spawn,
    fs: world.fs,
    env: PARENT_ENV,
    platform: options.platform ?? "darwin",
  });
  const input = startInput(events, options);
  const handle = await harness.start(input);
  const child = world.children[0];
  if (child !== undefined) drive(child);
  const exit = await handle.exit;
  return { ...world, events, handle, exit, harness, input };
};

const endings = (events: readonly HookEvent[]) =>
  events.filter((event) => event.type !== "agent.started" && event.type.startsWith("agent."));

afterEach(() => {
  vi.useRealTimers();
});

describe("what it launches", () => {
  it("spawns codex exec in the worktree, in its own process group, with stdin ignored", async () => {
    const { calls, input } = await run((child) => child.close(0));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("codex");
    expect(calls[0]?.args.slice(0, 4)).toEqual(["exec", "--json", "-C", input.worktree]);
    expect(calls[0]?.args).toContain("workspace-write");
    expect(calls[0]?.options).toMatchObject({
      cwd: input.worktree,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The brief is the last argument, and it is the shared one plus Codex's own.
    const prompt = calls[0]?.args.at(-1) ?? "";
    expect(prompt).toContain("You are a Nightshift worker");
    expect(prompt).toContain("HOW THE NIGHTSHIFT TOOLS REACH YOU");
  });

  it("maps a scope without fs.write to the read-only sandbox", async () => {
    const { calls } = await run((child) => child.close(0), { permissions: ["fs.read"] });
    expect(calls[0]?.args).toContain("read-only");
    expect(calls[0]?.args).not.toContain("workspace-write");
  });

  it("hands the worker's identity to its MCP server and to nothing else", async () => {
    const { calls } = await run((child) => child.close(0));
    const env = calls[0]?.options.env ?? {};
    expect(env.CODEX_HOME).toBe("/Users/op/.codex");
    expect(Object.keys(env).sort()).toEqual(["CODEX_HOME", "HOME", "PATH"]);
    // The token travels in the MCP server's own environment block.
    expect(JSON.stringify(env)).not.toContain("worker-token");
    expect(calls[0]?.args.join(" ")).toContain('"NIGHTSHIFT_EXECUTION_TOKEN" = "worker-token"');
  });

  it("puts a git guard first on the model's PATH, and never on the process's own", async () => {
    const { calls, executables, removed } = await run((child) => child.close(0));
    // The first real worker: a guard on the process's PATH reaches the worker's
    // MCP server, and refuses Nightshift the `git add` that collects the work.
    expect(calls[0]?.options.env.PATH).toBe("/usr/bin:/bin");
    expect(calls[0]?.args).toContain(
      `shell_environment_policy.set={"PATH" = "${GUARD_DIR}:/usr/bin:/bin"}`,
    );
    const guard = executables.get(join(GUARD_DIR, "git")) ?? "";
    expect(guard).toContain("exec '/usr/bin/git'");
    expect(guard).toContain("commit");
    expect(removed).toEqual([GUARD_DIR]);
  });

  it("installs no guard on Windows, where a shell script is not a command", async () => {
    const { calls, executables } = await run((child) => child.close(0), { platform: "win32" });
    expect(executables.size).toBe(0);
    expect(calls[0]?.args.join(" ")).not.toContain("shell_environment_policy");
    expect(calls[0]?.options.detached).toBe(false);
  });

  it("writes the raw stream to the transcript as it arrives", async () => {
    const path = "/state/runs/r/agents/a/transcript.jsonl";
    const { transcripts, handle } = await run(
      (child) => {
        child.emitStdout(CLEAN_RUN);
        child.close(0);
      },
      { transcriptPath: path },
    );
    expect(transcripts.get(path)).toBe(CLEAN_RUN);
    expect(handle.transcript).toBe(path);
  });
});

describe("the exit mapping, as measured on 0.154.0", () => {
  it("maps exit 0 with a completed turn to completed, carrying usage", async () => {
    const { exit, harness } = await run((child) => {
      child.emitStdout(CLEAN_RUN);
      child.close(0);
    });
    expect(exit).toEqual({ kind: "completed", usage: { inputTokens: 14028, outputTokens: 5 } });
    expect(harness.capabilities.usage).toBe(true);
  });

  it("maps exit 0 WITHOUT a completed turn to failed — the SIGTERMed-run case", async () => {
    const { exit, events } = await run((child) => {
      child.emitStdout(ABANDONED_RUN);
      child.close(0);
    });
    expect(exit).toEqual({ kind: "failed", exitCode: 0 });
    expect(endings(events)[0]).toMatchObject({
      type: "agent.failed",
      payload: { turnCompleted: false },
    });
  });

  it("maps a failed turn to failed even on exit 0, and says why", async () => {
    const { exit, events } = await run((child) => {
      child.emitStdout(
        lines(
          { type: "thread.started", thread_id: "t" },
          { type: "turn.failed", error: { message: "usage limit reached" } },
        ),
      );
      child.close(0);
    });
    expect(exit).toEqual({ kind: "failed", exitCode: 0 });
    expect(endings(events)[0]?.payload.failure).toBe("usage limit reached");
  });

  it("maps a non-zero exit to failed, carrying the code and the end of stderr", async () => {
    const { exit, events } = await run((child) => {
      child.emitStderr("error: unexpected argument '--nope' found");
      child.close(2);
    });
    expect(exit).toEqual({ kind: "failed", exitCode: 2 });
    expect(endings(events)[0]?.payload.summary).toContain("--nope");
  });

  it("maps a killing signal to interrupted", async () => {
    const { exit } = await run((child) => child.close(null, "SIGKILL"));
    expect(exit).toEqual({ kind: "interrupted", signal: "SIGKILL" });
  });

  it("maps a child that never ran to failed 127, never a rejection", async () => {
    const { exit } = await run((child) => child.emitError("spawn codex ENOENT"));
    expect(exit).toEqual({ kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE });

    const events: HookEvent[] = [];
    const throwing = createCodexHarness({
      spawn: () => {
        throw new Error("spawn codex ENOENT");
      },
      fs: fakes().fs,
      env: PARENT_ENV,
      platform: "darwin",
    });
    const handle = await throwing.start(startInput(events));
    expect(await handle.exit).toEqual({ kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE });
    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.failed"]);
  });

  it("fails the launch, durably, when the guard cannot be written", async () => {
    const world = fakes({ failWrites: true });
    const events: HookEvent[] = [];
    const harness = createCodexHarness({ ...world, env: PARENT_ENV, platform: "darwin" });
    const handle = await harness.start(startInput(events));
    expect(await handle.exit).toEqual({ kind: "failed", exitCode: SPAWN_FAILURE_EXIT_CODE });
    expect(world.calls).toHaveLength(0);
    expect(endings(events)[0]?.payload.summary).toContain("git guard");
  });
});

describe("the lifecycle, without the worker's help (D-P3-09)", () => {
  it("emits one start and one ending for a worker that printed nothing at all", async () => {
    const { events } = await run((child) => child.close(1));
    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.failed"]);
  });

  it("emits the start from thread.started, once, with Codex's own session id", async () => {
    const { events } = await run((child) => {
      child.emitStdout(CLEAN_RUN);
      child.close(0);
    });
    const started = events.filter((event) => event.type === "agent.started");
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toMatchObject({
      harness: "codex",
      sessionId: "01a0b9e2-a874-71d2-8293-67ec5bcf67fb",
    });
    expect(endings(events).map((event) => event.type)).toEqual(["agent.completed"]);
  });

  it("answers status from the same mapping as exit", async () => {
    const { harness, handle } = await run((child) => child.close(null, "SIGKILL"));
    expect(await harness.status(handle)).toBe("interrupted");
  });
});

describe("cancel (D-P5-02)", () => {
  it("escalates SIGINT, SIGTERM at half the grace, SIGKILL at the grace — on the group", async () => {
    vi.useFakeTimers();
    const world = fakes();
    const kills: [number, NodeJS.Signals][] = [];
    const harness = createCodexHarness({
      spawn: world.spawn,
      fs: world.fs,
      env: PARENT_ENV,
      platform: "linux",
      kill: (pid, signal) => void kills.push([pid, signal]),
    });
    const events: HookEvent[] = [];
    const handle = await harness.start(startInput(events));
    const cancelling = harness.cancel(handle, millis(10_000));

    expect(kills).toEqual([[-4242, "SIGINT"]]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kills.at(-1)).toEqual([-4242, "SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kills.at(-1)).toEqual([-4242, "SIGKILL"]);

    world.children[0]?.close(null, "SIGKILL");
    await cancelling;
    // A cancel in flight wins over how the process happened to die.
    expect(await handle.exit).toEqual({ kind: "cancelled" });
    expect(endings(events).map((event) => event.type)).toEqual(["agent.cancelled"]);
    expect(await harness.status(handle)).toBe("cancelled");
  });

  it("is cancelled even though a SIGINTed codex exits 1, and stops escalating once it has gone", async () => {
    vi.useFakeTimers();
    const world = fakes();
    const kills: NodeJS.Signals[] = [];
    const harness = createCodexHarness({
      spawn: world.spawn,
      fs: world.fs,
      env: PARENT_ENV,
      platform: "darwin",
      kill: (_pid, signal) => void kills.push(signal),
    });
    const handle = await harness.start(startInput([]));
    const cancelling = harness.cancel(handle, millis(10_000));
    world.children[0]?.close(1);
    await cancelling;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await handle.exit).toEqual({ kind: "cancelled" });
    expect(kills).toEqual(["SIGINT"]);
    // A second cancel, and a cancel of a settled handle, are no-ops.
    await harness.cancel(handle, millis(1));
    expect(kills).toEqual(["SIGINT"]);
  });
});
