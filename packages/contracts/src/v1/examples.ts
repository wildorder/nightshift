/**
 * One valid, documented example per aggregate.
 *
 * These are fixture data, not test files, so downstream conformance suites
 * (T7's persistence port conformance, P2's isolation tests) can round-trip a
 * known-good record without each package inventing its own. They double as the
 * documented valid example each schema is asserted to accept.
 *
 * Every example belongs to the same project, program and run, so a test that
 * needs a coherent graph gets one for free. Project B fixtures for isolation
 * tests are derived by overriding `projectId`.
 */
import type { AggregateName } from "./registry.js";

const ULID_A = "01HF7YAT00GGGGGGGGGGGGGGGG";
const ULID_B = "01HF7YAT01GGGGGGGGGGGGGGGG";
const ULID_C = "01HF7YAT02GGGGGGGGGGGGGGGG";
const ULID_D = "01HF7YAT03GGGGGGGGGGGGGGGG";

export const EXAMPLE_IDS = {
  orgId: `org_${ULID_A}`,
  projectId: `proj_${ULID_A}`,
  programId: `prog_${ULID_A}`,
  runId: `run_${ULID_A}`,
  rootNodeId: `node_${ULID_A}`,
  jobNodeId: `node_${ULID_B}`,
  jobContractId: `job_${ULID_A}`,
  workerAgentId: `agent_${ULID_A}`,
  examinerAgentId: `agent_${ULID_B}`,
  decisionId: `dec_${ULID_A}`,
  checkpointBeforeId: `ckpt_${ULID_A}`,
  checkpointAfterId: `ckpt_${ULID_B}`,
  verificationId: `ver_${ULID_A}`,
  examinationId: `exam_${ULID_A}`,
  routingDecisionId: `route_${ULID_A}`,
  artifactId: `art_${ULID_A}`,
  logArtifactId: `art_${ULID_B}`,
  eventId: `evt_${ULID_A}`,
} as const;

const AT = "2026-09-13T12:00:00.000Z";
const AT_LATER = "2026-09-13T12:05:00.000Z";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const projectScope = {
  includes: ["src/**"],
  excludes: ["src/generated/**"],
  permissions: ["fs.read", "fs.write", "shell.exec"],
  forbiddenActions: ["deploy to production"],
};

const examinationRequirement = {
  required: true,
  mustDifferModel: true,
  mustDifferProvider: false,
  blockOnMaterialFindings: true,
};

/**
 * Valid examples keyed by aggregate name. Typed as `unknown` on purpose: these
 * exist to be fed through the schemas, and typing them as the parsed output
 * would let a drifting example typecheck against a stale shape.
 */
export const AGGREGATE_EXAMPLES: { readonly [K in AggregateName]: unknown } = {
  Project: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    orgId: EXAMPLE_IDS.orgId,
    name: "example-app",
    description: "Fixture project used by contract and conformance tests.",
    crossAccount: {
      roleArn: "arn:aws:iam::123456789012:role/nightshift-workload",
      externalId: "nightshift-7Hq2-Xv9P-kR4m",
    },
    createdAt: AT,
  },

  ProgramContract: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    objective: "Add tenant-aware billing.",
    repository: {
      url: "https://github.com/example/example-app.git",
      baseBranch: "main",
      programBranch: "program/tenant-billing",
    },
    successCriteria: [
      { id: "SC-01", outcome: "Tenant billing data is isolated." },
      { id: "SC-02", outcome: "Existing customers remain compatible." },
    ],
    constraints: ["No production deployment.", "Database migrations must be reversible."],
    scope: projectScope,
    verification: [
      { id: "build", command: "npm run build" },
      { id: "test", command: "npm test", description: "Unit and integration suites." },
    ],
    modelPolicy: {
      allowedProviders: ["anthropic", "openai", "bedrock"],
      allowedModels: [],
      forbiddenModels: [],
    },
    examinationPolicy: {
      low: { ...examinationRequirement, required: false, mustDifferModel: false },
      medium: examinationRequirement,
      high: { ...examinationRequirement, mustDifferProvider: true },
    },
    delegationLimits: { maxDepth: 3, maxConcurrency: 8 },
    costPolicy: { maxUsd: 50, maxWallClockSeconds: 21_600 },
    defaultRisk: "medium",
    createdAt: AT,
  },

  Run: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    status: "running",
    location: "local",
    rootNodeId: EXAMPLE_IDS.rootNodeId,
    startedAt: AT,
  },

  ExecutionNode: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    kind: "job",
    parentNodeId: EXAMPLE_IDS.rootNodeId,
    depth: 1,
    scope: {
      includes: ["src/billing/**"],
      excludes: ["src/generated/**"],
      permissions: ["fs.read", "fs.write"],
      forbiddenActions: ["deploy to production", "change public API"],
    },
    status: "verified",
    jobContractId: EXAMPLE_IDS.jobContractId,
    commitSha: COMMIT,
    createdAt: AT,
    updatedAt: AT_LATER,
  },

  JobContract: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    jobContractId: EXAMPLE_IDS.jobContractId,
    objective: "Add tenant ownership to invoice persistence.",
    scope: { includes: ["src/billing/**"], excludes: ["src/generated/**"] },
    acceptance: [
      "Existing invoices remain readable.",
      "New invoices require tenant ownership.",
      "Migration rollback succeeds.",
    ],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: AT,
  },

  Agent: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    agentId: EXAMPLE_IDS.workerAgentId,
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    role: "worker",
    harness: "claude",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: "completed",
    startedAt: AT,
    endedAt: AT_LATER,
    exitCode: 0,
    createdAt: AT,
  },

  Decision: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    decisionId: EXAMPLE_IDS.decisionId,
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    agentId: EXAMPLE_IDS.workerAgentId,
    context: "Invoices need a tenant owner, and existing rows have none.",
    alternatives: [
      { summary: "Backfill a default tenant.", rejectedBecause: "Silently mislabels old data." },
      { summary: "Make the column nullable and require it for new rows." },
    ],
    choice: "Make the column nullable and require it for new rows.",
    rationale: "Preserves readability of existing invoices while enforcing the new invariant.",
    reversibility: "compensatable",
    checkpointBefore: EXAMPLE_IDS.checkpointBeforeId,
    checkpointAfter: EXAMPLE_IDS.checkpointAfterId,
    affectedNodes: [EXAMPLE_IDS.jobNodeId],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: AT,
  },

  Checkpoint: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    checkpointId: EXAMPLE_IDS.checkpointBeforeId,
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    commitSha: COMMIT,
    ref: "refs/nightshift/checkpoints/ckpt-a",
    label: "before tenant ownership decision",
    createdAt: AT,
  },

  Verification: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    verificationId: EXAMPLE_IDS.verificationId,
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    jobContractId: EXAMPLE_IDS.jobContractId,
    agentId: EXAMPLE_IDS.workerAgentId,
    commitSha: COMMIT,
    criterionId: "SC-01",
    commands: [
      { stepId: "build", command: "npm run build", exitCode: 0, durationMs: 12_000 },
      {
        stepId: "test",
        command: "npm test",
        exitCode: 0,
        durationMs: 45_000,
        logArtifactId: EXAMPLE_IDS.logArtifactId,
      },
    ],
    outcome: "passed",
    startedAt: AT,
    endedAt: AT_LATER,
  },

  Examination: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    examinationId: EXAMPLE_IDS.examinationId,
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    verificationId: EXAMPLE_IDS.verificationId,
    commitSha: COMMIT,
    implementerAgentId: EXAMPLE_IDS.workerAgentId,
    examinerAgentId: EXAMPLE_IDS.examinerAgentId,
    requiredByRisk: "medium",
    outcome: "findings_raised",
    findings: [
      {
        id: "F-01",
        severity: "minor",
        summary: "Migration lacks a down path for the new index.",
        evidence: "migrations/0007_tenant_owner.sql defines up only.",
        resolution: "unresolved",
      },
    ],
    reportArtifactId: EXAMPLE_IDS.artifactId,
    createdAt: AT_LATER,
  },

  RoutingDecision: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    routingDecisionId: EXAMPLE_IDS.routingDecisionId,
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    attempt: 1,
    eligibleOptions: [
      {
        target: { harness: "agentcore", provider: "bedrock", model: "cheap-bounded" },
        eligible: true,
      },
      {
        target: { harness: "claude", provider: "anthropic", model: "claude-fable-5-1" },
        eligible: false,
        reason: "Job is bounded, unambiguous and strongly testable; frontier not warranted.",
      },
    ],
    chosen: { harness: "agentcore", provider: "bedrock", model: "cheap-bounded" },
    ruleId: "bounded-unambiguous-testable",
    wasOverride: false,
    usage: { inputTokens: 18_000, outputTokens: 2_400, actualCostUsd: 0.04, latencyMs: 31_000 },
    outcome: "verified",
    previousRouteId: null,
    createdAt: AT,
  },

  Artifact: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    artifactId: EXAMPLE_IDS.artifactId,
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    kind: "verification-log",
    uri: `s3://nightshift-artifacts/${EXAMPLE_IDS.projectId}/${EXAMPLE_IDS.programId}/${EXAMPLE_IDS.runId}/verification.log`,
    sizeBytes: 84_213,
    contentType: "text/plain",
    createdAt: AT_LATER,
  },

  Event: {
    schemaVersion: 1,
    projectId: EXAMPLE_IDS.projectId,
    programId: EXAMPLE_IDS.programId,
    runId: EXAMPLE_IDS.runId,
    eventId: EXAMPLE_IDS.eventId,
    idempotencyKey: `${EXAMPLE_IDS.jobNodeId}:verification.completed:1`,
    sequence: 42,
    type: "verification.completed",
    source: "control-plane",
    executionNodeId: EXAMPLE_IDS.jobNodeId,
    agentId: EXAMPLE_IDS.workerAgentId,
    payload: { verificationId: EXAMPLE_IDS.verificationId, outcome: "passed" },
    occurredAt: AT_LATER,
    recordedAt: AT_LATER,
  },
};

/** A second project's identifier, for proving cross-project queries return nothing. */
export const OTHER_PROJECT_ID = `proj_${ULID_C}`;

/** A second run's identifier, for ordering and isolation fixtures. */
export const OTHER_RUN_ID = `run_${ULID_D}`;
