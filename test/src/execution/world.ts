/**
 * The world an execution-layer test runs in.
 *
 * Everything real except the model:
 *
 * - a **real HTTP control plane** on loopback, running the production handler,
 *   so every route, every schema and every domain rule is in the loop. The
 *   execution layer reaches it through `@nightshift/persistence/http`, exactly as
 *   it does in production — never through the in-memory stores directly, which
 *   would skip referential integrity, the transition tables and the evidence
 *   rule that makes `implemented ≠ verified` structural;
 * - a **real git repository** in a temporary directory, with real worktrees;
 * - a **real verification runner**, running real child processes;
 * - and a fake harness, because the one thing a test must not need is an LLM.
 *
 * This lives in `test/` rather than in `packages/execution` because the layer
 * table lets `test` reference what its suites drive (D-P3-12) and quite rightly
 * does not let `execution` reference `apps/api`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalControlPlane, startLocalControlPlane } from "@nightshift/api/testing";
import type { Agent, CommitSha, ProgramContract, Project } from "@nightshift/contracts";
import {
  createSteppingClock,
  createUlidIdGenerator,
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
} from "@nightshift/execution";
import type { Harness } from "@nightshift/harness";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";

export const PROGRAM_BRANCH = "program/slice";
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

export interface World {
  readonly plane: LocalControlPlane;
  readonly backing: InMemoryStores;
  readonly stores: ProjectStores;
  readonly environment: ExecutionEnvironment;
  readonly session: RunSession;
  readonly repo: string;
  readonly stateDir: string;
  readonly outbox: EventOutbox;
  readonly ids: IdGenerator;
  readonly git: GitRunner;
  readonly scope: RunScope;
  readonly baseCommit: CommitSha;
  /** Numbers every event appended so far, imitating the Streams consumer (A-22). */
  settle(): void;
  close(): Promise<void>;
}

export interface WorldOptions {
  readonly harness: Harness;
  /** Overrides merged into the fixture program contract. */
  readonly program?: Partial<ProgramContract>;
  readonly verificationTimeoutMs?: number;
}

const cleanups: (() => Promise<void>)[] = [];

/** Torn down by the suite's `afterEach`, whether or not the test passed. */
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

export const createWorld = async (options: WorldOptions): Promise<World> => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-slice-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  await mkdir(repo, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFixture(repo);

  const runner = nodeGitRunner;
  const run = (args: readonly string[]) => git(runner, args, { cwd: repo, atMs: START_MS });
  await run(["init", "--initial-branch=main"]);
  await run(["add", "-A"]);
  await run(["commit", "-m", "the fixture repository"]);
  await run(["checkout", "-b", PROGRAM_BRANCH]);

  // --- The control plane -----------------------------------------------------
  const backing = createInMemoryStores({ deferSequencing: true });
  const ids = createUlidIdGenerator();
  const subject = "11111111-2222-3333-4444-555555555555";
  const orgId = ids.next("org");
  await backing.memberships.put(makeMembership(subject as never, orgId));

  const clock = createSteppingClock(START_MS, 1_000);
  const plane = await startLocalControlPlane({
    stores: backing,
    claims: { sub: subject, "custom:active_org": orgId },
    clock,
  });
  const transport = createFetchTransport({
    endpoint: plane.url,
    tokens: staticTokenProvider("ignored-by-the-local-plane"),
  });
  const stores = createHttpStores({ transport, actingOrg: orgId });
  const bodies = createHttpArtifactBodyStore({
    transport,
    // The plane holds bodies in memory; a reader for assertions about a log.
    read: async (scope, artifactId) =>
      plane.bodies.get(`${scope.projectId}/${scope.programId}/${scope.runId}/${artifactId}`)?.body,
  });

  // --- The project and the program -------------------------------------------
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
    schemaVersion: 1,
    projectId,
    programId,
    objective: "Prove the vertical slice.",
    repository: { url: repo, baseBranch: "main", programBranch: PROGRAM_BRANCH },
    successCriteria: [{ id: "SC-01", outcome: "The sum helper works." }],
    constraints: ["Change nothing outside src/."],
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
    createdAt: nowIso(clock),
    ...options.program,
  };

  // --- The run, through the function the CLI and `run.start` share ------------
  const started = await startRun({ stores, clock, ids, git: runner }, { program, repoPath: repo });
  const scope: RunScope = {
    projectId,
    programId,
    runId: started.run.runId,
  };
  await stores.runs.put({ ...started.run, status: "running" });

  // --- The orchestrator's own agent -------------------------------------------
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
  await stores.executionNodes.put({
    ...started.rootNode,
    status: "queued",
    updatedAt: nowIso(clock),
  });
  await stores.executionNodes.put({
    ...started.rootNode,
    status: "running",
    updatedAt: nowIso(clock),
  });

  const outbox = createEventOutbox({
    events: stores.events,
    scope,
    clock,
    ids,
    writerId: orchestrator.agentId,
    initialDelayMs: 1,
    maxDelayMs: 4,
  });

  const paths: LocalPaths = {
    worktree: (runId, nodeId) => join(stateDir, "wt", runId.slice(-8), nodeId.slice(-8)),
    runDir: (runId) => join(stateDir, "runs", runId),
    spool: (runId) => join(stateDir, "runs", runId, "spool.ndjson"),
    transcript: (runId, agentId) =>
      join(stateDir, "runs", runId, "agents", agentId, "transcript.jsonl"),
  };

  const environment: ExecutionEnvironment = {
    stores,
    bodies,
    harness: options.harness,
    clock,
    ids,
    paths,
    git: runner,
    outbox,
    verificationTimeoutMs: options.verificationTimeoutMs ?? 60_000,
    cancelGraceMs: 2_000,
  };

  const session: RunSession = {
    scope,
    program: started.program,
    run: { ...started.run, status: "running" },
    rootNodeId: started.rootNode.executionNodeId,
    orchestratorAgentId: orchestrator.agentId,
    repoPath: repo,
  };

  const world: World = {
    plane,
    backing,
    stores,
    environment,
    session,
    repo,
    stateDir,
    outbox,
    ids,
    git: runner,
    scope,
    baseCommit: started.baseCommit as CommitSha,
    settle: () => void backing.materializeSequences(),
    close: async () => {
      await plane.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  cleanups.push(world.close);
  return world;
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
