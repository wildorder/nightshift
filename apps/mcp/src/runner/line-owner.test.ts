import { execFile, execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CommitSha,
  defaultOrgConfig,
  type HeartbeatBody,
  type HeartbeatResponse,
  type LineRecord,
  type LineSettleBody,
  NIGHTSHIFT_CONFIG_FILE,
  type ProgramId,
} from "@nightshift/contracts";
import {
  appendQueueEntry,
  createCountingIdGenerator,
  createFixtures,
  lineProgramId,
  makeDispatch,
  makeLineRecord,
  makeProgramContract,
  makeRootNode,
  makeRun,
  requireEffectivePolicy,
  resolvePush,
  settleBatch,
  systemClock,
  takeBatch,
} from "@nightshift/core";
import { nodeGitRunner } from "@nightshift/execution";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../compose.js";
import { BootstrapError, IMDS, LINE_TAG, RUNNER_TAGS, readIdentity } from "./bootstrap.js";
import { runLineOwner } from "./line-owner.js";
import type { CommandResult, Machine } from "./machine.js";
import { type LineRunnerContext, runRunner } from "./main.js";
import type { LineRunnerPlane, RunnerPlane } from "./plane.js";

const f = createFixtures();
const LINE = "nightshift/develop";
const GENERATION = 2;
const GITHUB_TOKEN = "gh-read-token";
const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr = "no"): CommandResult => ({ exitCode: 1, stdout: "", stderr });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const CONFIG = {
  schemaVersion: 1,
  projectId: f.scope.projectId,
  contextDocs: [],
  verification: [{ id: "ok", command: 'node -e "process.exit(0)"' }],
  modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
  delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
  costPolicy: {},
};

/** A directory standing in for GitHub: a line, and program branches off main. */
interface World {
  readonly root: string;
  readonly origin: string;
  readonly workspace: string;
  readonly programs: Record<"a" | "b" | "c" | "d", ProgramId>;
  readonly branches: Record<"a" | "b" | "c" | "d", string>;
  head(branch: string): CommitSha;
}

const makeWorld = (): World => {
  const root = mkdtempSync(join(tmpdir(), "nightshift-line-owner-"));
  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, NIGHTSHIFT_CONFIG_FILE), JSON.stringify(CONFIG));
  writeFileSync(join(origin, "shared.txt"), "base\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "base");
  git(origin, "branch", LINE);
  const branches = { a: "prog-a", b: "prog-b", c: "prog-c", d: "prog-d" } as const;
  const edit = (branch: string, file: string, text: string) => {
    git(origin, "checkout", "-q", "-b", branch, "main");
    writeFileSync(join(origin, file), text);
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", `${branch} changes ${file}`);
    git(origin, "checkout", "-q", "main");
  };
  edit(branches.a, "a.txt", "a\n");
  edit(branches.b, "b.txt", "b\n");
  edit(branches.c, "shared.txt", "from c\n");
  edit(branches.d, "shared.txt", "from d\n");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return {
    root,
    origin,
    workspace,
    programs: {
      a: f.ids.next("prog"),
      b: f.ids.next("prog"),
      c: f.ids.next("prog"),
      d: f.ids.next("prog"),
    },
    branches,
    head: (branch) => git(origin, "rev-parse", `refs/heads/${branch}`) as CommitSha,
  };
};

// --- the machine --------------------------------------------------------------------------

interface FakeMachine extends Machine {
  readonly commands: string[];
}

/** Runs the commands that touch the real checkout; answers the rest (mounts, SSM, the sampler). */
const REAL = new Set(["git", "env", "mkdir"]);

const lineMachine = (): FakeMachine => {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const tags: Record<string, string> = {
    [LINE_TAG]: LINE,
    [RUNNER_TAGS.project]: f.scope.projectId,
    [RUNNER_TAGS.program]: f.scope.programId,
    [RUNNER_TAGS.run]: f.scope.runId,
    [RUNNER_TAGS.generation]: String(GENERATION),
    [RUNNER_TAGS.stage]: "dev",
    [RUNNER_TAGS.api]: "https://api.dev.nightshift.invalid",
  };
  let parameterPresent = true;
  let now = Date.parse("2026-10-01T12:00:00.000Z");
  return {
    commands,
    exec: async (file, args) => {
      commands.push([file, ...args].join(" "));
      if (REAL.has(file)) {
        return new Promise((resolve) => {
          execFile(file, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = (error as { code?: unknown } | null)?.code;
            resolve({
              exitCode: error === null ? 0 : typeof code === "number" ? code : 1,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          });
        });
      }
      if (file === "mv" && args[0] === "-f") {
        const value = files.get(args[1] ?? "");
        if (value === undefined) return fail("missing source");
        files.set(args[2] ?? "", value);
        files.delete(args[1] ?? "");
        return ok();
      }
      if (file === "aws" && args[1] === "get-parameter") {
        return parameterPresent ? ok("eyJ.first.token\n") : fail("ParameterNotFound");
      }
      if (file === "aws" && args[1] === "delete-parameter") {
        parameterPresent = false;
        return ok();
      }
      if (file === "findmnt") return fail();
      if (file === "df") return ok("Use%\n 12%\n");
      return ok();
    },
    readFile: async (path) => files.get(path),
    writeFile: async (path, text) => {
      files.set(path, text);
    },
    http: async (method, url, headers) => {
      if (method === "PUT" && url === `${IMDS}/latest/api/token`) {
        return { status: 200, text: "imds-token" };
      }
      if (headers["X-aws-ec2-metadata-token"] !== "imds-token") return { status: 401, text: "" };
      const path = url.slice(`${IMDS}/latest/meta-data/`.length);
      if (path === "instance-id") return { status: 200, text: "i-0123456789abcdef0" };
      const tag = tags[path.replace("tags/instance/", "")];
      return tag === undefined ? { status: 404, text: "" } : { status: 200, text: tag };
    },
    // Yields to the event loop, so a loop of fake sleeps cannot starve everything else.
    sleep: async (ms) => {
      await new Promise((resolve) => setImmediate(resolve));
      now += Math.min(ms, 500);
    },
    now: () => now,
  };
};

// --- the plane ----------------------------------------------------------------------------

interface FakePlane extends LineRunnerPlane {
  record: LineRecord;
  readonly events: string[];
  readonly heartbeats: { body: HeartbeatBody; at: number }[];
  readonly settles: { body: LineSettleBody; at: number }[];
  readonly uploads: Map<string, string>;
  reads: number;
  /** Queues a range for the line. */
  enqueue(program: ProgramId, upTo: CommitSha): void;
  /** Runs once, just before the publisher tries to move the line. */
  beforePublish?: (() => void) | undefined;
}

const ticks = async (n: number) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const makePlane = (
  world: World,
  machine: Machine,
  options: {
    readonly record?: Partial<LineRecord>;
    readonly respond?: (count: number) => Partial<HeartbeatResponse> | "throw";
    readonly resolveAfterReads?: number;
  } = {},
): FakePlane => {
  const programs = [
    { program: world.programs.a, branch: world.branches.a },
    { program: world.programs.b, branch: world.branches.b },
    { program: world.programs.c, branch: world.branches.c },
    { program: world.programs.d, branch: world.branches.d },
  ];
  const ids = createCountingIdGenerator(9_000);
  const iso = () => new Date(machine.now()).toISOString();
  const bundles = join(world.root, "bundles");
  mkdirSync(bundles, { recursive: true });
  let beats = 0;
  let pendingResolveAt: number | undefined;

  const publish = (push: {
    head: CommitSha;
    expectedPredecessor: CommitSha;
    bundleKey: string;
  }) => {
    plane.beforePublish?.();
    plane.beforePublish = undefined;
    const file = plane.uploads.get(push.bundleKey);
    if (file === undefined) return { status: "error" as const, detail: "no bundle uploaded" };
    try {
      execFileSync("git", ["unpack-objects", "-q"], {
        cwd: world.origin,
        input: readFileSync(file),
      });
      const exists = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/heads/${LINE}`], {
        cwd: world.origin,
      });
      git(
        world.origin,
        "update-ref",
        `refs/heads/${LINE}`,
        push.head,
        exists.status === 0 ? push.expectedPredecessor : "0".repeat(40),
      );
      return { status: "published" as const, detail: undefined };
    } catch (error) {
      return {
        status: "conflict" as const,
        detail: `the line moved: ${(error as Error).message.split("\n")[0]}`,
      };
    }
  };

  const apply = (change: ReturnType<typeof settleBatch>) => {
    if (!change.ok) throw new Error(`the plane refused: ${change.reason}: ${change.detail}`);
    plane.record = change.record;
  };

  const plane: FakePlane = {
    record: makeLineRecord(f, {
      branch: LINE,
      repositoryUrl: world.origin,
      ...options.record,
    }),
    events: [],
    heartbeats: [],
    settles: [],
    uploads: new Map(),
    reads: 0,
    enqueue(program, upTo) {
      plane.record = appendQueueEntry(plane.record, { program, upTo }, iso());
    },
    line: async () => {
      plane.reads += 1;
      if (
        pendingResolveAt !== undefined &&
        plane.reads >= pendingResolveAt &&
        plane.record.push?.status === "pending"
      ) {
        apply(resolvePush(plane.record, plane.record.push.head, "published", undefined, iso()));
        plane.events.push("old-push-resolved");
      }
      return {
        record: plane.record,
        programId: lineProgramId(f.scope.projectId, LINE),
        runId: f.scope.runId,
        dispatchStatus: "running",
        generation: GENERATION,
        meteredUsd: 0,
        programs,
      };
    },
    dispatch: async () => makeDispatch(f, { generation: GENERATION }),
    takeBatch: async (release) => {
      plane.events.push("takeBatch");
      const taken = takeBatch(
        plane.record,
        GENERATION,
        { batchId: ids.next("comp") },
        iso(),
        release,
      );
      plane.record = taken.record;
      // As the plane's route answers: the record's batch, the one just taken or already held.
      return plane.record.batch;
    },
    settle: async (body) => {
      plane.events.push(`settle:${body.batchId}`);
      plane.settles.push({ body, at: machine.now() });
      apply(
        settleBatch(
          plane.record,
          body,
          { compositionId: ids.next("comp"), parkedIds: body.parked.map(() => ids.next("comp")) },
          GENERATION,
          iso(),
        ),
      );
      const push = body.push;
      if (push === undefined) return;
      void (async () => {
        await ticks(3);
        const result = publish(push);
        apply(resolvePush(plane.record, push.head, result.status, result.detail, iso()));
      })();
    },
    heartbeat: async (body) => {
      beats += 1;
      plane.heartbeats.push({ body, at: machine.now() });
      const answer = options.respond?.(beats) ?? {};
      if (answer === "throw") throw new Error("the plane is unreachable");
      return {
        generation: GENERATION,
        status: "running",
        leaseExpiresAt: iso(),
        stop: false,
        credentials: { github: GITHUB_TOKEN },
        ...answer,
      };
    },
    bundleUploadUrl: async (id) => ({
      uploadUrl: `https://uploads.invalid/${id}`,
      key: `bundles/${id}`,
      contentType: "application/octet-stream",
    }),
  };
  if (options.resolveAfterReads !== undefined) pendingResolveAt = options.resolveAfterReads;
  return plane;
};

// --- running it ---------------------------------------------------------------------------

/**
 * A line is a run (S-02): its dispatch, program and heartbeat come over the run
 * plane, here the same fake the line's view is read from. The program has no plan.
 */
const runPlaneOf = (plane: FakePlane): RunnerPlane => ({
  dispatch: async () => {
    const dispatch = await plane.dispatch();
    return dispatch === undefined
      ? undefined
      : { ...dispatch, input: { ...dispatch.input, repositoryUrl: world.origin } };
  },
  program: async () =>
    makeProgramContract(f, {
      kind: "line",
      repository: { ...makeProgramContract(f).repository, programBranch: LINE },
    }),
  planDocument: async () => {
    throw new Error("a line program has no plan document");
  },
  heartbeat: (_scope, body) => plane.heartbeat(body),
  nodes: async () => [],
  jobs: async () => [],
});

let world: World;
beforeEach(() => {
  world = makeWorld();
});
afterEach(() => {
  rmSync(world.root, { recursive: true, force: true });
});

/**
 * The line run's runtime over the memory stores, seeded with the line program,
 * its run and root node (the plane makes them before a machine exists). The
 * harness cannot launch anything: a repair job fails with that, in its words.
 */
const lineRuntime = async (): Promise<{ stores: InMemoryStores; runtime: Runtime }> => {
  const stores = createInMemoryStores();
  const program = makeProgramContract(f, {
    kind: "line",
    repository: { ...makeProgramContract(f).repository, programBranch: LINE },
    verification: CONFIG.verification,
    examinationPolicy: {
      low: {
        required: false,
        mustDifferModel: false,
        mustDifferProvider: false,
        blockOnMaterialFindings: false,
      },
      medium: {
        required: false,
        mustDifferModel: false,
        mustDifferProvider: false,
        blockOnMaterialFindings: false,
      },
      high: {
        required: false,
        mustDifferModel: false,
        mustDifferProvider: false,
        blockOnMaterialFindings: false,
      },
    },
  });
  await stores.programContracts.put(program);
  const policy = requireEffectivePolicy(defaultOrgConfig(f.ids.next("org"), AT), program);
  await stores.runs.put(makeRun(f, { status: "pending", location: "remote", policy }));
  await stores.executionNodes.put(makeRootNode(f, { status: "validated" }));
  const runtime = {
    stores,
    ids: createCountingIdGenerator(20_000),
    clock: systemClock,
    paths: localPaths(),
    git: nodeGitRunner,
    bodies: { put: async () => undefined, get: async () => undefined },
    tokens: { mint: async () => "token" },
    harness: {
      id: "none",
      capabilities: { usage: false },
      start: async () => {
        throw new Error("no agent can be launched in this test");
      },
    },
    workerLaunch: () => ({ name: "worker", command: "worker", args: [], env: {} }),
    workerEnvironment: () => {
      throw new Error("no worker environment in this test");
    },
  } as unknown as Runtime;
  return { stores, runtime };
};

const AT = "2026-10-01T12:00:00.000Z";

const localPaths = () => ({
  worktree: (runId: string, nodeId: string) =>
    join(world.root, "wt", runId.slice(-8), nodeId.slice(-8)),
  runDir: (runId: string) => join(world.root, "runs", runId),
  spool: (runId: string) => join(world.root, "runs", runId, "spool.ndjson"),
  transcript: (runId: string, agentId: string) =>
    join(world.root, "runs", runId, "agents", agentId, "transcript.jsonl"),
  measurementsDir: (runId: string) => join(world.root, "runs", runId, "measurements"),
  measurementJournal: (runId: string, agentId: string, launchId: string) =>
    join(world.root, "runs", runId, "measurements", `${agentId}__${launchId}.ndjson`),
  scratch: (checkout: string) => join(dirname(checkout), "scratch"),
});

const own = (
  machine: FakeMachine,
  plane: FakePlane,
  options: {
    readonly idleSeconds?: number;
    readonly log?: string[];
    /** Runs everything as a project user and records the grants and reclaims in `plane.events`. */
    readonly asProject?: boolean;
    /** The line run's runtime, when the test looks at what it recorded. */
    readonly runtime?: Runtime;
  } = {},
) =>
  runRunner({
    machine,
    log: (line) => options.log?.push(line),
    workspace: world.workspace,
    device: "/dev/xvdf",
    engineUser: "engine",
    // The machine's PATH, as the runner binary passes it: steps find the toolchain where it is installed.
    ...(process.env.PATH === undefined ? {} : { inheritedPath: process.env.PATH }),
    plane: () => runPlaneOf(plane),
    linePlane: (_endpoint, _tokens, target) => {
      expect(target).toEqual({
        projectId: f.scope.projectId,
        branch: LINE,
        scope: f.scope,
        generation: GENERATION,
      });
      return plane;
    },
    lineWork: (context) =>
      runLineOwner(context, {
        git: nodeGitRunner,
        ids: createCountingIdGenerator(5_000),
        clock: systemClock,
        paths: { scratch: (checkout) => join(dirname(checkout), "scratch") },
        upload: async ({ url, file }) => {
          const stored = join(world.root, "bundles", url.split("/").at(-1) ?? "bundle");
          copyFileSync(file, stored);
          plane.uploads.set(`bundles/${url.split("/").at(-1)}`, stored);
        },
        idleSeconds: options.idleSeconds ?? 3,
        pollMs: 500,
        repairPollMs: 5,
        makeRuntime: async () => options.runtime ?? (await lineRuntime()).runtime,
        ...(options.asProject !== true
          ? {}
          : {
              runAs: () => ({
                user: "project",
                grant: async (path: string) => {
                  plane.events.push(`grant:${path}`);
                },
              }),
              reclaim: async (path: string) => {
                plane.events.push(`reclaim:${path}`);
              },
            }),
      }),
  });

const lastBeat = (plane: FakePlane) => plane.heartbeats.at(-1);

describe("a line machine boots as any run", () => {
  it("prepares the run's dispatch and program, starts no root, and hands its context to the line work", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    const runPlane = runPlaneOf(plane);
    const seen: LineRunnerContext[] = [];
    let rootStarted = false;
    const code = await runRunner({
      machine,
      log: () => undefined,
      workspace: world.workspace,
      device: "/dev/xvdf",
      engineUser: "engine",
      plane: () => ({
        ...runPlane,
        // A plan document is never asked for: a line program has none.
        planDocument: async () => {
          throw new Error("asked for a plan document");
        },
      }),
      linePlane: () => plane,
      work: async () => {
        rootStarted = true;
        return undefined;
      },
      lineWork: async (context) => {
        seen.push(context);
        return undefined;
      },
    });
    expect(code).toBe(0);
    expect(rootStarted).toBe(false);
    expect(seen).toHaveLength(1);
    const context = seen[0] as LineRunnerContext;
    expect(context.scope).toEqual(f.scope);
    expect(context.identity.branch).toBe(LINE);
    expect(context.program.kind).toBe("line");
    expect(context.dispatch.runId).toBe(f.scope.runId);
    expect(context.projectEnvFile).toBe(`${context.layout.run}/project.env`);
    // The checkout was made by the run's prepare, on the line's branch at its head.
    expect(git(context.layout.checkout, "rev-parse", "HEAD")).toBe(world.head(LINE));
    expect(plane.heartbeats.map((beat) => beat.body)).toContainEqual(
      expect.objectContaining({ report: "ready" }),
    );
  });

  it("starts a line that is not at the remote yet from main's head", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    git(world.origin, "branch", "-D", LINE);
    let head: string | undefined;
    await runRunner({
      machine,
      log: () => undefined,
      workspace: world.workspace,
      device: "/dev/xvdf",
      engineUser: "engine",
      plane: () => runPlaneOf(plane),
      linePlane: () => plane,
      lineWork: async (context) => {
        head = git(context.layout.checkout, "rev-parse", "HEAD");
        return undefined;
      },
    });
    expect(head).toBe(world.head("main"));
  });
});

describe("a line machine's bootstrap", () => {
  it("reads a line identity from the run's tags and takes its first token from the run's parameter", async () => {
    const machine = lineMachine();
    const identity = await readIdentity(machine);
    expect(identity).toEqual({
      kind: "line",
      projectId: f.scope.projectId,
      branch: LINE,
      scope: f.scope,
      generation: GENERATION,
      stage: "dev",
      apiEndpoint: "https://api.dev.nightshift.invalid",
      instanceId: "i-0123456789abcdef0",
    });
    const plane = makePlane(world, machine);
    const code = await own(machine, plane, { idleSeconds: 1 });
    expect(code).toBe(0);
    expect(machine.commands).toContain(
      `aws ssm get-parameter --name /nightshift/dev/dispatch/${f.scope.runId}/${GENERATION} --with-decryption --query Parameter.Value --output text`,
    );
    expect(machine.commands).toContain(
      `aws ssm delete-parameter --name /nightshift/dev/dispatch/${f.scope.runId}/${GENERATION}`,
    );
  });

  it("refuses a line machine whose generation tag is not a number", async () => {
    const machine = lineMachine();
    const http = machine.http;
    machine.http = async (method, url, headers) =>
      url.endsWith(`tags/instance/${RUNNER_TAGS.generation}`)
        ? { status: 200, text: "zero" }
        : http(method, url, headers);
    await expect(readIdentity(machine)).rejects.toBeInstanceOf(BootstrapError);
  });

  it("heartbeats on the run's dispatch route with its generation, reports running, and receives credentials", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    const log: string[] = [];
    expect(await own(machine, plane, { idleSeconds: 1, log })).toBe(0);
    expect(plane.heartbeats.length).toBeGreaterThan(1);
    expect(plane.heartbeats.every((beat) => beat.body.generation === GENERATION)).toBe(true);
    expect(plane.heartbeats.some((beat) => beat.body.report === "running")).toBe(true);
    // The credentials came: the mirror was cloned with the read token.
    expect(machine.commands.some((c) => c.includes(`NIGHTSHIFT_GIT_TOKEN=${GITHUB_TOKEN}`))).toBe(
      true,
    );
    expect(log.join("\n")).toContain("line nightshift/develop");
  });
});

describe("composing and publishing", () => {
  it("fetches queued heads, composes a batch, uploads the bundle, settles with the push and reads its outcome", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    const aHead = world.head(world.branches.a);
    const bHead = world.head(world.branches.b);
    plane.enqueue(world.programs.a, aHead);
    plane.enqueue(world.programs.b, bHead);
    const before = world.head(LINE);

    expect(await own(machine, plane)).toBe(0);

    const settle = plane.settles[0]?.body;
    expect(settle?.composition?.ranges.map((r) => r.upTo).sort()).toEqual([aHead, bHead].sort());
    expect(settle?.push).toMatchObject({
      head: settle?.composition?.commit,
      expectedPredecessor: before,
      bundleKey: expect.stringMatching(/^bundles\//),
    });
    const after = world.head(LINE);
    expect(after).toBe(settle?.composition?.commit);
    expect(git(world.origin, "show", `${after}:a.txt`)).toBe("a");
    expect(git(world.origin, "show", `${after}:b.txt`)).toBe("b");
    expect(plane.record.push?.status).toBe("published");
    expect(plane.record.compositions[0]?.pushed).toBeDefined();
    expect(lastBeat(plane)?.body.report).toBe("stopped");
  });

  it("composes onto main's head when the line has no ref at the remote yet", async () => {
    git(world.origin, "branch", "-D", LINE);
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    const log: string[] = [];
    const aHead = world.head(world.branches.a);
    plane.enqueue(world.programs.a, aHead);
    const main = world.head("main");

    expect(await own(machine, plane, { log })).toBe(0);

    const settle = plane.settles[0]?.body;
    expect(settle?.push?.expectedPredecessor).toBe(main);
    expect(settle?.composition?.parent).toBe(main);
    expect(log.join("\n")).toContain("does not exist at the remote yet");
    const after = world.head(LINE);
    expect(after).toBe(settle?.composition?.commit);
    expect(git(world.origin, "show", `${after}:a.txt`)).toBe("a");
    expect(plane.record.push?.status).toBe("published");
  });

  it("refetches the line and recomposes after a conflict outcome", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    plane.enqueue(world.programs.a, world.head(world.branches.a));
    const original = world.head(LINE);
    // Someone else moves the line before the publisher's compare-and-swap.
    plane.beforePublish = () => {
      const tree = git(world.origin, "rev-parse", `${original}^{tree}`);
      const other = git(world.origin, "commit-tree", tree, "-p", original, "-m", "elsewhere");
      git(world.origin, "update-ref", `refs/heads/${LINE}`, other);
    };

    expect(await own(machine, plane)).toBe(0);

    expect(plane.settles).toHaveLength(2);
    const [first, second] = plane.settles.map((entry) => entry.body.push);
    expect(first?.expectedPredecessor).toBe(original);
    expect(second?.expectedPredecessor).not.toBe(original);
    expect(plane.record.push?.status).toBe("published");
    const after = world.head(LINE);
    expect(after).toBe(second?.head);
    expect(git(world.origin, "show", `${after}:a.txt`)).toBe("a");
    expect(git(world.origin, "log", "--format=%s", after)).toContain("elsewhere");
  });
});

describe("a range that conflicts", () => {
  it("becomes engine repair jobs with recorded decisions, and is parked with the cause and the agent's words once the budget is spent", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    plane.enqueue(world.programs.c, world.head(world.branches.c));
    plane.enqueue(world.programs.d, world.head(world.branches.d));
    const { stores, runtime } = await lineRuntime();

    expect(await own(machine, plane, { runtime })).toBe(0);

    const settle = plane.settles[0]?.body;
    expect(settle?.composition?.ranges.map((range) => range.program)).toEqual([world.programs.c]);
    // The conflicting range is not parked at once: it is held behind its own repairs.
    expect(settle?.held?.map((entry) => entry.program)).toEqual([world.programs.d]);
    const parked = plane.settles.flatMap((entry) => entry.body.parked);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.ranges.map((range) => range.program)).toEqual([world.programs.d]);
    expect(parked[0]?.reason).toMatch(/the merge conflicted in shared\.txt/);
    expect(parked[0]?.reason).toContain("no worker environment in this test");

    expect(plane.record.parked).toHaveLength(1);
    expect(git(world.origin, "show", `${world.head(LINE)}:shared.txt`)).toBe("from c");

    // Each repair is a job of the line's run with its decision, authored by the composer.
    const jobs = (await stores.jobContracts.listByRun(f.scope)).items;
    expect(jobs.map((job) => job.repair?.cause)).toEqual([
      "line_conflict",
      "line_conflict",
      "line_conflict",
    ]);
    const decisions = (await stores.decisions.listByRun(f.scope)).items;
    expect(decisions.map((decision) => decision.decisionId).sort()).toEqual(
      jobs.map((job) => job.repair?.decisionId).sort(),
    );
    const agents = await stores.agents.listByNode(f.scope, f.rootNodeId);
    expect(agents.filter((agent) => agent.role === "orchestrator")).toHaveLength(1);
    expect(decisions.every((decision) => decision.agentId === agents[0]?.agentId)).toBe(true);
    expect((await stores.checkpoints.listByRun(f.scope)).items).toHaveLength(1);
  });
});

describe("idling and stopping", () => {
  it("keeps beating while the queue is empty, then completes the run and ends stopped with no failure", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    const { stores, runtime } = await lineRuntime();
    expect(
      await own(machine, plane, {
        idleSeconds: 4,
        runtime,
      }),
    ).toBe(0);
    const beat = lastBeat(plane);
    expect(beat?.body.report).toBe("stopped");
    expect(beat?.body.failure).toBeUndefined();
    expect((await stores.runs.get(f.scope, f.scope.runId))?.status).toBe("succeeded");
    const running = plane.heartbeats.find((entry) => entry.body.report === "running");
    expect((beat?.at ?? 0) - (running?.at ?? 0)).toBeGreaterThanOrEqual(4000);
    expect(plane.heartbeats.length).toBeGreaterThan(2);
  });

  it("restarts the idle clock when work arrives", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    // Work arrives on the fifth read of the line, inside the idle period.
    const read = plane.line;
    plane.line = async () => {
      const view = await read();
      if (plane.reads === 5) plane.enqueue(world.programs.a, world.head(world.branches.a));
      return view;
    };
    expect(await own(machine, plane, { idleSeconds: 4 })).toBe(0);
    const settled = plane.settles[0];
    expect(settled).toBeDefined();
    expect((lastBeat(plane)?.at ?? 0) - (settled?.at ?? 0)).toBeGreaterThanOrEqual(4000);
    expect(lastBeat(plane)?.body.failure).toBeUndefined();
  });

  it("ends promptly when a heartbeat answers stop", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine, {
      respond: (count) => (count >= 6 ? { stop: true, status: "stopping" } : {}),
    });
    expect(await own(machine, plane, { idleSeconds: 3_600 })).toBe(0);
    const reads = plane.reads;
    await ticks(20);
    expect(plane.reads).toBe(reads);
    expect(lastBeat(plane)?.body.report).toBe("stopped");
  });

  it("exits non-zero when the lease is lost", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine, {
      respond: (count) => (count >= 2 ? "throw" : {}),
    });
    expect(await own(machine, plane, { idleSeconds: 3_600 })).not.toBe(0);
  });
});

describe("a replacement generation", () => {
  it("waits for the old generation's push, then takes the held batch and composes it", async () => {
    const machine = lineMachine();
    const aHead = world.head(world.branches.a);
    const oldPush = world.head("main");
    const plane = makePlane(world, machine, {
      resolveAfterReads: 5,
      record: {
        batch: {
          batchId: "comp_held",
          entries: [
            { program: world.programs.a, upTo: aHead, enqueuedAt: "2026-10-01T11:00:00.000Z" },
          ],
          takenAt: "2026-10-01T11:00:00.000Z",
          generation: 1,
        },
        push: {
          head: oldPush,
          expectedPredecessor: oldPush,
          bundleKey: "bundles/old",
          generation: 1,
          status: "pending",
          requestedAt: "2026-10-01T11:00:00.000Z",
        },
      },
    });

    expect(await own(machine, plane)).toBe(0);

    const resolved = plane.events.indexOf("old-push-resolved");
    const taken = plane.events.indexOf("takeBatch");
    expect(resolved).toBeGreaterThanOrEqual(0);
    expect(taken).toBeGreaterThan(resolved);
    expect(plane.settles[0]?.body.batchId).toBe("comp_held");
    expect(plane.settles[0]?.body.composition?.ranges[0]?.upTo).toBe(aHead);
    expect(git(world.origin, "show", `${world.head(LINE)}:a.txt`)).toBe("a");
  });
});

describe("a replacement generation over held ranges only", () => {
  it("releases what the previous owner held, composes it, and ends idle", async () => {
    const machine = lineMachine();
    const aHead = world.head(world.branches.a);
    const plane = makePlane(world, machine, {
      record: {
        held: [{ program: world.programs.a, upTo: aHead, enqueuedAt: "2026-10-01T11:00:00.000Z" }],
        heldBy: GENERATION - 1,
      },
    });

    expect(await own(machine, plane, { idleSeconds: 4 })).toBe(0);

    expect(plane.events).toContain("takeBatch");
    expect(plane.settles[0]?.body.composition?.ranges[0]?.upTo).toBe(aHead);
    expect(plane.record.held).toEqual([]);
    expect(lastBeat(plane)?.body.report).toBe("stopped");
  });

  it("ends idle when held ranges do not come back", async () => {
    const machine = lineMachine();
    const aHead = world.head(world.branches.a);
    // Held by this very generation, with no composer holding them: takeBatch gives nothing back.
    const plane = makePlane(world, machine, {
      record: {
        held: [{ program: world.programs.a, upTo: aHead, enqueuedAt: "2026-10-01T11:00:00.000Z" }],
        heldBy: GENERATION,
      },
    });

    expect(await own(machine, plane, { idleSeconds: 4 })).toBe(0);
    expect(lastBeat(plane)?.body.report).toBe("stopped");
  });
});

describe("project code runs as the project user (D-P10-30)", () => {
  it("wraps every setup and landing step, and reclaims what it granted", async () => {
    const machine = lineMachine();
    const plane = makePlane(world, machine);
    plane.enqueue(world.programs.a, world.head(world.branches.a));
    expect(await own(machine, plane, { asProject: true })).toBe(0);

    const trace = plane.events.filter((e) => /^(grant|reclaim):/.test(e));
    const rootOf = (event: string): string => event.replace(/^[a-z]+:/, "");
    // Every grant of a worktree root (the scratch is a deeper path) is reclaimed after it.
    for (const grant of trace.filter((e) => e.startsWith("grant:"))) {
      expect(trace.slice(trace.indexOf(grant) + 1)).toContain(`reclaim:${rootOf(grant)}`);
    }
    // Setup and landing steps were handed to `sudo -u project`, not run as the engine: the
    // sandbox has no such user, so each failed on the wrapper, and the composition parked.
    const parked = JSON.stringify(plane.settles.map((entry) => entry.body.parked));
    expect(parked).toMatch(/sudo/);
  });
});
