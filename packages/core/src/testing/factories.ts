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
  type Decision,
  DecisionSchema,
  type Event,
  EventSchema,
  type ExecutionNode,
  type ExecutionNodeId,
  ExecutionNodeSchema,
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
 * Builds one fixture world.
 *
 * Beware: a counting generator restarts at 1, so two independent
 * `createFixtures()` calls mint the *same* identifiers. When a test needs two
 * distinguishable worlds — proving Project A cannot see Project B, for instance —
 * use {@link createFixturePair}, or pass both calls one shared generator.
 */
export const createFixtures = (ids: IdGenerator = createCountingIdGenerator()): Fixtures => {
  const scope: RunScope = {
    projectId: ids.next("proj"),
    programId: ids.next("prog"),
    runId: ids.next("run"),
  };
  return { ids, scope, rootNodeId: ids.next("node") };
};

/**
 * Two fixture worlds guaranteed to share no identifier, drawn from one generator.
 * This is the shape isolation tests want: everything about `b` differs from `a`.
 */
export const createFixturePair = (
  ids: IdGenerator = createCountingIdGenerator(),
): readonly [Fixtures, Fixtures] => [createFixtures(ids), createFixtures(ids)];

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
    successCriteria: [{ id: "SC-01", outcome: "It works." }],
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

export const FIXTURE_TIMESTAMP = AT;
