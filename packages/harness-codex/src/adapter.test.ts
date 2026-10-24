/**
 * The Codex adapter against a fake process (T3 deliverable 6).
 *
 * No Codex, no network: a hand-operated child, a fake filesystem, and streams
 * taken from real runs on 0.154.0. What is tested is the adapter's own logic —
 * what it launches, what it lets through, and how it names an ending.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionNode, MeasurementObservation, RouteTarget } from "@nightshift/contracts";
import { MeasurementObservationSchema } from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  makeAgent,
  makeJobContract,
  makeProgramContract,
  makeRootNode,
  reconcileSegment,
} from "@nightshift/core";
import type {
  HarnessObservation,
  HarnessStartInput,
  HookEvent,
  LocalReceiverOptions,
  McpLaunch,
  RunAs,
} from "@nightshift/harness";
import { millis, recordingMeasurementSink, refusingWorkerTools } from "@nightshift/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexHarness, SPAWN_FAILURE_EXIT_CODE } from "./adapter.js";
import type { AdapterFileSystem, SpawnedChild, SpawnLike, SpawnOptions } from "./process.js";
import { MAX_HOOK_PAYLOAD_BYTES } from "./stream.js";

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

  /** What the adapter wrote to stdin, and whether it closed it. */
  brief: string | undefined;
  stdinEnded = false;
  readonly stdin = {
    end: (data: string) => {
      this.brief = data;
      this.stdinEnded = true;
    },
    on: (_: "error", _listener: (error: Error) => void) => undefined,
  };
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

/** Successive contents a rollout read returns (the last repeats); an Error rejects. */
type RolloutServing = Readonly<Record<string, readonly (string | Error)[]>>;

const fakes = (
  overrides: {
    git?: string | undefined;
    failWrites?: boolean;
    rollouts?: RolloutServing;
    /** Only this Codex home holds the rollouts; others list empty. */
    rolloutHome?: string;
    readdirError?: Error;
  } = {},
) => {
  const listed: string[] = [];
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
  const served = new Map<string, number>();
  const rolloutPath = (id: string): string => `2026/10/20/rollout-2026-10-20T23-53-02-${id}.jsonl`;
  const fs: AdapterFileSystem = {
    // The receiver's directory is real: the fake receiver writes a journal into it.
    makeTempDir: (prefix) =>
      prefix.startsWith("nightshift-codex-otel-")
        ? mkdtempSync(join(tmpdir(), prefix))
        : `/fake-tmp/${prefix}1`,
    readdir: async (path, options) => {
      listed.push(path);
      if (overrides.readdirError !== undefined) throw overrides.readdirError;
      if (overrides.rolloutHome !== undefined && !path.startsWith(`${overrides.rolloutHome}/`)) {
        throw new Error("ENOENT");
      }
      if (!options.recursive || !path.endsWith("/sessions")) throw new Error("ENOENT");
      return Object.keys(overrides.rollouts ?? {}).map(rolloutPath);
    },
    readText: async (path) => {
      const id = Object.keys(overrides.rollouts ?? {}).find((k) => path.endsWith(`-${k}.jsonl`));
      const serving = id === undefined ? undefined : overrides.rollouts?.[id];
      if (id === undefined || serving === undefined) throw new Error("ENOENT");
      const index = Math.min(served.get(id) ?? 0, serving.length - 1);
      served.set(id, index + 1);
      const content = serving[index];
      if (content === undefined || content instanceof Error) throw content ?? new Error("EIO");
      return content;
    },
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
    removeDir: (path) => {
      removed.push(path);
      if (!path.startsWith("/fake-tmp/")) rmSync(path, { recursive: true, force: true });
    },
  };
  return { spawn, fs, calls, children, executables, transcripts, removed, listed };
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
  overrides: { transcriptPath?: string } = {},
): HarnessStartInput => {
  const fixtures = createFixtures();
  const node: ExecutionNode = makeRootNode(fixtures);
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
  it("spawns codex exec in the worktree, in its own process group, with the brief on stdin", async () => {
    const { calls, input, children } = await run((child) => child.close(0));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("codex");
    expect(calls[0]?.args.slice(0, 4)).toEqual(["exec", "--json", "-C", input.worktree]);
    expect(calls[0]?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(calls[0]?.options).toMatchObject({
      cwd: input.worktree,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The brief is on stdin, closed after it, and never an argument: one over
    // 128 KiB is E2BIG (2026-10-13). It is the shared one plus Codex's own.
    expect(calls[0]?.args.at(-1)).toBe("-");
    expect(children[0]?.stdinEnded).toBe(true);
    const prompt = children[0]?.brief ?? "";
    expect(prompt).toContain("You are a Nightshift worker");
    expect(prompt).toContain("HOW THE NIGHTSHIFT TOOLS REACH YOU");
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

  it("gives the agent and its commands the project's declared secrets, and no other variable (A-62)", async () => {
    const world = fakes();
    const events: HookEvent[] = [];
    const harness = createCodexHarness({
      spawn: world.spawn,
      fs: world.fs,
      env: { ...PARENT_ENV, NPM_TOKEN: "ghp_x", OTHER_TOKEN: "y" },
      platform: "darwin",
    });
    const input = startInput(events);
    const handle = await harness.start({
      ...input,
      program: { ...input.program, secrets: ["NPM_TOKEN"] },
    });
    world.children[0]?.close(0);
    await handle.exit;
    const env = world.calls[0]?.options.env ?? {};
    expect(env.NPM_TOKEN).toBe("ghp_x");
    expect(env.OTHER_TOKEN).toBeUndefined();
    expect(world.calls[0]?.args).toContain("shell_environment_policy.ignore_default_excludes=true");
  });

  it("leaves Codex's own excludes on when the program declares no secret", async () => {
    const { calls } = await run((child) => child.close(0));
    expect(calls[0]?.args.join(" ")).not.toContain("ignore_default_excludes");
  });

  it("puts a git guard first on the model's PATH, and never on the process's own", async () => {
    const { calls, executables, removed } = await run((child) => child.close(0));
    // The first real worker: a guard on the process's PATH reaches the worker's
    // MCP server, and refuses Nightshift the `git add` that collects the work.
    expect(calls[0]?.options.env.PATH).toBe("/usr/bin:/bin");
    expect(calls[0]?.args).toContain(
      `shell_environment_policy.set={"PATH" = "${GUARD_DIR}:/usr/bin:/bin"}`,
    );
    const guard = executables.get(`${GUARD_DIR}/git`) ?? "";
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
    expect(exit).toEqual({
      kind: "completed",
      usage: {
        inputTokens: 14028,
        outputTokens: 5,
        cacheReadTokens: 11520,
        inputIncludesCache: true,
      },
      usageScope: "session",
      coverage: "complete",
      sessionId: "01a0b9e2-a874-71d2-8293-67ec5bcf67fb",
      result: "READY",
    });
    expect(harness.capabilities.usage).toBe(true);
  });

  it("maps exit 0 WITHOUT a completed turn to failed — the SIGTERMed-run case", async () => {
    const { exit, events } = await run((child) => {
      child.emitStdout(ABANDONED_RUN);
      child.close(0);
    });
    expect(exit).toEqual({
      kind: "failed",
      exitCode: 0,
      coverage: "unknown",
      sessionId: "01a0b9e4-33f5-73d3-b75f-278e14dec33d",
    });
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
    // P8 (D-P8-06): a usage limit before any work is a route that could not start.
    expect(exit).toEqual({
      kind: "failed",
      exitCode: 0,
      coverage: "unknown",
      sessionId: "t",
      unavailable: "the provider answered 429 before any work began: usage limit reached",
    });
    expect(endings(events)[0]?.payload.failure).toBe("usage limit reached");
  });

  it("maps a non-zero exit to failed, carrying the code and the end of stderr", async () => {
    const { exit, events } = await run((child) => {
      child.emitStderr("error: unexpected argument '--nope' found");
      child.close(2);
    });
    expect(exit).toEqual({ kind: "failed", exitCode: 2, coverage: "unknown" });
    expect(endings(events)[0]?.payload.summary).toContain("--nope");
  });

  it("maps a killing signal to interrupted", async () => {
    const { exit } = await run((child) => child.close(null, "SIGKILL"));
    expect(exit).toEqual({ kind: "interrupted", signal: "SIGKILL", coverage: "unknown" });
  });

  it("carries usage on a run cancelled after a completed turn, as partial", async () => {
    vi.useFakeTimers();
    const world = fakes();
    const harness = createCodexHarness({
      spawn: world.spawn,
      fs: world.fs,
      env: PARENT_ENV,
      platform: "darwin",
      kill: () => {},
    });
    const handle = await harness.start(startInput([]));
    world.children[0]?.emitStdout(
      lines({
        type: "turn.completed",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    const cancelling = harness.cancel(handle, millis(10_000));
    world.children[0]?.close(null, "SIGINT");
    await cancelling;
    expect(await handle.exit).toEqual({
      kind: "cancelled",
      usage: { inputTokens: 7, outputTokens: 3, inputIncludesCache: true },
      usageScope: "session",
      coverage: "partial",
    });
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
    expect(await handle.exit).toEqual({ kind: "cancelled", coverage: "unknown" });
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
    expect(await handle.exit).toEqual({ kind: "cancelled", coverage: "unknown" });
    expect(kills).toEqual(["SIGINT"]);
    // A second cancel, and a cancel of a settled handle, are no-ops.
    await harness.cancel(handle, millis(1));
    expect(kills).toEqual(["SIGINT"]);
  });
});

describe("running as another user (P10, D-P10-25)", () => {
  it("grants the git guard to the user and spawns codex through sudo", async () => {
    const world = fakes();
    const events: HookEvent[] = [];
    const granted: string[] = [];
    const harness = createCodexHarness({
      spawn: world.spawn,
      fs: world.fs,
      env: PARENT_ENV,
      platform: "linux",
    });
    const handle = await harness.start({
      ...startInput(events),
      runAs: { user: "worker-5", grant: async (path) => void granted.push(path) },
    });
    expect(granted).toHaveLength(1);
    expect(granted[0]).toContain("nightshift-codex-");
    const call = world.calls[0];
    expect(call?.file).toBe("sudo");
    expect(call?.args.slice(0, 4)).toEqual(["-n", "-u", "worker-5", "-H"]);
    expect(call?.args).toContain("codex");
    world.children[0]?.close(0);
    await handle.exit;
    const started = events.find((event) => event.type === "agent.started");
    expect(started?.payload).toMatchObject({ user: "worker-5" });
  });
});

describe("launching through the image's Node (P16 S-01)", () => {
  it("spawns the launcher with the CLI's script before codex's own arguments", async () => {
    const world = fakes();
    const events: HookEvent[] = [];
    const harness = createCodexHarness({
      spawn: world.spawn,
      fs: world.fs,
      env: PARENT_ENV,
      platform: "linux",
      launcher: { file: "/usr/local/bin/node", args: ["/usr/local/lib/codex/bin/codex.js"] },
    });
    const handle = await harness.start(startInput(events));
    const call = world.calls[0];
    expect(call?.file).toBe("/usr/local/bin/node");
    expect(call?.args.slice(0, 3)).toEqual(["/usr/local/lib/codex/bin/codex.js", "exec", "--json"]);
    world.children[0]?.close(0);
    await handle.exit;
  });
});

describe("measurement capture (P20 S-03)", () => {
  const THREAD = "01a15bbb-94ca-7bb3-9199-122e66126ad3";
  const CONV = "019e0000-0000-7000-8000-000000000001";
  const CHILD = "01a15bbd-0000-7000-8000-00000000c1d1";
  const fixture = (name: string): string =>
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
  const ROLLOUT = fixture("codex-rollout-measured.jsonl");
  /** The rollout as it stood after `n` records (the first launch is 16). */
  const rolloutTo = (n: number): string => `${ROLLOUT.split("\n").slice(0, n).join("\n")}\n`;
  const FIRST_LAUNCH = rolloutTo(16);
  const journalOf = (name: string, conversation = THREAD): string =>
    fixture(name).replaceAll(CONV, conversation);
  const streamOf = (usage: Record<string, number>): string =>
    lines(
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "DONE" } },
      { type: "turn.completed", usage },
    );
  const FIRST_STREAM = streamOf({
    input_tokens: 3014,
    cached_input_tokens: 1500,
    output_tokens: 83,
  });
  const SECOND_STREAM = streamOf({
    input_tokens: 4021,
    cached_input_tokens: 2000,
    output_tokens: 124,
  });
  const clock = { now: () => Date.parse("2026-10-20T23:54:00.000Z") };

  const ids = createCountingIdGenerator();
  const stamp = (observation: HarnessObservation): MeasurementObservation =>
    MeasurementObservationSchema.parse({
      ...observation,
      schemaVersion: 1,
      projectId: ids.next("proj"),
      programId: ids.next("prog"),
      runId: ids.next("run"),
      executionNodeId: ids.next("node"),
      agentId: ids.next("agent"),
      launch: { agentId: ids.next("agent"), launchId: "l1", segment: 0 },
      receivedAt: "2026-10-21T00:00:00.000Z",
    });

  const envelope = (records: Record<string, string | number | boolean>[]): string =>
    `${JSON.stringify({
      receivedAt: "2026-10-20T23:53:41.000Z",
      path: "/v1/logs",
      contentType: "application/json",
      signal: "logs",
      records: records.map((attributes) => ({
        kind: "log",
        attributes,
        resourceAttributes: {},
        droppedAttributeCount: 0,
      })),
      droppedRecordCount: 0,
    })}\n`;
  /** The journal with an extra conversation's records before its closing line. */
  const withConversation = (
    base: string,
    conversation: string,
    options: { retry?: boolean } = {},
  ): string => {
    const all = base.split("\n").filter((l) => l !== "");
    const closing = all.pop() ?? "";
    const common = { "conversation.id": conversation, model: "gpt-5.5" };
    return `${all.join("\n")}\n${envelope([
      { "event.name": "codex.conversation_starts", ...common },
      { "event.name": "codex.api_request", attempt: 0, ...common },
      ...(options.retry === true
        ? [{ "event.name": "codex.api_request", attempt: 1, ...common }]
        : []),
      {
        "event.name": "codex.sse_event",
        "event.kind": "response.completed",
        input_token_count: 300,
        output_token_count: 5,
        ...common,
      },
    ])}${closing}\n`;
  };

  const SPAWNING_PARENT = `${FIRST_LAUNCH}${[
    {
      timestamp: "2026-10-20T23:53:02.495Z",
      ordinal: 16,
      type: "response_item",
      payload: { type: "function_call", name: "spawn_agent", call_id: "c1", arguments: "SECRET" },
    },
    {
      timestamp: "2026-10-20T23:53:02.496Z",
      ordinal: 17,
      type: "event_msg",
      payload: { type: "collab_agent_spawn_begin", new_thread_id: CHILD },
    },
  ]
    .map((l) => `${JSON.stringify(l)}\n`)
    .join("")}`;
  const CHILD_ROLLOUT = lines(
    {
      timestamp: "2026-10-20T23:53:03.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: { id: CHILD, cli_version: "0.155.1" },
    },
    {
      timestamp: "2026-10-20T23:53:03.100Z",
      ordinal: 1,
      type: "token_usage_record",
      payload: {
        thread_id: CHILD,
        response_id: "child_resp_1",
        turn_id: "ct",
        usage: { input_tokens: 300, output_tokens: 5 },
      },
    },
  );

  interface Scenario {
    journal?: string;
    receiver?: "ok" | "throws";
    stopGap?: "receiver_lost" | "stopped_before_flush";
    rollouts?: RolloutServing;
    resume?: boolean;
    stream?: string;
    end?: "complete" | "cancel" | "interrupt";
    measurements?: boolean;
    runAs?: RunAs;
    env?: Record<string, string>;
    rolloutHome?: string;
    readdirError?: Error;
  }

  const scenario = async (o: Scenario = {}) => {
    const world = fakes({
      ...(o.rollouts === undefined ? {} : { rollouts: o.rollouts }),
      ...(o.rolloutHome === undefined ? {} : { rolloutHome: o.rolloutHome }),
      ...(o.readdirError === undefined ? {} : { readdirError: o.readdirError }),
    });
    const events: HookEvent[] = [];
    const sink = recordingMeasurementSink();
    const receivers: LocalReceiverOptions[] = [];
    const harness = createCodexHarness({
      spawn: world.spawn,
      fs: world.fs,
      env: o.env ?? PARENT_ENV,
      platform: "linux",
      clock,
      kill: () => {},
      startReceiver: async (options) => {
        receivers.push(options);
        if (o.receiver === "throws") throw new Error("EADDRINUSE");
        return {
          endpoint: "http://127.0.0.1:4318",
          capability: "cap-secret",
          journalPath: options.journalPath,
          pid: 77,
          stop: async () => {
            if (o.journal !== undefined) writeFileSync(options.journalPath, o.journal);
            return o.stopGap === undefined ? {} : { gap: o.stopGap };
          },
        };
      },
    });
    const input: HarnessStartInput = {
      ...startInput(events),
      ...(o.measurements === false ? {} : { measurements: sink }),
      ...(o.runAs === undefined ? {} : { runAs: o.runAs }),
      ...(o.resume === true ? { resume: { sessionId: THREAD } } : {}),
    };
    const handle = await harness.start(input);
    const child = world.children[0];
    child?.emitStdout(o.stream ?? FIRST_STREAM);
    let cancelling: Promise<void> | undefined;
    if (o.end === "cancel") cancelling = harness.cancel(handle, millis(10_000));
    if (o.end === "cancel" || o.end === "interrupt") child?.close(null, "SIGINT");
    else child?.close(0);
    await cancelling;
    const exit = await handle.exit;
    const ending = endings(events)[0]?.payload as Record<string, unknown>;
    return { ...world, events, exit, ending, sink, receivers, observations: sink.observations };
  };

  const requests = (obs: readonly HarnessObservation[]) => obs.filter((o) => o.kind === "request");
  const snapshots = (obs: readonly HarnessObservation[]) =>
    obs.filter((o) => o.kind === "cumulative_snapshot");
  const gapsOf = (ending: Record<string, unknown>): string =>
    ((ending.measurementGaps as string[] | undefined) ?? []).join(" | ");
  const FIRST: RolloutServing = { [THREAD]: [FIRST_LAUNCH] };

  it("emits two rollout requests matched by OTLP, one snapshot, and exits complete", async () => {
    const r = await scenario({
      journal: journalOf("codex-otlp-journal-launch1.jsonl"),
      rollouts: FIRST,
    });
    const args = r.calls[0]?.args.join(" ") ?? "";
    expect(args).toContain("http://127.0.0.1:4318/v1/logs");
    expect(args).toContain("Bearer cap-secret");
    expect(r.receivers[0]?.recordFilter).toBeDefined();
    expect(
      requests(r.observations).map((o) => [o.observationId, "requestId" in o && o.requestId]),
    ).toEqual([
      [`codex:rollout:${THREAD}:8`, "resp_1"],
      [`codex:rollout:${THREAD}:13`, "resp_2"],
    ]);
    expect(snapshots(r.observations)).toHaveLength(1);
    expect(r.exit).toMatchObject({
      kind: "completed",
      usageScope: "session",
      coverage: "complete",
      observedModel: "gpt-5.5",
      usage: { inputTokens: 3014 },
    });
    expect(r.ending).toMatchObject({
      requestCount: 2,
      excludedBeforeBoundary: 0,
      transports: ["sse"],
    });
    const stamped = r.observations.map(stamp);
    expect(JSON.stringify(stamped)).not.toMatch(/omitted|SECRET|DONE/);
    // The receiver's directory and journal are gone.
    expect(r.removed.some((p) => p.includes("nightshift-codex-otel-"))).toBe(true);
  });

  it("emits the same observation ids when the same journal is read twice", async () => {
    const o = {
      journal: journalOf("codex-otlp-journal-launch1.jsonl"),
      rollouts: FIRST,
    };
    const a = await scenario(o);
    const b = await scenario(o);
    expect(a.observations.map((x) => x.observationId)).toEqual(
      b.observations.map((x) => x.observationId),
    );
  });

  describe("resume", () => {
    it("fixes the ordinal boundary before spawning and emits one request", async () => {
      const r = await scenario({
        journal: journalOf("codex-otlp-journal-launch2.jsonl"),
        rollouts: { [THREAD]: [FIRST_LAUNCH, ROLLOUT] },
        resume: true,
        stream: SECOND_STREAM,
      });
      expect(requests(r.observations).map((o) => o.observationId)).toEqual([
        `codex:rollout:${THREAD}:24`,
      ]);
      expect(snapshots(r.observations)[0]).toMatchObject({ counters: { inputTokens: 4021 } });
      expect(r.ending).toMatchObject({ excludedBeforeBoundary: 2, requestCount: 1 });
      expect(r.exit).toMatchObject({ usageScope: "session", coverage: "complete" });
    });

    it("reconciles both launches to 3014 and 1007 input tokens", async () => {
      const first = await scenario({
        journal: journalOf("codex-otlp-journal-launch1.jsonl"),
        rollouts: FIRST,
      });
      const second = await scenario({
        journal: journalOf("codex-otlp-journal-launch2.jsonl"),
        rollouts: { [THREAD]: [FIRST_LAUNCH, ROLLOUT] },
        resume: true,
        stream: SECOND_STREAM,
      });
      const one = reconcileSegment(first.observations.map(stamp), { resumedSession: false });
      expect(one.counters.inputTokens).toBe(3014);
      const two = reconcileSegment(second.observations.map(stamp), {
        resumedSession: true,
        baseline: one.sessionCumulative?.counters,
      });
      expect(two.counters.inputTokens).toBe(1007);
    });

    it("falls back to a time boundary, selects the same request, and is partial", async () => {
      const r = await scenario({
        journal: journalOf("codex-otlp-journal-launch2.jsonl"),
        rollouts: { [THREAD]: [new Error("EIO"), ROLLOUT] },
        resume: true,
        stream: SECOND_STREAM,
      });
      expect(requests(r.observations).map((o) => o.observationId)).toEqual([
        `codex:rollout:${THREAD}:24`,
      ]);
      expect(r.exit.coverage).toBe("partial");
      expect(gapsOf(r.ending)).toContain("launch boundary by time");
    });
  });

  describe("without measurements, or without a receiver", () => {
    it("adds no otel arguments, starts no receiver and emits nothing", async () => {
      const r = await scenario({ measurements: false, rollouts: FIRST });
      expect(r.calls[0]?.args.join(" ")).not.toContain("otel");
      expect(r.receivers).toHaveLength(0);
      expect(r.observations).toHaveLength(0);
      expect(r.ending).not.toHaveProperty("measurementGaps");
      expect(r.exit.coverage).toBe("complete");
    });

    it("launches when the receiver throws, emits the rollout and exits partial", async () => {
      const r = await scenario({ receiver: "throws", rollouts: FIRST });
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.args.join(" ")).not.toContain("otel");
      expect(requests(r.observations)).toHaveLength(2);
      expect(r.exit).toMatchObject({ kind: "completed", coverage: "partial" });
      expect(gapsOf(r.ending)).toContain("receiver unavailable");
      expect(gapsOf(r.ending)).toContain("telemetry absent");
    });
  });

  describe("under runAs (discovery follows the launched worker)", () => {
    const runAs = (env?: Record<string, string>): RunAs => ({
      user: "project",
      ...(env === undefined ? {} : { env }),
      grant: async () => {},
      kill: () => {},
    });
    const NO_HOME_ENV = { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "sk-operator" };
    const underEngine = (path: string): boolean =>
      path.startsWith("/Users/op") || !path.startsWith("/project/codex/");

    it("searches only the project's CODEX_HOME, at the resume boundary and at close", async () => {
      const journal = journalOf("codex-otlp-journal-launch1.jsonl");
      const plain = await scenario({
        journal,
        rollouts: { [THREAD]: [FIRST_LAUNCH, ROLLOUT] },
        resume: true,
      });
      const r = await scenario({
        journal,
        rollouts: { [THREAD]: [FIRST_LAUNCH, ROLLOUT] },
        resume: true,
        runAs: runAs({ CODEX_HOME: "/project/codex" }),
        rolloutHome: "/project/codex",
      });
      expect(r.listed.length).toBeGreaterThan(0);
      expect(r.listed.filter(underEngine)).toEqual([]);
      expect(
        r.listed.every(
          (p) =>
            p.startsWith("/project/codex/sessions") ||
            p.startsWith("/project/codex/archived_sessions"),
        ),
      ).toBe(true);
      expect(
        requests(r.observations).map((o) => [o.observationId, "requestId" in o && o.requestId]),
      ).toEqual(
        requests(plain.observations).map((o) => [o.observationId, "requestId" in o && o.requestId]),
      );
      expect(requests(r.observations)).toHaveLength(1);
    });

    it("skips discovery when no Codex home resolves and lets telemetry decide", async () => {
      const r = await scenario({
        journal: journalOf("codex-otlp-journal-launch1.jsonl"),
        rollouts: FIRST,
        env: NO_HOME_ENV,
        runAs: runAs(),
      });
      expect(r.listed).toEqual([]);
      expect(gapsOf(r.ending)).toContain("rollout home unknown under runAs");
      expect(requests(r.observations).length).toBeGreaterThan(0);
      expect(r.observations.some((o) => o.observationId.startsWith("codex:rollout:"))).toBe(false);
      expect(r.exit.coverage).toBe("partial");
    });

    it("names an unreadable rollout directory and never falls back", async () => {
      const denied = Object.assign(new Error("denied"), { code: "EACCES" });
      const r = await scenario({
        journal: journalOf("codex-otlp-journal-launch1.jsonl"),
        rollouts: FIRST,
        runAs: runAs({ CODEX_HOME: "/project/codex" }),
        readdirError: denied,
      });
      expect(r.listed.filter((p) => !p.startsWith("/project/codex/"))).toEqual([]);
      expect(gapsOf(r.ending)).toContain("rollout unreadable");
      expect(r.exit).toMatchObject({ kind: "completed" });
    });
  });

  describe("fallbacks", () => {
    it("takes requests from OTLP by position when the rollout is missing", async () => {
      const r = await scenario({ journal: journalOf("codex-otlp-journal-launch1.jsonl") });
      expect(requests(r.observations).map((o) => o.observationId)).toEqual([
        `codex:otel:${THREAD}:0`,
        `codex:otel:${THREAD}:1`,
      ]);
      expect(r.exit.coverage).toBe("partial");
      expect(gapsOf(r.ending)).toContain("telemetry only");
    });

    it("excludes a retried conversation's completions and names them", async () => {
      const r = await scenario({ journal: journalOf("codex-otlp-retry.jsonl") });
      expect(requests(r.observations)).toHaveLength(0);
      expect(r.ending).toMatchObject({ excludedTelemetry: 1 });
      expect(gapsOf(r.ending)).toContain("1 completions excluded");
      expect(r.exit.coverage).toBe("partial");
    });

    it("is partial with usage and unknown without when both sources are missing", async () => {
      const withUsage = await scenario({ receiver: "throws" });
      expect(requests(withUsage.observations)).toHaveLength(0);
      expect(withUsage.exit.coverage).toBe("partial");
      const without = await scenario({
        receiver: "throws",
        stream: lines({ type: "thread.started", thread_id: THREAD }, { type: "turn.started" }),
      });
      expect(without.exit.coverage).toBe("unknown");
    });

    it("emits the rollout's request once and names a count disagreement", async () => {
      const journal = journalOf("codex-otlp-journal-launch1.jsonl").replace(
        '"input_token_count": "1007"',
        '"input_token_count": "1008"',
      );
      const r = await scenario({ journal, rollouts: FIRST });
      expect(requests(r.observations)).toHaveLength(2);
      expect(gapsOf(r.ending)).toContain("discrepancy");
      expect(r.exit.coverage).toBe("partial");
    });

    it("emits no extra request for an extra OTLP completion", async () => {
      const r = await scenario({
        journal: withConversation(journalOf("codex-otlp-journal-launch1.jsonl"), THREAD),
        rollouts: FIRST,
      });
      expect(requests(r.observations)).toHaveLength(2);
      expect(gapsOf(r.ending)).toContain("discrepancy");
      expect(r.exit.coverage).toBe("partial");
    });

    it("is partial on an unverified transport even when the counts agree", async () => {
      const journal = journalOf("codex-otlp-journal-launch1.jsonl").replaceAll(
        "codex.sse_event",
        "codex.websocket.event",
      );
      const r = await scenario({ journal, rollouts: FIRST });
      expect(requests(r.observations)).toHaveLength(2);
      expect(r.exit.coverage).toBe("partial");
      expect(gapsOf(r.ending)).toContain("transport websocket unverified");
    });
  });

  describe("native children", () => {
    const parentJournal = journalOf("codex-otlp-journal-launch1.jsonl");

    it("takes a child's requests from its rollout, with childRef, and is partial", async () => {
      const r = await scenario({
        journal: withConversation(parentJournal, CHILD),
        rollouts: { [THREAD]: [SPAWNING_PARENT], [CHILD]: [CHILD_ROLLOUT] },
      });
      const child = requests(r.observations).filter((o) => "childRef" in o);
      expect(child.map((o) => o.observationId)).toEqual([`codex:rollout:${CHILD}:1`]);
      expect(child[0]).toMatchObject({ childRef: { kind: "session", id: CHILD } });
      expect(requests(r.observations)).toHaveLength(3);
      expect(r.exit.coverage).toBe("partial");
      expect(gapsOf(r.ending)).toContain("native children spawned; capture unverified");
      expect(r.ending).toMatchObject({ childConversations: 1 });
    });

    it("takes a child with no rollout from OTLP, with childRef, and is partial", async () => {
      const r = await scenario({
        journal: withConversation(parentJournal, CHILD),
        rollouts: FIRST,
      });
      const child = requests(r.observations).filter((o) => "childRef" in o);
      expect(child.map((o) => o.observationId)).toEqual([`codex:otel:${CHILD}:0`]);
      expect(r.exit.coverage).toBe("partial");
    });

    it("adds no child request for a retried child, and the totals are the parent's alone", async () => {
      const r = await scenario({
        journal: withConversation(parentJournal, CHILD, { retry: true }),
        rollouts: FIRST,
      });
      expect(requests(r.observations).filter((o) => "childRef" in o)).toHaveLength(0);
      expect(r.exit.coverage).toBe("partial");
      const total = reconcileSegment(r.observations.map(stamp), { resumedSession: false });
      expect(total.counters.inputTokens).toBe(3014);
    });
  });

  describe("cancellation and loss", () => {
    const ONE_RESPONSE = rolloutTo(9);
    const cancelled = journalOf("codex-otlp-cancelled.jsonl");
    const oneStream = lines(
      { type: "thread.started", thread_id: THREAD },
      { type: "turn.started" },
    );

    it("emits the one request of a cancelled run and exits cancelled, partial", async () => {
      const r = await scenario({
        journal: cancelled,
        rollouts: { [THREAD]: [ONE_RESPONSE] },
        stream: oneStream,
        end: "cancel",
      });
      expect(requests(r.observations)).toHaveLength(1);
      expect(r.exit).toMatchObject({ kind: "cancelled", coverage: "partial" });
      expect(JSON.stringify(r.ending).length).toBeLessThan(MAX_HOOK_PAYLOAD_BYTES);
    });

    it("behaves the same when interrupted", async () => {
      const r = await scenario({
        journal: cancelled,
        rollouts: { [THREAD]: [ONE_RESPONSE] },
        stream: oneStream,
        end: "interrupt",
      });
      expect(requests(r.observations)).toHaveLength(1);
      expect(r.exit).toMatchObject({ kind: "interrupted", coverage: "partial" });
    });

    it("lowers coverage and names a receiver stop gap", async () => {
      const r = await scenario({
        journal: journalOf("codex-otlp-journal-launch1.jsonl"),
        rollouts: FIRST,
        stopGap: "stopped_before_flush",
      });
      expect(r.exit.coverage).toBe("partial");
      expect(gapsOf(r.ending)).toContain("stopped_before_flush");
    });

    it("lowers coverage and names a records_truncated loss", async () => {
      const journal = journalOf("codex-otlp-journal-launch1.jsonl").replace(
        '{"closed"',
        '{"gap": "records_truncated"}\n{"closed"',
      );
      const r = await scenario({ journal, rollouts: FIRST });
      expect(r.exit.coverage).toBe("partial");
      expect(gapsOf(r.ending)).toContain("records_truncated");
      expect(JSON.stringify(r.ending).length).toBeLessThan(MAX_HOOK_PAYLOAD_BYTES);
    });
  });
});
