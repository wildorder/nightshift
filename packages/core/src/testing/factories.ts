/**
 * Deterministic builders for domain fixtures.
 *
 * Exported from `core` rather than hidden in a test file because every package
 * above this one needs the same fixtures, and duplicating them is how two
 * packages end up disagreeing about what a valid node looks like.
 *
 * Every builder parses through the contract schema, so a fixture can never drift
 * into a shape the contracts would reject.
 */
import {
  type Agent,
  AgentSchema,
  type Checkpoint,
  CheckpointSchema,
  type CommitSha,
  type ComputeUtilization,
  ComputeUtilizationSchema,
  type Decision,
  DecisionSchema,
  type Dispatch,
  DispatchSchema,
  type Event,
  EventSchema,
  type ExecutionNode,
  type ExecutionNodeId,
  ExecutionNodeSchema,
  type GateHealth,
  GateHealthSchema,
  type JobContract,
  JobContractSchema,
  type ProgramContract,
  ProgramContractSchema,
  type Project,
  ProjectSchema,
  type Run,
  RunSchema,
  type Scope,
  type Verification,
  VerificationSchema,
  type WarmCache,
  WarmCacheSchema,
} from "@nightshift/contracts";
import { createCountingIdGenerator, type IdGenerator } from "../ids.js";
import type { RunScope } from "../rules/ownership.js";

/** Anything a builder accepts: a partial override merged over the default. */
type Overrides<T> = Partial<Record<keyof T, unknown>>;

const AT = "2026-01-01T00:00:00.000Z";
const COMMIT_A = "1111111111111111111111111111111111111111";

export const FIXTURE_COMMIT: CommitSha = COMMIT_A as CommitSha;

export const FIXTURE_SCOPE: Scope = {
  includes: ["src/**"],
  excludes: ["src/generated/**"],
  permissions: ["fs.read", "fs.write", "shell.exec"],
  forbiddenActions: ["deploy to production"],
};

/**
 * A fixture world: one project, one program, one run, and a counting identifier
 * generator so every id in a test is stable and readable.
 */
export interface Fixtures {
  readonly ids: IdGenerator;
  readonly scope: RunScope;
  readonly rootNodeId: ExecutionNodeId;
}

/**
 * How many worlds this module has handed out. Each gets a disjoint identifier
 * range, so two independent `createFixtures()` calls never collide.
 *
 * An earlier version defaulted every world to a generator starting at 1, which
 * meant two "independent" worlds shared every identifier. That silently turned
 * isolation tests into tautologies, and it caught three separate tests — including
 * one written by the author of the warning comment — before the default was
 * changed. Deterministic per module load, which is what a test needs; the counter
 * resets with the module, and vitest loads each test file fresh.
 */
let worldsHandedOut = 0;

/** Identifier space reserved per world. Generous enough that no world overruns it. */
const WORLD_STRIDE = 1_000_000;

/**
 * Builds one fixture world with its own identifier range.
 *
 * Two calls yield two genuinely distinct worlds, which is what an isolation test
 * needs. Pass an explicit generator only when a test wants to control identifiers
 * exactly.
 */
export const createFixtures = (ids?: IdGenerator): Fixtures => {
  const generator = ids ?? createCountingIdGenerator(worldsHandedOut++ * WORLD_STRIDE);
  return createFixturesWith(generator);
};

const createFixturesWith = (ids: IdGenerator): Fixtures => {
  const scope: RunScope = {
    projectId: ids.next("proj"),
    programId: ids.next("prog"),
    runId: ids.next("run"),
  };
  return { ids, scope, rootNodeId: ids.next("node") };
};

/**
 * Two fixture worlds sharing no identifier.
 *
 * Since {@link createFixtures} now guarantees this on its own, this is kept only
 * because it reads clearly at the top of an isolation test. Passing a shared
 * generator still works and keeps both worlds in one identifier range.
 */
export const createFixturePair = (ids?: IdGenerator): readonly [Fixtures, Fixtures] =>
  ids === undefined
    ? [createFixtures(), createFixtures()]
    : [createFixturesWith(ids), createFixturesWith(ids)];

export const makeProject = (f: Fixtures, overrides: Overrides<Project> = {}): Project =>
  ProjectSchema.parse({
    schemaVersion: 1,
    projectId: f.scope.projectId,
    orgId: f.ids.next("org"),
    name: "fixture-project",
    createdAt: AT,
    ...overrides,
  });

export const makeProgramContract = (
  f: Fixtures,
  overrides: Overrides<ProgramContract> = {},
): ProgramContract =>
  ProgramContractSchema.parse({
    schemaVersion: 1,
    projectId: f.scope.projectId,
    programId: f.scope.programId,
    objective: "Fixture objective.",
    repository: {
      url: "https://example.invalid/repo.git",
      baseBranch: "main",
      programBranch: "program/fixture",
    },
    stories: [
      {
        id: "US-01",
        who: "A fixture user",
        problem: "Today the fixture does not work for them.",
        outcome: "Afterwards it does.",
      },
    ],
    successCriteria: [{ id: "SC-01", outcome: "It works.", serves: ["US-01"] }],
    constraints: [],
    scope: FIXTURE_SCOPE,
    verification: [{ id: "test", command: "npm test" }],
    modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
    examinationPolicy: {
      low: {
        required: false,
        mustDifferModel: false,
        mustDifferProvider: false,
        blockOnMaterialFindings: false,
      },
      medium: {
        required: true,
        mustDifferModel: true,
        mustDifferProvider: false,
        blockOnMaterialFindings: true,
      },
      high: {
        required: true,
        mustDifferModel: true,
        mustDifferProvider: true,
        blockOnMaterialFindings: true,
      },
    },
    delegationLimits: { maxDepth: 3, maxConcurrency: 4 },
    costPolicy: {},
    defaultRisk: "medium",
    createdAt: AT,
    ...overrides,
  });

export const makeRun = (f: Fixtures, overrides: Overrides<Run> = {}): Run =>
  RunSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    status: "running",
    location: "local",
    rootNodeId: f.rootNodeId,
    startedAt: AT,
    ...overrides,
  });

/** The root node of a run: a `program` at depth 0 with no parent. */
export const makeRootNode = (
  f: Fixtures,
  overrides: Overrides<ExecutionNode> = {},
): ExecutionNode =>
  ExecutionNodeSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    executionNodeId: f.rootNodeId,
    kind: "program",
    parentNodeId: null,
    depth: 0,
    scope: FIXTURE_SCOPE,
    status: "running",
    jobContractId: null,
    commitSha: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });

export const makeNode = (
  f: Fixtures,
  parentNodeId: ExecutionNodeId,
  overrides: Overrides<ExecutionNode> = {},
): ExecutionNode =>
  ExecutionNodeSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    executionNodeId: f.ids.next("node"),
    kind: "job",
    parentNodeId,
    depth: 1,
    scope: FIXTURE_SCOPE,
    status: "validated",
    jobContractId: null,
    commitSha: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });

export const makeJobContract = (f: Fixtures, overrides: Overrides<JobContract> = {}): JobContract =>
  JobContractSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    jobContractId: f.ids.next("job"),
    objective: "Fixture job.",
    scope: { includes: ["src/**"] },
    acceptance: ["It works."],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: AT,
    ...overrides,
  });

export const makeAgent = (
  f: Fixtures,
  executionNodeId: ExecutionNodeId,
  overrides: Overrides<Agent> = {},
): Agent =>
  AgentSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    agentId: f.ids.next("agent"),
    executionNodeId,
    role: "worker",
    harness: "claude",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: "created",
    createdAt: AT,
    ...overrides,
  });

/**
 * A passing verification for `node`. Pass `overrides` to build a failing one;
 * remember the contract cross-checks `outcome` against the exit codes.
 */
export const makeVerification = (
  f: Fixtures,
  node: ExecutionNode,
  overrides: Overrides<Verification> = {},
): Verification =>
  VerificationSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    verificationId: f.ids.next("ver"),
    executionNodeId: node.executionNodeId,
    jobContractId: node.jobContractId ?? f.ids.next("job"),
    agentId: f.ids.next("agent"),
    commitSha: node.commitSha ?? FIXTURE_COMMIT,
    commands: [{ stepId: "test", command: "npm test", exitCode: 0, durationMs: 1 }],
    outcome: "passed",
    startedAt: AT,
    endedAt: AT,
    ...overrides,
  });

/** A failing verification, with the exit code and outcome kept consistent. */
export const makeFailedVerification = (
  f: Fixtures,
  node: ExecutionNode,
  overrides: Overrides<Verification> = {},
): Verification =>
  makeVerification(f, node, {
    commands: [{ stepId: "test", command: "npm test", exitCode: 1, durationMs: 1 }],
    outcome: "failed",
    ...overrides,
  });

export const makeCheckpoint = (
  f: Fixtures,
  executionNodeId: ExecutionNodeId,
  overrides: Overrides<Checkpoint> = {},
): Checkpoint =>
  CheckpointSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    checkpointId: f.ids.next("ckpt"),
    executionNodeId,
    commitSha: FIXTURE_COMMIT,
    ref: "refs/nightshift/checkpoints/fixture",
    createdAt: AT,
    ...overrides,
  });

export const makeDecision = (
  f: Fixtures,
  executionNodeId: ExecutionNodeId,
  overrides: Overrides<Decision> = {},
): Decision =>
  DecisionSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    decisionId: f.ids.next("dec"),
    executionNodeId,
    agentId: null,
    context: "Fixture context.",
    alternatives: [{ summary: "Do nothing." }],
    choice: "Do something.",
    rationale: "Because.",
    reversibility: "reversible",
    checkpointBefore: f.ids.next("ckpt"),
    affectedNodes: [],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: AT,
    ...overrides,
  });

export const makeEvent = (f: Fixtures, overrides: Overrides<Event> = {}): Event =>
  EventSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    eventId: f.ids.next("evt"),
    idempotencyKey: `fixture-${f.ids.next("evt")}`,
    sequence: 0,
    type: "node.progress",
    source: "mcp",
    executionNodeId: null,
    agentId: null,
    payload: {},
    occurredAt: AT,
    recordedAt: AT,
    ...overrides,
  });

/** P10 (D-P10-18): a run's machine, freshly requested on `good`. */
export const makeDispatch = (f: Fixtures, overrides: Overrides<Dispatch> = {}): Dispatch =>
  DispatchSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    status: "requested",
    tier: "good",
    instanceType: "c8id.2xlarge",
    usdPerHour: 0.44352,
    amiVersion: "1.0.0",
    generation: 1,
    idempotencyKey: `${f.scope.runId}:${COMMIT_A}`,
    engineAgentId: f.ids.next("agent"),
    input: {
      repositoryUrl: "https://github.com/example/fixture",
      branch: "program/fixture",
      baseSha: COMMIT_A,
      planHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    attempts: [{ generation: 1, reason: "dispatch", startedAt: AT }],
    spend: { estimatedUsd: 4, meteredUsd: 0, meteredSeconds: 0 },
    publication: { intents: [] },
    cleanup: { volumeDeleted: false, failures: [] },
    requestedAt: AT,
    updatedAt: AT,
    ...overrides,
  });

/** P10 (D-P10-14b): a quiet run on `good`. */
export const makeComputeUtilization = (
  f: Fixtures,
  overrides: Overrides<ComputeUtilization> = {},
): ComputeUtilization =>
  ComputeUtilizationSchema.parse({
    schemaVersion: 1,
    ...f.scope,
    tier: "good",
    samples: 10,
    peakMemoryPct: 30,
    peakCpuPct: 40,
    cpuAbove90Pct: 0,
    peakDiskPct: 20,
    oomKills: 0,
    swapUsed: false,
    wallClockSeconds: 600,
    updatedAt: AT,
    ...overrides,
  });

/** P10 (D-P10-15): a project's warm snapshot with no history. */
export const makeWarmCache = (f: Fixtures, overrides: Overrides<WarmCache> = {}): WarmCache =>
  WarmCacheSchema.parse({
    schemaVersion: 1,
    projectId: f.scope.projectId,
    architecture: "x86_64",
    current: {
      snapshotId: "snap-fixture",
      amiVersion: "1.0.0",
      lockfileHashes: {},
      fromRunId: f.scope.runId,
      takenAt: AT,
    },
    history: [],
    updatedAt: AT,
    ...overrides,
  });

/** P15 (D-P15-07): a project's healthy gate-health record, audited by the program's planning. */
export const makeGateHealth = (f: Fixtures, overrides: Overrides<GateHealth> = {}): GateHealth =>
  GateHealthSchema.parse({
    schemaVersion: 1,
    projectId: f.scope.projectId,
    programId: f.scope.programId,
    commit: COMMIT_A,
    fingerprint: "0".repeat(64),
    verdict: "healthy",
    findings: [],
    machinery: ["package.json"],
    auditedBy: {
      kind: "user",
      userId: "fixture-operator",
      orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG",
    },
    auditedAt: AT,
    ...overrides,
  });

export const FIXTURE_TIMESTAMP = AT;
