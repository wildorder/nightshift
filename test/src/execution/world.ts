/**
 * The world an execution-layer or MCP test runs in.
 *
 * Everything real except the model:
 *
 * - a **real HTTP control plane** on loopback, running the production handler,
 *   so every route, every schema and every domain rule is in the loop. Reached
 *   through `@nightshift/persistence/http`, exactly as in production — never
 *   through the in-memory stores directly, which would skip referential
 *   integrity, the transition tables and the evidence rule that makes
 *   `implemented ≠ verified` structural;
 * - a **real git repository** in a temporary directory, with real worktrees;
 * - a **real verification runner**, running real child processes;
 * - and a fake harness, because the one thing a test must not need is an LLM.
 *
 * This lives in `test/` rather than in `packages/execution` because the layer
 * table lets `test` reference what its suites drive (D-P3-12) and quite rightly
 * does not let `execution` reference `apps/api`.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalControlPlane, startLocalControlPlane } from "@nightshift/api/testing";
import type {
  Agent,
  CommitSha,
  ProgramContract,
  ProgramId,
  Project,
  ProjectId,
} from "@nightshift/contracts";
import {
  createSteppingClock,
  createUlidIdGenerator,
  type ExecutionTokenMinter,
  type IdGenerator,
  type LocalPaths,
  makeMembership,
  nowIso,
  type ProjectStores,
  type RunScope,
} from "@nightshift/core";
import {
  createEventOutbox,
  type EventOutbox,
  type ExecutionEnvironment,
  type GitRunner,
  git,
  nodeGitRunner,
  type RunSession,
  startRun,
  type WorkerEnvironment,
  type WorkerLaunchIdentity,
} from "@nightshift/execution";
import type { Harness } from "@nightshift/harness";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpExecutionTokenMinter,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";

export const PROGRAM_BRANCH = "program/slice";
/** Where a repository declares which program it belongs to. */
export const CONTRACT_FILE = "nightshift.program.json";
const START_MS = Date.parse("2026-09-15T12:00:00.000Z");

/** Files the fixture repository starts with. Small, and enough to edit. */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  ".gitignore": "node_modules/\n",
  "src/math.js": "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n",
  "src/index.js": 'export { sum } from "./math.js";\n',
  "test/math.test.js": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { sum } from "../src/math.js";',
    "",
    'test("sum adds", () => {',
    "  assert.equal(sum([1, 2, 3]), 6);",
    "});",
    "",
  ].join("\n"),
  "package.json": `${JSON.stringify({ name: "slice-fixture", private: true, type: "module" }, null, 2)}\n`,
};

/**
 * The fixture Program Contract.
 *
 * The verification step is bare `node --test`, with no path, deliberately: on
 * Node 22.22.0 passing a directory makes Node resolve it as a module and fail,
 * while bare `node --test` discovers the test files itself. Learned by watching
 * a correct worker produce a red verification, and worth keeping in one place.
 */
const fixtureProgram = (
  projectId: ProjectId,
  programId: ProgramId,
  repo: string,
  createdAt: string,
): ProgramContract => ({
  schemaVersion: 1,
  projectId,
  programId,
  objective: "Prove the vertical slice.",
  repository: { url: repo, baseBranch: "main", programBranch: PROGRAM_BRANCH },
  successCriteria: [{ id: "SC-01", outcome: "The sum helper works." }],
  constraints: ["Change nothing outside src/ and test/."],
  scope: {
    includes: ["src/**", "test/**"],
    excludes: ["src/generated/**"],
    permissions: ["fs.read", "fs.write", "shell.exec"],
    forbiddenActions: ["push any ref"],
  },
  verification: [
    { id: "test", command: "node --test" },
    { id: "shape", command: 'node -e "process.exit(0)"' },
  ],
  modelPolicy: {
    allowedProviders: ["anthropic"],
    allowedModels: ["claude-sonnet-5"],
    forbiddenModels: [],
  },
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
  delegationLimits: { maxDepth: 1, maxConcurrency: 1 },
  costPolicy: {},
  defaultRisk: "low",
  createdAt,
});

const cleanups: (() => Promise<void>)[] = [];

/** Torn down by a suite's `afterEach`, whether or not the test passed. */
export const cleanupWorlds = async (): Promise<void> => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
};

const writeFixture = async (repo: string): Promise<void> => {
  for (const [path, content] of Object.entries(FIXTURE_FILES)) {
    const full = join(repo, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
};

export interface BaseWorld {
  readonly root: string;
  readonly repo: string;
  readonly stateDir: string;
  readonly plane: LocalControlPlane;
  readonly backing: InMemoryStores;
  readonly stores: ProjectStores;
  readonly bodies: ReturnType<typeof createHttpArtifactBodyStore>;
  /** Mints a worker's execution token, as the orchestrator's session does (P4). */
  readonly tokens: ExecutionTokenMinter;
  readonly ids: IdGenerator;
  readonly clock: ReturnType<typeof createSteppingClock>;
  readonly subject: string;
  /** The authored contract, written to the repository and committed. */
  readonly program: ProgramContract;
  readonly git: GitRunner;
  close(): Promise<void>;
}

export interface BaseWorldOptions {
  readonly program?: Partial<ProgramContract>;
}

/**
 * A repository with an authored, committed program contract, and a control
 * plane that knows about its project.
 *
 * The contract file is committed **before** anything starts, because that is how
 * a real one exists: a human authors it, commits it, and runs `nightshift run`.
 * An uncommitted contract file would also leave the checkout dirty, and a dirty
 * checkout refuses integration — correct behaviour, and a very confusing way for
 * a test to fail.
 */
export const createBaseWorld = async (options: BaseWorldOptions = {}): Promise<BaseWorld> => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-slice-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  await mkdir(repo, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFixture(repo);

  const backing = createInMemoryStores({ deferSequencing: true });
  const ids = createUlidIdGenerator();
  const subject = "11111111-2222-3333-4444-555555555555";
  const orgId = ids.next("org");
  await backing.memberships.put(makeMembership(subject as never, orgId));

  const clock = createSteppingClock(START_MS, 1_000);
  const plane = await startLocalControlPlane({
    stores: backing,
    principal: { kind: "user", userId: subject as never, activeOrg: orgId },
    clock,
  });
  const transport = createFetchTransport({
    endpoint: plane.url,
    tokens: staticTokenProvider("ignored-by-the-local-plane"),
  });
  const stores = createHttpStores({ transport, actingOrg: orgId });
  // The orchestrator's session mints a worker's token, through the real route
  // against the real signer (P4, D-P4-06).
  const tokens = createHttpExecutionTokenMinter({ transport });
  const bodies = createHttpArtifactBodyStore({
    transport,
    read: async (scope, artifactId) =>
      plane.bodies.get(`${scope.projectId}/${scope.programId}/${scope.runId}/${artifactId}`)?.body,
  });

  const projectId = ids.next("proj");
  const programId = ids.next("prog");
  const project: Project = {
    schemaVersion: 1,
    projectId,
    orgId,
    name: "slice-fixture",
    createdAt: nowIso(clock),
  };
  await stores.projects.put(project);

  const program: ProgramContract = {
    ...fixtureProgram(projectId, programId, repo, nowIso(clock)),
    ...options.program,
  };
  await writeFile(join(repo, CONTRACT_FILE), `${JSON.stringify(program, null, 2)}\n`, "utf8");

  const run = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: repo, atMs: START_MS });
  await run(["init", "--initial-branch=main"]);
  await run(["add", "-A"]);
  await run(["commit", "-m", "the fixture repository"]);
  await run(["checkout", "-b", PROGRAM_BRANCH]);

  const base: BaseWorld = {
    root,
    repo,
    stateDir,
    plane,
    backing,
    stores,
    bodies,
    tokens,
    ids,
    clock,
    subject,
    program,
    git: nodeGitRunner,
    close: async () => {
      await plane.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  cleanups.push(base.close);
  return base;
};

/**
 * A worker's environment, as the composition root builds it: stores and an
 * outbox over a transport holding the worker's execution token, and nothing else.
 */
export const workerEnvironmentIn =
  (base: BaseWorld) =>
  (launch: WorkerLaunchIdentity): WorkerEnvironment => {
    const stores = createHttpStores({
      transport: createFetchTransport({
        endpoint: base.plane.url,
        tokens: staticTokenProvider(launch.executionToken),
      }),
    });
    return {
      stores,
      clock: base.clock,
      git: nodeGitRunner,
      outbox: createEventOutbox({
        events: stores.events,
        scope: {
          projectId: launch.projectId,
          programId: launch.programId,
          runId: launch.runId,
        } as RunScope,
        clock: base.clock,
        ids: base.ids,
        writerId: launch.agentId,
        initialDelayMs: 1,
        maxDelayMs: 4,
      }),
    };
  };

/** Paths under a world's own state directory, never the program checkout. */
export const localPathsIn = (stateDir: string): LocalPaths => ({
  worktree: (runId, nodeId) => join(stateDir, "wt", runId.slice(-8), nodeId.slice(-8)),
  runDir: (runId) => join(stateDir, "runs", runId),
  spool: (runId) => join(stateDir, "runs", runId, "spool.ndjson"),
  transcript: (runId, agentId) =>
    join(stateDir, "runs", runId, "agents", agentId, "transcript.jsonl"),
  scratch: (checkout) =>
    join(stateDir, "t", createHash("sha256").update(checkout).digest("hex").slice(0, 12)),
});

export interface World extends BaseWorld {
  readonly environment: ExecutionEnvironment;
  readonly session: RunSession;
  readonly outbox: EventOutbox;
  readonly scope: RunScope;
  readonly baseCommit: CommitSha;
  /** Numbers every event appended so far, imitating the Streams consumer (A-22). */
  settle(): void;
}

export interface WorldOptions extends BaseWorldOptions {
  readonly harness: Harness;
  readonly verificationTimeoutMs?: number;
  /** The gates a red base failed: the run starts with `gate.red` (P15, D-P15-03). */
  readonly red?: readonly string[];
}

/** A base world with a started, attached run — what the execution tests drive. */
export const createWorld = async (options: WorldOptions): Promise<World> => {
  const base = await createBaseWorld(
    options.program === undefined ? {} : { program: options.program },
  );
  const { repo, stateDir, stores, bodies, ids, clock, program } = base;

  const started = await startRun(
    { stores, clock, ids, git: nodeGitRunner },
    { program, repoPath: repo, ...(options.red === undefined ? {} : { red: options.red }) },
  );
  const scope: RunScope = {
    projectId: program.projectId,
    programId: program.programId,
    runId: started.run.runId,
  };
  await stores.runs.put({ ...started.run, status: "running" });

  const orchestrator: Agent = {
    schemaVersion: 1,
    ...scope,
    agentId: ids.next("agent"),
    executionNodeId: started.rootNode.executionNodeId,
    role: "orchestrator",
    harness: "test",
    provider: "test",
    model: "test",
    status: "created",
    createdAt: nowIso(clock),
  };
  await stores.agents.put(orchestrator);
  // The root node follows the table: `validated` when the run was authorized,
  // then queued and started when an orchestrator attaches. The API refuses the
  // single-step shortcut, which is how we know the table is in the loop.
  for (const status of ["queued", "running"] as const) {
    await stores.executionNodes.put({ ...started.rootNode, status, updatedAt: nowIso(clock) });
  }

  const outbox = createEventOutbox({
    events: stores.events,
    scope,
    clock,
    ids,
    writerId: orchestrator.agentId,
    initialDelayMs: 1,
    maxDelayMs: 4,
  });

  const environment: ExecutionEnvironment = {
    stores,
    bodies,
    tokens: base.tokens,
    harness: options.harness,
    clock,
    ids,
    paths: localPathsIn(stateDir),
    git: nodeGitRunner,
    outbox,
    workerEnvironment: workerEnvironmentIn(base),
    verificationTimeoutMs: options.verificationTimeoutMs ?? 60_000,
    cancelGraceMs: 2_000,
  };

  return {
    ...base,
    environment,
    outbox,
    scope,
    baseCommit: started.baseCommit as CommitSha,
    settle: () => {
      base.backing.materializeSequences();
    },
    session: {
      scope,
      program: started.program,
      run: { ...started.run, status: "running" },
      rootNodeId: started.rootNode.executionNodeId,
      orchestratorAgentId: orchestrator.agentId,
      repoPath: repo,
    },
  };
};

/** Every event of the run, numbered, in order. */
export const eventsOf = async (world: World) => {
  world.settle();
  const page = await world.stores.events.listByRun(world.scope);
  return page.items;
};

/** The event types of the run, in order, for an assertion about the lifecycle. */
export const eventTypesOf = async (world: World): Promise<readonly string[]> =>
  (await eventsOf(world)).map((event) => event.type);
