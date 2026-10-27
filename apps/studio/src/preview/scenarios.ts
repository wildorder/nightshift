/**
 * Fixture worlds for the Studio preview (P20, S-04): the run page over
 * realistic records, so the measurement views can be designed and reviewed in
 * a real browser without a control plane.
 *
 * Each scenario seeds the in-memory stores it is given and says where the run
 * page is. They are hand-authored with the core factories (the engine-driven
 * world in `test/` is not reachable from the Studio) and every record parses
 * through its contract schema when the stores accept it.
 *
 * The clock is the `now` the caller passes, so a given `now` always yields the
 * same pixels. The `complete` run starts six hours before it.
 */
import {
  ExaminationSchema,
  type ExecutionNode,
  type MeasurementSummary,
  type OrgId,
  RunFeedbackSchema,
  type UserId,
} from "@nightshift/contracts";
import {
  createFixtures,
  type Fixtures,
  type IdGenerator,
  makeCompletionHistory,
  makeComputeUtilization,
  makeDecision,
  makeDispatch,
  makeGateHealth,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  type ProjectStores,
  type RunScope,
} from "@nightshift/core";
import type { InMemoryStores } from "@nightshift/persistence/memory";
import {
  agentOf,
  attemptOf,
  COMMIT,
  failingVerification,
  job,
  makeWorld,
  observe,
  passingVerification,
  sub,
  type World,
} from "./world.js";

/** Who is signed in to the preview, and so who a verdict is attributed to. */
export const PREVIEW_USER = "u1" as UserId;
export const PREVIEW_EMAIL = "reviewer@example.test";

export interface Seeded {
  readonly scope: RunScope;
  readonly orgId: OrgId;
  /** Stores to serve instead of the seeded ones (a scenario that makes reads fail or hang). */
  readonly stores?: ProjectStores;
}

export type Scenario = (
  stores: InMemoryStores,
  ids: IdGenerator,
  now: () => string,
) => Promise<Seeded>;

/** Where a run's page is in the Studio. */
export const runPath = (scope: RunScope): string =>
  `/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}`;

const HOUR = 3_600_000;
/** Minutes from the run's start to `now`, in the `complete` world. */
const SPAN_HOURS = 6;

const STRANDS = [
  {
    id: "S-01",
    name: "Invoice persistence",
    scope: {
      summary: "Invoices and their totals are stored.",
      includes: ["src/invoices/**"],
      excludes: [],
    },
    acceptance: ["Invoices persist across restarts.", "Totals match the line items."],
    successCriteria: ["SC-01"],
    dependsOn: [],
    prerequisites: [],
  },
  {
    id: "S-02",
    name: "Webhook delivery",
    scope: {
      summary: "Outbound webhooks are delivered once and retried.",
      includes: ["src/webhooks/**"],
      excludes: [],
    },
    acceptance: ["A webhook is delivered once.", "A failed delivery is retried."],
    successCriteria: ["SC-02"],
    dependsOn: [],
    prerequisites: [],
  },
] as const;

const VERIFICATION = [
  { id: "build", command: "npm run build" },
  { id: "test", command: "npm test" },
];

interface Basis {
  readonly f: Fixtures;
  readonly orgId: OrgId;
  readonly w: World;
}

/** The project, the program with its two strands, and the world the run's records go in. */
const seedProgram = async (
  stores: ProjectStores,
  ids: IdGenerator,
  startedAt: string,
  options: { strands: boolean; sparse?: boolean } = { strands: true },
): Promise<Basis> => {
  const f = createFixtures(ids);
  const orgId = ids.next("org");
  await stores.projects.put(makeProject(f, { orgId, name: "billing-service" }));
  await stores.programContracts.put(
    makeProgramContract(f, {
      objective: "Invoices persist, and webhooks about them are delivered exactly once.",
      successCriteria: [
        { id: "SC-01", outcome: "Invoices and their totals persist.", serves: ["US-01"] },
        { id: "SC-02", outcome: "Webhooks are delivered once and retried.", serves: ["US-01"] },
      ],
      stories: [
        {
          id: "US-01",
          who: "A shop owner",
          problem: "Invoices vanish on restart and a webhook can arrive twice.",
          outcome: "Invoices persist and each webhook is delivered once.",
        },
      ],
      verification: VERIFICATION,
      ...(options.strands ? { strands: STRANDS } : {}),
      costPolicy: { maxWallClockSeconds: 14_400 },
      createdAt: startedAt,
    }),
  );
  return { f, orgId, w: makeWorld(stores, f, startedAt) };
};

const startOf = (now: () => string, hours: number): string =>
  new Date(Date.parse(now()) - hours * HOUR).toISOString();

const actor = (orgId: OrgId) => ({ kind: "user", userId: PREVIEW_USER, orgId }) as const;

/** Stores a run's verdicts one revision at a time, as the people who gave them did. */
const putFeedback = async (
  stores: ProjectStores,
  f: Fixtures,
  orgId: OrgId,
  revisions: readonly { verdict: "worked" | "did_not_work" | null; at: string; commit?: string }[],
): Promise<void> => {
  const rows = revisions.map((r, i) => ({
    version: i + 1,
    verdict: r.verdict,
    actor: actor(orgId),
    recordedAt: r.at,
    ...(r.commit === undefined ? {} : { resultCommit: r.commit }),
  }));
  for (let i = 0; i < rows.length; i++) {
    const last = rows[i];
    await stores.feedback.put(
      RunFeedbackSchema.parse({
        ...f.scope,
        schemaVersion: 1,
        ...last,
        revisions: rows.slice(0, i + 1),
      }),
    );
  }
};

/**
 * The machine the run used, and how busy it was. A new dispatch is stored only
 * while its run is pending (D-07), so a caller seeds it before the run's final
 * record.
 */
const seedMachine = async (
  w: World,
  status: "running" | "stopped",
  from: number,
  to: number,
): Promise<void> => {
  const seconds = Math.round((to - from) * 60);
  await w.stores.dispatches.put(
    makeDispatch(w.f, {
      status,
      requestedAt: w.t(from - 2),
      updatedAt: w.t(to),
      attempts: [{ generation: 1, reason: "dispatch", startedAt: w.t(from - 2) }],
      spend: {
        estimatedUsd: 1.5,
        meteredUsd: Math.round((seconds / 3_600) * 0.44352 * 10_000) / 10_000,
        meteredSeconds: seconds,
      },
    }),
  );
  await w.stores.computeUtilizations.put(
    makeComputeUtilization(w.f, {
      samples: Math.max(1, Math.round(seconds / 30)),
      peakMemoryPct: 61,
      peakCpuPct: 88,
      cpuAbove90Pct: 0.04,
      wallClockSeconds: seconds,
      updatedAt: w.t(to),
    }),
  );
};

// --- complete -------------------------------------------------------------

/**
 * A finished run: two strands in parallel, four jobs, rework from a failed
 * verification, an examination with a fixed and an arbitrated finding, an
 * integration conflict; measurement per attempt, a partial summary, a machine,
 * a positive verdict and a completion history spanning three runs.
 */
const complete: Scenario = async (stores, ids, now) => {
  const startedAt = startOf(now, SPAN_HOURS);
  const { f, orgId, w } = await seedProgram(stores, ids, startedAt);
  const SONNET = "claude-sonnet-5";
  const OPUS = "claude-opus-5-5";
  const HAIKU = "claude-haiku-4-5-20251001";
  const EXAMINER = "gpt-6-astra";
  const END = 95;

  await stores.runs.put(makeRun(f, { status: "pending", startedAt: w.t(0) }));
  await seedMachine(w, "stopped", 2, END);
  await stores.runs.put(makeRun(f, { status: "succeeded", startedAt: w.t(0), endedAt: w.t(END) }));
  const root = makeRootNode(f, {
    status: "succeeded",
    createdAt: w.t(0),
    updatedAt: w.t(END),
  });
  await stores.executionNodes.put(root);
  const rootId = root.executionNodeId;
  await w.event("run.started", 0, null);
  await observe(w, rootId, {
    phase: "provisioning",
    start: 0,
    end: 2,
    refs: [{ kind: "dispatch", ref: f.scope.runId }],
  });

  // Two strands, in parallel.
  const s1Job = job(w, "S-01 Invoice persistence", 2, { strandId: "S-01" });
  const s2Job = job(w, "S-02 Webhook delivery", 2, { strandId: "S-02" });
  const s1 = await sub(w, rootId, "sub-program", 1, "succeeded", 2, s1Job);
  const s2 = await sub(w, rootId, "sub-program", 1, "succeeded", 2, s2Job);
  await agentOf(w, s1.executionNodeId, "orchestrator", OPUS, 2, 64);
  await agentOf(w, s2.executionNodeId, "orchestrator", OPUS, 2, 94);

  // J1: persist invoices. Clean, with a flaky step in its verification.
  const j1 = job(w, "Persist invoices to the store", 3);
  const n1 = await sub(w, s1.executionNodeId, "job", 2, "integrated", 3, j1, {
    commitSha: COMMIT(0x11),
  });
  const a1 = await agentOf(w, n1.executionNodeId, "worker", SONNET, 5, 25);
  const r1 = await attemptOf(w, {
    node: n1,
    agent: a1,
    model: SONNET,
    attempt: 1,
    outcome: "succeeded",
    tokens: { input: 612_000, cacheRead: 498_000, cacheWrite: 61_000, output: 38_400 },
    reportedUsd: 0.96,
    start: 5,
    end: 25,
  });
  const v1 = passingVerification(w, n1, a1, [25, 28], COMMIT(0x11), true);
  await stores.verifications.put(v1);
  await observe(w, n1.executionNodeId, { phase: "startup", start: 3, end: 4, agentId: a1.agentId });
  await observe(w, n1.executionNodeId, { phase: "setup", start: 4, end: 5 });
  await observe(w, n1.executionNodeId, {
    phase: "work",
    start: 5,
    end: 25,
    attempt: 1,
    agentId: a1.agentId,
    refs: [{ kind: "routing_decision", ref: r1.route.routingDecisionId }],
  });
  await observe(w, n1.executionNodeId, { phase: "queue", start: 28, end: 30 });
  await observe(w, n1.executionNodeId, {
    phase: "integration",
    start: 30,
    end: 32,
    reason: "integrated",
    refs: [{ kind: "commit", ref: COMMIT(0x11) }],
  });
  await w.event("node.integrated", 32, n1.executionNodeId, { commitSha: COMMIT(0x11) });

  // J2: invoice totals. Waits on J1; its first attempt fails verification, the second passes.
  const j2 = job(w, "Compute invoice totals from line items", 3, {
    dependencies: [j1.jobContractId],
  });
  const n2 = await sub(w, s1.executionNodeId, "job", 2, "integrated", 3, j2, {
    commitSha: COMMIT(0x22),
  });
  const a2a = await agentOf(w, n2.executionNodeId, "worker", SONNET, 34, 48, "failed");
  const r2a = await attemptOf(w, {
    node: n2,
    agent: a2a,
    model: SONNET,
    attempt: 1,
    outcome: "verification_failed",
    tokens: { input: 488_000, cacheRead: 352_000, cacheWrite: 48_000, output: 29_900 },
    reportedUsd: 0.78,
    start: 34,
    end: 48,
    exitKind: "completed",
  });
  const v2a = failingVerification(w, n2, a2a, [48, 50], COMMIT(0x21));
  await stores.verifications.put(v2a);
  const a2b = await agentOf(w, n2.executionNodeId, "worker", OPUS, 52, 63);
  const r2b = await attemptOf(w, {
    node: n2,
    agent: a2b,
    model: OPUS,
    attempt: 2,
    outcome: "succeeded",
    tokens: { input: 301_000, cacheRead: 244_000, cacheWrite: 19_000, output: 18_200 },
    reportedUsd: 2.41,
    start: 52,
    end: 63,
    previous: r2a.route,
    causes: [{ kind: "verification_failed", verificationId: v2a.verificationId }],
  });
  await stores.verifications.put(passingVerification(w, n2, a2b, [63, 65], COMMIT(0x22)));
  await observe(w, n2.executionNodeId, {
    phase: "wait",
    start: 3,
    end: 33,
    blockers: [{ kind: "job", ref: j1.jobContractId }],
  });
  await observe(w, n2.executionNodeId, { phase: "startup", start: 33, end: 34 });
  await observe(w, n2.executionNodeId, { phase: "setup", start: 34, end: 34.5 });
  await observe(w, n2.executionNodeId, {
    phase: "work",
    key: "1",
    start: 34.5,
    end: 48,
    attempt: 1,
    agentId: a2a.agentId,
  });
  await observe(w, n2.executionNodeId, {
    phase: "queue",
    key: "1",
    start: 48,
    end: 50,
    reason: "verification_failed",
    refs: [{ kind: "verification", ref: v2a.verificationId }],
  });
  await observe(w, n2.executionNodeId, {
    phase: "work",
    key: "2",
    start: 52,
    end: 63,
    attempt: 2,
    agentId: a2b.agentId,
    refs: [{ kind: "routing_decision", ref: r2b.route.routingDecisionId }],
  });
  await observe(w, n2.executionNodeId, { phase: "queue", key: "2", start: 65, end: 66.5 });
  await observe(w, n2.executionNodeId, {
    phase: "integration",
    start: 66.5,
    end: 68,
    reason: "integrated",
  });
  await w.event("node.integrated", 68, n2.executionNodeId, { commitSha: COMMIT(0x22) });

  // J3: idempotent webhooks. Waits for capacity; examined; one finding fixed, one arbitrated.
  const j3 = job(w, "Make webhook delivery idempotent", 3, { risk: "medium" });
  const n3 = await sub(w, s2.executionNodeId, "job", 2, "integrated", 3, j3, {
    commitSha: COMMIT(0x33),
  });
  const a3a = await agentOf(w, n3.executionNodeId, "worker", HAIKU, 8, 28);
  const r3a = await attemptOf(w, {
    node: n3,
    agent: a3a,
    model: HAIKU,
    attempt: 1,
    outcome: "succeeded",
    tokens: { input: 701_000, cacheRead: 530_000, cacheWrite: 70_000, output: 52_000 },
    reportedUsd: 0.31,
    start: 8,
    end: 28,
  });
  const v3a = passingVerification(w, n3, a3a, [28, 31], COMMIT(0x31));
  await stores.verifications.put(v3a);

  const exam1Id = ids.next("exam");
  const exam2Id = ids.next("exam");
  const ex1 = await agentOf(w, n3.executionNodeId, "examiner", EXAMINER, 33, 40);
  const arb = await agentOf(w, n3.executionNodeId, "arbiter", OPUS, 41, 44);
  const rEx1 = await attemptOf(w, {
    node: n3,
    agent: ex1,
    model: EXAMINER,
    attempt: 1,
    outcome: "succeeded",
    tokens: { input: 204_000, cacheRead: 120_000, cacheWrite: 0, output: 11_500 },
    start: 33,
    end: 40,
    purpose: "examine",
    concerning: { kind: "examination", examinationId: exam1Id },
  });
  const ruling = makeDecision(w.f, n3.executionNodeId, {
    agentId: arb.agentId,
    authority: "agent",
    context: "F-02 was disputed: the examiner wants delivery ids stored before the send.",
    alternatives: [
      { summary: "Overturn the finding", rejectedBecause: "the retry window needs it" },
    ],
    choice: "Upheld: store the delivery id before the first send.",
    rationale: "A crash between send and store would deliver twice.",
    createdAt: w.t(44),
  });
  await stores.decisions.put(ruling);
  await attemptOf(w, {
    node: n3,
    agent: arb,
    model: OPUS,
    attempt: 1,
    outcome: "succeeded",
    tokens: { input: 96_000, cacheRead: 61_000, cacheWrite: 8_000, output: 4_300 },
    reportedUsd: 0.62,
    start: 41,
    end: 44,
    purpose: "arbitrate",
    concerning: { kind: "examination", examinationId: exam1Id, findingId: "F-02" },
  });
  const a3b = await agentOf(w, n3.executionNodeId, "worker", HAIKU, 45, 56);
  const r3b = await attemptOf(w, {
    node: n3,
    agent: a3b,
    model: HAIKU,
    attempt: 2,
    outcome: "succeeded",
    tokens: { input: 266_000, cacheRead: 210_000, cacheWrite: 12_000, output: 19_900 },
    reportedUsd: 0.12,
    start: 45,
    end: 56,
    previous: r3a.route,
    causes: [
      {
        kind: "examination_findings",
        examinationId: exam1Id,
        findingIds: ["F-01"],
        decisionIds: [ruling.decisionId],
      },
    ],
    // The harness lost one request's usage before it flushed.
    coverage: "partial",
    gaps: [
      {
        reason: "stopped_before_flush",
        detail: "the harness stopped before its last request's usage was written",
        from: w.t(55),
        to: w.t(56),
        count: 1,
      },
    ],
  });
  const v3b = passingVerification(w, n3, a3b, [56, 58], COMMIT(0x33));
  await stores.verifications.put(v3b);
  const ex2 = await agentOf(w, n3.executionNodeId, "examiner", EXAMINER, 58, 62);
  await attemptOf(w, {
    node: n3,
    agent: ex2,
    model: EXAMINER,
    attempt: 1,
    outcome: "succeeded",
    tokens: { input: 118_000, cacheRead: 77_000, cacheWrite: 0, output: 5_200 },
    start: 58,
    end: 62,
    purpose: "examine",
    concerning: { kind: "examination", examinationId: exam2Id },
  });
  const findingEvidence = [{ kind: "contract", clause: "A webhook is delivered once." }];
  await stores.examinations.put(
    ExaminationSchema.parse({
      schemaVersion: 1,
      ...w.f.scope,
      examinationId: exam1Id,
      executionNodeId: n3.executionNodeId,
      verificationId: v3a.verificationId,
      commitSha: COMMIT(0x31),
      patchId: COMMIT(0x131),
      implementerAgentId: a3a.agentId,
      examinerAgentId: ex1.agentId,
      examinerRoute: rEx1.route.chosen,
      requiredByRisk: "medium",
      blocking: true,
      fixAttempt: 0,
      questions: [],
      outcome: "findings_raised",
      findings: [
        {
          id: "F-01",
          severity: "material",
          summary: "A retried delivery reuses a stale signature.",
          evidence: [
            { kind: "location", path: "src/webhooks/sign.ts", startLine: 12, endLine: 30 },
          ],
          resolution: "fixed",
          resolvedBy: { authority: "agent", examinationId: exam2Id, at: w.t(62) },
        },
        {
          id: "F-02",
          severity: "material",
          summary: "The delivery id is stored after the first send, not before.",
          evidence: findingEvidence,
          resolution: "upheld",
          resolvedBy: { authority: "agent", decisionId: ruling.decisionId, at: w.t(44) },
        },
      ],
      createdAt: w.t(40),
    }),
  );
  await stores.examinations.put(
    ExaminationSchema.parse({
      schemaVersion: 1,
      ...w.f.scope,
      examinationId: exam2Id,
      executionNodeId: n3.executionNodeId,
      verificationId: v3b.verificationId,
      commitSha: COMMIT(0x33),
      patchId: COMMIT(0x133),
      implementerAgentId: a3b.agentId,
      examinerAgentId: ex2.agentId,
      examinerRoute: rEx1.route.chosen,
      requiredByRisk: "medium",
      blocking: true,
      fixAttempt: 1,
      questions: [],
      followsRulings: [
        {
          findingId: "F-02",
          decisionId: ruling.decisionId,
          summary: "Store the delivery id before the first send.",
          rationale: "A crash between send and store would deliver twice.",
        },
      ],
      outcome: "passed",
      findings: [],
      createdAt: w.t(62),
    }),
  );
  await observe(w, n3.executionNodeId, {
    phase: "wait",
    start: 3,
    end: 6,
    blockers: [{ kind: "parent_slot", ref: s2.executionNodeId }],
  });
  await observe(w, n3.executionNodeId, { phase: "startup", start: 6, end: 7 });
  await observe(w, n3.executionNodeId, { phase: "setup", start: 7, end: 8 });
  await observe(w, n3.executionNodeId, {
    phase: "work",
    key: "1",
    start: 8,
    end: 28,
    attempt: 1,
    agentId: a3a.agentId,
  });
  await observe(w, n3.executionNodeId, {
    phase: "examination",
    key: "1",
    start: 33,
    end: 40,
    agentId: ex1.agentId,
    refs: [{ kind: "examination", ref: exam1Id }],
  });
  await observe(w, n3.executionNodeId, {
    phase: "arbitration",
    start: 41,
    end: 44,
    agentId: arb.agentId,
    refs: [
      { kind: "finding", ref: `${exam1Id}/F-02` },
      { kind: "decision", ref: ruling.decisionId },
    ],
  });
  await observe(w, n3.executionNodeId, {
    phase: "work",
    key: "2",
    start: 45,
    end: 56,
    attempt: 2,
    agentId: a3b.agentId,
    refs: [{ kind: "routing_decision", ref: r3b.route.routingDecisionId }],
  });
  await observe(w, n3.executionNodeId, {
    phase: "examination",
    key: "2",
    start: 58,
    end: 62,
    agentId: ex2.agentId,
    refs: [{ kind: "examination", ref: exam2Id }],
  });
  await observe(w, n3.executionNodeId, { phase: "queue", start: 62, end: 63 });
  await observe(w, n3.executionNodeId, {
    phase: "integration",
    start: 63,
    end: 65,
    reason: "integrated",
  });
  await w.event("node.integrated", 65, n3.executionNodeId, { commitSha: COMMIT(0x33) });

  // J4: webhook retries. Waits on J3; its first integration conflicts, the retry lands.
  const j4 = job(w, "Retry failed webhook deliveries with backoff", 3, {
    dependencies: [j3.jobContractId],
  });
  const n4 = await sub(w, s2.executionNodeId, "job", 2, "integrated", 3, j4, {
    commitSha: COMMIT(0x44),
  });
  const a4a = await agentOf(w, n4.executionNodeId, "worker", SONNET, 67, 80);
  const r4a = await attemptOf(w, {
    node: n4,
    agent: a4a,
    model: SONNET,
    attempt: 1,
    outcome: "failed",
    tokens: { input: 390_000, cacheRead: 301_000, cacheWrite: 33_000, output: 24_100 },
    reportedUsd: 0.64,
    start: 67,
    end: 80,
  });
  await stores.verifications.put(passingVerification(w, n4, a4a, [80, 82], COMMIT(0x41)));
  const a4b = await agentOf(w, n4.executionNodeId, "worker", SONNET, 85, 90);
  await attemptOf(w, {
    node: n4,
    agent: a4b,
    model: SONNET,
    attempt: 2,
    outcome: "succeeded",
    tokens: { input: 122_000, cacheRead: 99_000, cacheWrite: 6_000, output: 7_600 },
    reportedUsd: 0.21,
    start: 85,
    end: 90,
    previous: r4a.route,
    causes: [
      {
        kind: "integration_conflict",
        paths: ["src/webhooks/retry.ts"],
        previousRoutingDecisionId: r4a.route.routingDecisionId,
      },
    ],
  });
  await stores.verifications.put(passingVerification(w, n4, a4b, [90, 92], COMMIT(0x44)));
  await observe(w, n4.executionNodeId, {
    phase: "wait",
    start: 3,
    end: 66,
    blockers: [{ kind: "job", ref: j3.jobContractId }],
  });
  await observe(w, n4.executionNodeId, { phase: "startup", start: 66, end: 67 });
  await observe(w, n4.executionNodeId, {
    phase: "work",
    key: "1",
    start: 67,
    end: 80,
    attempt: 1,
    agentId: a4a.agentId,
  });
  await observe(w, n4.executionNodeId, { phase: "queue", key: "1", start: 82, end: 83 });
  await observe(w, n4.executionNodeId, {
    phase: "integration",
    key: "1",
    start: 83,
    end: 85,
    reason: "integration_conflict",
  });
  await w.event("integration.conflict", 85, n4.executionNodeId, {
    paths: ["src/webhooks/retry.ts"],
  });
  await observe(w, n4.executionNodeId, {
    phase: "work",
    key: "2",
    start: 85,
    end: 90,
    attempt: 2,
    agentId: a4b.agentId,
  });
  await observe(w, n4.executionNodeId, { phase: "queue", key: "2", start: 92, end: 93 });
  await observe(w, n4.executionNodeId, {
    phase: "integration",
    key: "2",
    start: 93,
    end: 94,
    reason: "integrated",
  });
  await w.event("node.integrated", 94, n4.executionNodeId, { commitSha: COMMIT(0x44) });
  await w.event("run.completed", END, null);

  await stores.gateHealth.put(makeGateHealth(f, { auditedAt: w.t(1) }));
  await putFeedback(stores, f, orgId, [{ verdict: "worked", at: w.t(100), commit: COMMIT(0x44) }]);

  await completionHistory(stores, ids, w, orgId, startedAt);
  return { scope: f.scope, orgId };
};

/** The outcome the anchor belongs to: a failed attempt before it and a correction after it. */
const completionHistory = async (
  stores: ProjectStores,
  ids: IdGenerator,
  anchor: World,
  orgId: OrgId,
  startedAt: string,
): Promise<void> => {
  const { f } = anchor;
  // A failed run of the same program, before.
  const earlier: Fixtures = {
    ...f,
    scope: { ...f.scope, runId: ids.next("run") },
    rootNodeId: ids.next("node"),
  };
  const early = makeWorld(stores, earlier, startedAt);
  await seedFailedRun(early, { from: -240, strandsFailed: 1 });
  await putFeedback(stores, earlier, orgId, [{ verdict: "did_not_work", at: early.t(-195) }]);

  // A correction run in another program of the same project, after.
  const other: Fixtures = {
    ...f,
    scope: { ...f.scope, programId: ids.next("prog"), runId: ids.next("run") },
    rootNodeId: ids.next("node"),
  };
  await stores.programContracts.put(
    makeProgramContract(other, {
      objective: "Correct the retry backoff so a redelivery cannot be sent twice.",
      verification: VERIFICATION,
    }),
  );
  const fix = makeWorld(stores, other, startedAt);
  await stores.runs.put(
    makeRun(other, { status: "succeeded", startedAt: fix.t(120), endedAt: fix.t(150) }),
  );
  const root = makeRootNode(other, {
    status: "succeeded",
    createdAt: fix.t(120),
    updatedAt: fix.t(150),
  });
  await stores.executionNodes.put(root);
  const fixJob = job(fix, "Guard redelivery with the stored delivery id", 121);
  const node = await sub(fix, root.executionNodeId, "job", 1, "integrated", 121, fixJob, {
    commitSha: COMMIT(0x55),
  });
  const agent = await agentOf(fix, node.executionNodeId, "worker", "claude-sonnet-5", 122, 140);
  await attemptOf(fix, {
    node,
    agent,
    model: "claude-sonnet-5",
    attempt: 1,
    outcome: "succeeded",
    tokens: { input: 280_000, cacheRead: 210_000, cacheWrite: 20_000, output: 16_800 },
    reportedUsd: 0.44,
    start: 122,
    end: 140,
  });
  await stores.verifications.put(passingVerification(fix, node, agent, [140, 143], COMMIT(0x55)));
  await putFeedback(stores, other, orgId, [
    { verdict: "did_not_work", at: fix.t(155) },
    { verdict: "worked", at: fix.t(200), commit: COMMIT(0x55) },
  ]);

  const all: MeasurementSummary[] = [...anchor.summaries, ...early.summaries, ...fix.summaries];
  const sum = (pick: (s: MeasurementSummary) => number | undefined): number =>
    all.reduce((total, s) => total + (pick(s) ?? 0), 0);
  const members = [
    { programId: f.scope.programId, runId: f.scope.runId, role: "anchor" },
    { programId: f.scope.programId, runId: earlier.scope.runId, role: "contributing" },
    { programId: other.scope.programId, runId: other.scope.runId, role: "correction" },
  ] as const;
  // The anchor's own history first, as a person created it; the checkpoint came with the second revision.
  const first = makeCompletionHistory(f, {
    title: "Invoices persist and webhooks deliver once",
    version: 1,
    members: [members[0]],
    revisions: [
      {
        version: 1,
        actor: actor(orgId),
        recordedAt: anchor.t(101),
        added: [members[0]],
        removed: [],
      },
    ],
    createdAt: anchor.t(101),
    updatedAt: anchor.t(101),
  });
  await stores.completionHistories.put(first);
  const history = makeCompletionHistory(f, {
    completionHistoryId: first.completionHistoryId,
    title: "Invoices persist and webhooks deliver once",
    version: 2,
    members: [...members],
    checkpoints: [
      {
        name: "after the correction",
        programId: other.scope.programId,
        runId: other.scope.runId,
        feedbackVersion: 2,
        verdictRecordedAt: fix.t(200),
        members: [...members],
        membershipVersion: 2,
        recordedBy: actor(orgId),
        recordedAt: fix.t(205),
        measured: {
          measuredTo: fix.t(205),
          readableMembers: 3,
          measuredMembers: 3,
          unmeasuredMembers: 0,
          earliestStart: early.t(-240),
          leadTimeSeconds: (200 + 240) * 60,
          runCompletionSeconds: (150 - -240) * 60,
          activeSeconds: Math.round(sum(() => 0) + (95 + 40 + 30) * 60),
          tokens: {
            input: sum((s) => s.totals.inputTokens),
            output: sum((s) => s.totals.outputTokens),
            cacheRead: sum((s) => s.totals.cacheReadTokens),
            cacheWrite: sum((s) => s.totals.cacheWriteTokens),
            inputConventionUnknown: 0,
          },
          usd: {
            estimated: sum((s) => s.valuation.estimatedUsd),
            reported: sum((s) => s.valuation.reportedUsd),
          },
          coverage: {
            complete: all.filter((s) => s.coverage === "complete").length,
            partial: all.filter((s) => s.coverage === "partial").length,
            unknown: 0,
            legacy: 0,
            missing: 0,
          },
          infrastructure: { usd: 0.71, members: 1, withoutMachine: 2 },
          recordedAt: fix.t(205),
        },
      },
    ],
    revisions: [
      {
        version: 1,
        actor: actor(orgId),
        recordedAt: anchor.t(101),
        added: [members[0]],
        removed: [],
      },
      {
        version: 2,
        actor: actor(orgId),
        recordedAt: fix.t(205),
        added: [members[1], members[2]],
        removed: [],
        checkpoint: "after the correction",
      },
    ],
    createdAt: anchor.t(101),
    updatedAt: fix.t(205),
  });
  await stores.completionHistories.put(history);
};

// --- failed ---------------------------------------------------------------

/**
 * A run that failed: S-01's job gave up after two attempts, S-02 never
 * started, and nothing succeeded. `from` is minutes from the world's start.
 */
const seedFailedRun = async (
  w: World,
  options: { from: number; strandsFailed: number; machine?: { from: number; to: number } },
): Promise<{ node: ExecutionNode }> => {
  const { f, stores } = w;
  const at = (m: number) => options.from + m;
  const SONNET = "claude-sonnet-5";
  const OPUS = "claude-opus-5-5";
  const END = at(41);
  if (options.machine !== undefined) {
    await stores.runs.put(makeRun(f, { status: "pending", startedAt: w.t(at(0)) }));
    await seedMachine(w, "stopped", options.machine.from, options.machine.to);
  }
  await stores.runs.put(
    makeRun(f, {
      status: "failed",
      startedAt: w.t(at(0)),
      endedAt: w.t(END),
      outcomeReason: "S-01 failed: the totals job did not pass verification after two attempts",
    }),
  );
  const root = makeRootNode(f, {
    status: "failed",
    createdAt: w.t(at(0)),
    updatedAt: w.t(END),
  });
  await stores.executionNodes.put(root);
  await w.event("run.started", at(0), null);
  const s1Job = job(w, "S-01 Invoice persistence", at(1), { strandId: "S-01" });
  const s1 = await sub(w, root.executionNodeId, "sub-program", 1, "failed", at(1), s1Job, {
    outcomeReason: "a job failed verification twice",
  });
  await agentOf(w, s1.executionNodeId, "orchestrator", OPUS, at(1), END, "failed");
  const j = job(w, "Compute invoice totals from line items", at(2));
  const node = await sub(w, s1.executionNodeId, "job", 2, "failed", at(2), j, {
    outcomeReason: "npm test failed after two attempts",
  });
  const a1 = await agentOf(w, node.executionNodeId, "worker", SONNET, at(4), at(17), "failed");
  const r1 = await attemptOf(w, {
    node,
    agent: a1,
    model: SONNET,
    attempt: 1,
    outcome: "verification_failed",
    tokens: { input: 470_000, cacheRead: 340_000, cacheWrite: 41_000, output: 28_700 },
    reportedUsd: 0.75,
    start: at(4),
    end: at(17),
  });
  const v1 = failingVerification(w, node, a1, [at(17), at(19)], COMMIT(0x61));
  await stores.verifications.put(v1);
  const a2 = await agentOf(w, node.executionNodeId, "worker", OPUS, at(21), at(37), "failed");
  await attemptOf(w, {
    node,
    agent: a2,
    model: OPUS,
    attempt: 2,
    outcome: "verification_failed",
    tokens: { input: 355_000, cacheRead: 280_000, cacheWrite: 22_000, output: 21_300 },
    reportedUsd: 2.84,
    start: at(21),
    end: at(37),
    previous: r1.route,
    causes: [{ kind: "verification_failed", verificationId: v1.verificationId }],
  });
  await stores.verifications.put(failingVerification(w, node, a2, [at(37), at(39)], COMMIT(0x62)));
  await observe(w, node.executionNodeId, { phase: "startup", start: at(2), end: at(3) });
  await observe(w, node.executionNodeId, {
    phase: "work",
    key: "1",
    start: at(4),
    end: at(17),
    attempt: 1,
    agentId: a1.agentId,
  });
  await observe(w, node.executionNodeId, {
    phase: "queue",
    key: "1",
    start: at(17),
    end: at(19),
    reason: "verification_failed",
  });
  await observe(w, node.executionNodeId, {
    phase: "work",
    key: "2",
    start: at(21),
    end: at(37),
    attempt: 2,
    agentId: a2.agentId,
  });
  await observe(w, node.executionNodeId, {
    phase: "queue",
    key: "2",
    start: at(37),
    end: at(39),
    reason: "verification_failed",
  });
  await w.event("run.failed", END, null);
  return { node };
};

const failed: Scenario = async (stores, ids, now) => {
  const startedAt = startOf(now, 2);
  const { f, orgId, w } = await seedProgram(stores, ids, startedAt);
  await seedFailedRun(w, { from: 0, strandsFailed: 1, machine: { from: 2, to: 41 } });
  return { scope: f.scope, orgId };
};

// --- sparse ---------------------------------------------------------------

/** A run from before measurement: routes carry usage, nothing else does. */
const sparse: Scenario = async (stores, ids, now) => {
  const startedAt = startOf(now, 24);
  const { f, orgId, w } = await seedProgram(stores, ids, startedAt);
  const SONNET = "claude-sonnet-5";
  await stores.runs.put(makeRun(f, { status: "succeeded", startedAt: w.t(0), endedAt: w.t(50) }));
  const root = makeRootNode(f, { status: "succeeded", createdAt: w.t(0), updatedAt: w.t(50) });
  await stores.executionNodes.put(root);
  await w.event("run.started", 0, null);
  const sJob = job(w, "S-01 Invoice persistence", 1, { strandId: "S-01" });
  const s1 = await sub(w, root.executionNodeId, "sub-program", 1, "succeeded", 1, sJob);
  await agentOf(w, s1.executionNodeId, "orchestrator", SONNET, 1, 49);
  const specs = [
    { name: "Persist invoices to the store", from: 2, to: 20, sha: 0x71, tokens: 540_000 },
    {
      name: "Compute invoice totals from line items",
      from: 21,
      to: 44,
      sha: 0x72,
      tokens: 410_000,
    },
  ];
  for (const spec of specs) {
    const j = job(w, spec.name, spec.from);
    const node = await sub(w, s1.executionNodeId, "job", 2, "integrated", spec.from, j, {
      commitSha: COMMIT(spec.sha),
    });
    const agent = await agentOf(w, node.executionNodeId, "worker", SONNET, spec.from, spec.to);
    await attemptOf(w, {
      node,
      agent,
      model: SONNET,
      attempt: 1,
      outcome: "succeeded",
      tokens: {
        input: spec.tokens,
        cacheRead: 0,
        cacheWrite: 0,
        output: Math.round(spec.tokens / 14),
      },
      start: spec.from,
      end: spec.to,
      legacy: true,
    });
    await stores.verifications.put(
      passingVerification(w, node, agent, [spec.to, spec.to + 2], COMMIT(spec.sha)),
    );
  }
  await w.event("run.completed", 50, null);
  return { scope: f.scope, orgId };
};

// --- running --------------------------------------------------------------

/** A run still going: an open work interval, a node waiting on capacity, partial summaries. */
const running: Scenario = async (stores, ids, now) => {
  const startedAt = startOf(now, 1);
  const { f, orgId, w } = await seedProgram(stores, ids, startedAt);
  const SONNET = "claude-sonnet-5";
  const OPUS = "claude-opus-5-5";
  await stores.runs.put(makeRun(f, { status: "pending", startedAt: w.t(0) }));
  await seedMachine(w, "running", 2, 40);
  await stores.runs.put(makeRun(f, { status: "running", startedAt: w.t(0) }));
  const root = makeRootNode(f, { status: "running", createdAt: w.t(0), updatedAt: w.t(40) });
  await stores.executionNodes.put(root);
  await w.event("run.started", 0, null);
  await observe(w, root.executionNodeId, { phase: "provisioning", start: 0, end: 2 });

  const s1Job = job(w, "S-01 Invoice persistence", 2, { strandId: "S-01" });
  const s2Job = job(w, "S-02 Webhook delivery", 2, { strandId: "S-02" });
  const s1 = await sub(w, root.executionNodeId, "sub-program", 1, "running", 2, s1Job);
  const s2 = await sub(w, root.executionNodeId, "sub-program", 1, "running", 2, s2Job);
  await agentOf(w, s1.executionNodeId, "orchestrator", OPUS, 2, undefined, "started");
  await agentOf(w, s2.executionNodeId, "orchestrator", OPUS, 2, undefined, "started");

  const j1 = job(w, "Persist invoices to the store", 3);
  const n1 = await sub(w, s1.executionNodeId, "job", 2, "integrated", 3, j1, {
    commitSha: COMMIT(0x81),
  });
  const a1 = await agentOf(w, n1.executionNodeId, "worker", SONNET, 5, 22);
  await attemptOf(w, {
    node: n1,
    agent: a1,
    model: SONNET,
    attempt: 1,
    outcome: "succeeded",
    tokens: { input: 590_000, cacheRead: 470_000, cacheWrite: 52_000, output: 36_000 },
    reportedUsd: 0.91,
    start: 5,
    end: 22,
  });
  await stores.verifications.put(passingVerification(w, n1, a1, [22, 25], COMMIT(0x81)));
  await observe(w, n1.executionNodeId, { phase: "startup", start: 3, end: 4 });
  await observe(w, n1.executionNodeId, { phase: "work", start: 5, end: 22, attempt: 1 });
  await observe(w, n1.executionNodeId, { phase: "queue", start: 25, end: 26 });
  await observe(w, n1.executionNodeId, { phase: "integration", start: 26, end: 28 });

  // Open: the second job of S-01 is working now; nothing has closed it.
  const j2 = job(w, "Compute invoice totals from line items", 3, {
    dependencies: [j1.jobContractId],
  });
  const n2 = await sub(w, s1.executionNodeId, "job", 2, "running", 3, j2);
  const a2 = await agentOf(w, n2.executionNodeId, "worker", SONNET, 30, undefined, "started");
  await attemptOf(w, {
    node: n2,
    agent: a2,
    model: SONNET,
    attempt: 1,
    outcome: "pending",
    tokens: { input: 210_000, cacheRead: 150_000, cacheWrite: 22_000, output: 12_400 },
    start: 30,
    end: undefined,
    open: true,
    coverage: "partial",
  });
  await observe(w, n2.executionNodeId, {
    phase: "wait",
    start: 3,
    end: 29,
    blockers: [{ kind: "job", ref: j1.jobContractId }],
  });
  await observe(w, n2.executionNodeId, { phase: "startup", start: 29, end: 30 });
  await observe(w, n2.executionNodeId, {
    phase: "work",
    start: 30,
    attempt: 1,
    agentId: a2.agentId,
  });

  // Waiting: S-02's job has no slot yet, and is still waiting.
  const j3 = job(w, "Make webhook delivery idempotent", 3);
  const n3 = await sub(w, s2.executionNodeId, "job", 2, "validated", 3, j3);
  await observe(w, n3.executionNodeId, {
    phase: "wait",
    start: 3,
    blockers: [{ kind: "parent_slot", ref: s2.executionNodeId }],
  });
  await w.event("node.progress", 38, n2.executionNodeId, { message: "writing the totals" });
  return { scope: f.scope, orgId };
};

// --- error and loading ----------------------------------------------------

/** Reads served by `base`, except the ones `replace` overrides. */
const withReads = (
  base: ProjectStores,
  replace: (stores: ProjectStores) => Partial<ProjectStores>,
): ProjectStores => ({ ...base, ...replace(base) });

const overridden = <S extends object>(store: S, methods: Partial<Record<keyof S, unknown>>): S =>
  Object.assign(Object.create(store) as S, methods);

const error: Scenario = async (stores, ids, now) => {
  const seeded = await sparse(stores, ids, now);
  return {
    ...seeded,
    stores: withReads(stores, (s) => ({
      executionNodes: overridden(s.executionNodes, {
        listByRun: async () => {
          throw new Error("the control plane refused the read (503 service_unavailable)");
        },
      }),
    })),
  };
};

const loading: Scenario = async (stores, ids, now) => {
  const seeded = await sparse(stores, ids, now);
  const never = () => new Promise<never>(() => {});
  return {
    ...seeded,
    stores: withReads(stores, (s) => ({
      executionNodes: overridden(s.executionNodes, { listByRun: never }),
      programContracts: overridden(s.programContracts, { get: never }),
    })),
  };
};

// --- histories over the other worlds --------------------------------------

/**
 * A completion history whose anchor is the run `base` seeds, with one more
 * member run: either a failed earlier run of the same program (`earlier`) or a
 * run that has no records at all (`unrecorded`), so the membership is partial.
 */
const withHistory =
  (base: Scenario, title: string, other: "earlier" | "unrecorded"): Scenario =>
  async (stores, ids, now) => {
    const seeded = await base(stores, ids, now);
    const startedAt = startOf(now, SPAN_HOURS);
    const f: Fixtures = { ...createFixtures(ids), scope: seeded.scope };
    const memberRun = ids.next("run");
    if (other === "earlier") {
      const earlier: Fixtures = {
        ...f,
        scope: { ...f.scope, runId: memberRun },
        rootNodeId: ids.next("node"),
      };
      const early = makeWorld(stores, earlier, startedAt);
      await seedFailedRun(early, { from: -240, strandsFailed: 1 });
      await putFeedback(stores, earlier, seeded.orgId, [
        { verdict: "did_not_work", at: early.t(-195) },
      ]);
    }
    const members = [
      { programId: f.scope.programId, runId: f.scope.runId, role: "anchor" },
      { programId: f.scope.programId, runId: memberRun, role: "contributing" },
    ] as const;
    const at = new Date(Date.parse(now()) - HOUR / 2).toISOString();
    await stores.completionHistories.put(
      makeCompletionHistory(f, {
        title,
        version: 1,
        members: [...members],
        revisions: [
          {
            version: 1,
            actor: actor(seeded.orgId),
            recordedAt: at,
            added: [...members],
            removed: [],
          },
        ],
        createdAt: at,
        updatedAt: at,
      }),
    );
    return seeded;
  };

const partialHistory = withHistory(
  sparse,
  "Invoices persist (one run left no records)",
  "unrecorded",
);
const runningHistory = withHistory(running, "Invoices persist, retry in progress", "earlier");
const failedHistory = withHistory(failed, "Invoices persist after a failed attempt", "earlier");

export const SCENARIOS = {
  complete,
  sparse,
  running,
  failed,
  error,
  loading,
  "partial-history": partialHistory,
  "running-history": runningHistory,
  "failed-history": failedHistory,
} as const;
export type ScenarioName = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];
