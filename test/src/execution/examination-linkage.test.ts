/**
 * Examination linkage (P20 S-05): what the helpers' routing decisions say they
 * concern, the lifecycle observations the examination operations emit, and
 * which earlier findings a later examination may close as `fixed`. Driven the
 * way examination.test.ts drives it: the fake harness playing every part, real
 * git, and the production API handler.
 */
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXAMINATION_POLICY,
  type Decision,
  type Examination,
  ExaminationSchema,
  type ExecutionNode,
  type ExecutionNodeId,
  JobContractSchema,
  type LifecycleObservation,
  lifecycleObservationsOf,
  MeasurementLedgerChunkSchema,
  type Prerequisite,
  type ProgramContract,
  type RiskLevel,
  type RouteChoice,
  type RouteTarget,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  closeFixedFindings,
  completeJob,
  createEngine,
  createEventOutbox,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  type ExecutionEnvironment,
  type PrerequisiteBook,
  RULING_CONTEXT_ENV,
  type RulingContext,
  reviewStrandPlan,
} from "@nightshift/execution";
import type { HarnessExit, HarnessStartInput } from "@nightshift/harness";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld, eventsOf, type World } from "./world.js";

afterEach(cleanupWorlds);

const target = (provider: string, model: string): RouteTarget => ({
  harness: "fake",
  provider,
  model,
});
const choice = (routeTarget: RouteTarget): RouteChoice => ({
  target: routeTarget,
  eligibleOptions: [{ target: routeTarget, eligible: true }],
  ruleId: "R-test",
  wasOverride: false,
});

const BUILDER = target("anthropic", "claude-sonnet-5");
const EXAMINER = target("openai", "gpt-6-astra");
const ARBITER = target("anthropic", "claude-opus-5-5");

/** What the examiner finds on each fix attempt, by attempt; absent means it passes. */
type Finding = {
  readonly severity: "material" | "minor";
  readonly evidence?: boolean;
  /** The same defect as the earlier examination's first material finding. */
  readonly repeats?: boolean;
};

interface Scenario {
  readonly risk: RiskLevel;
  /** Findings per fix attempt (0, 1, 2). */
  readonly findings?: (fixAttempt: number) => readonly Finding[];
  /** The examiner asks this in round 1. */
  readonly ask?: readonly string[];
  /** Whether the builder's session can be resumed. */
  readonly builderSession?: boolean;
  readonly ruling?: "overturn" | "uphold";
  /**
   * On an examination of an attempt that carried out a ruling, by ruling
   * attempt (1, 2): whether it was. It also raises a material finding about
   * something else, which must not block.
   */
  readonly rulingCarried?: (rulingAttempt: number) => boolean;
  /** Examiner models a usage limit stops, the first time each is started. */
  readonly limitedExaminers?: readonly string[];
  /** Examiner models that cannot even start (a launch failure, an expired login): always. */
  readonly brokenExaminers?: readonly string[];
}

interface Seen {
  readonly roles: string[];
  readonly tasks: HarnessStartInput["task"][];
  readonly resumes: (string | undefined)[];
  /** Whether each agent's checkout was there when it started. */
  readonly checkouts: boolean[];
  /** The model of every examiner started, in order. */
  readonly examinerModels: string[];
}

const helperStores = (world: World, input: HarnessStartInput) =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });

const play =
  (world: () => World, scenario: Scenario, seen: Seen) =>
  async (context: ScriptContext): Promise<HarnessExit> => {
    const { input } = context;
    const w = world();
    seen.roles.push(input.agent.role);
    seen.tasks.push(input.task);
    seen.resumes.push(input.resume?.sessionId);
    seen.checkouts.push(existsSync(input.worktree));
    switch (input.agent.role) {
      case "examiner":
        if (input.task?.kind === "review_plan") return { kind: "completed" };
        return examinerUnlessLimited(w, input, scenario, seen);
      case "answerer": {
        if (input.resume !== undefined && scenario.builderSession === false)
          return { kind: "failed", exitCode: 1 };
        const task = input.task;
        const questions = task?.kind === "answer" ? task.questions : [];
        const from = input.resume === undefined ? "the transcript" : "memory";
        return {
          kind: "completed",
          result: JSON.stringify(
            questions.map((question) => ({ question, answer: `deliberate, from ${from}` })),
          ),
        };
      }
      case "arbiter":
        return arbiter(w, input, scenario);
      default: {
        const outbox = createEventOutbox({
          events: w.stores.events,
          scope: context.identity.scope,
          clock: w.environment.clock,
          ids: w.ids,
          writerId: context.identity.agentId,
          initialDelayMs: 1,
        });
        const attempt = seen.roles.filter((role) => role === "worker").length;
        await writeFile(
          join(context.worktree, "src", "examined.js"),
          `export const examined = ${attempt};\n`,
          "utf8",
        );
        await completeJob(
          { stores: w.stores, clock: w.environment.clock, git: w.git, outbox },
          context.identity,
          "examined: done",
        );
        await outbox.flush();
        return scenario.builderSession === false
          ? { kind: "completed" }
          : { kind: "completed", sessionId: "builder-session" };
      }
    }
  };

/** A usage limit, the first time an examiner on a limited model starts; otherwise the examiner. */
const examinerUnlessLimited = async (
  world: World,
  input: HarnessStartInput,
  scenario: Scenario,
  seen: Seen,
): Promise<HarnessExit> => {
  const model = input.model.model;
  const startedBefore = seen.examinerModels.includes(model);
  seen.examinerModels.push(model);
  if (scenario.brokenExaminers?.includes(model) === true) {
    return { kind: "failed", exitCode: 127 };
  }
  if (scenario.limitedExaminers?.includes(model) !== true || startedBefore) {
    return examiner(world, input, scenario);
  }
  return {
    kind: "failed",
    exitCode: 1,
    unavailable: "the provider answered 429 after work began: You have hit your usage limit",
    availableAgainAt: new Date(world.environment.clock.now() + 600_000).toISOString(),
    workBegan: true,
  };
};

const examiner = async (
  world: World,
  input: HarnessStartInput,
  scenario: Scenario,
): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
  const stores = helperStores(world, input);
  if (context.round === 1 && context.fixAttempt === 0 && scenario.ask !== undefined) {
    const outbox = createEventOutbox({
      events: stores.events,
      scope: {
        projectId: input.node.projectId,
        programId: input.node.programId,
        runId: input.node.runId,
      },
      clock: world.environment.clock,
      ids: world.ids,
      writerId: input.agent.agentId,
      initialDelayMs: 1,
    });
    outbox.emit({
      type: "examination.asked",
      source: "mcp",
      payload: { examinationId: context.examinationId, questions: scenario.ask },
      executionNodeId: input.node.executionNodeId,
      agentId: input.agent.agentId,
    });
    await outbox.flush();
    return { kind: "completed", sessionId: "examiner-session" };
  }
  if (context.followsRulings !== undefined) {
    return checkRuling(world, input, scenario, context, stores);
  }
  const earlier = [
    ...(await world.stores.examinations.listByNode(world.scope, input.node.executionNodeId)),
  ]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const earlierFinding = earlier?.findings.find((finding) => finding.severity === "material");
  const findings = (scenario.findings?.(context.fixAttempt) ?? []).map((finding, index) => ({
    id: `F-0${index + 1}`,
    severity: finding.severity,
    summary: `finding ${index + 1} on attempt ${context.fixAttempt}`,
    evidence:
      finding.evidence === false ? [] : [{ kind: "contract" as const, clause: "It works." }],
    resolution: "unresolved" as const,
    ...(finding.repeats === true && earlier !== undefined && earlierFinding !== undefined
      ? { repeats: { examinationId: earlier.examinationId, findingId: earlierFinding.id } }
      : {}),
  }));
  const parsed = ExaminationSchema.safeParse({
    schemaVersion: 1,
    projectId: input.node.projectId,
    programId: input.node.programId,
    runId: input.node.runId,
    examinationId: context.examinationId,
    executionNodeId: input.node.executionNodeId,
    verificationId: context.verificationId,
    commitSha: context.commitSha,
    patchId: context.patchId,
    implementerAgentId: context.implementerAgentId,
    examinerAgentId: input.agent.agentId,
    examinerRoute: context.examinerRoute,
    requiredByRisk: context.requiredByRisk,
    blocking: context.blocking,
    fixAttempt: context.fixAttempt,
    questions: context.questions,
    ...(context.independenceWaived === undefined
      ? {}
      : { independenceWaived: context.independenceWaived }),
    outcome: findings.length === 0 ? "passed" : "findings_raised",
    findings,
    createdAt: nowIso(world.environment.clock),
  });
  // A finding without evidence never becomes a verdict (D-P8-12): the tool refuses it.
  if (!parsed.success) return { kind: "completed" };
  await stores.examinations.put(parsed.data as Examination);
  return { kind: "completed", sessionId: "examiner-session" };
};

/** The examiner of an attempt that carried out a ruling: judges only the ruling. */
const checkRuling = async (
  world: World,
  input: HarnessStartInput,
  scenario: Scenario,
  context: ExaminationContext,
  stores: ReturnType<typeof helperStores>,
): Promise<HarnessExit> => {
  const rulingAttempt = (rulingChecks.get(input.node.executionNodeId) ?? 0) + 1;
  rulingChecks.set(input.node.executionNodeId, rulingAttempt);
  const carried = scenario.rulingCarried?.(rulingAttempt) ?? true;
  const ruled = context.followsRulings?.[0]?.findingId ?? "F-01";
  const evidence = [{ kind: "contract" as const, clause: "It works." }];
  const findings = [
    {
      id: "F-01",
      severity: "material" as const,
      summary: "something the ruling was not about",
      evidence,
      resolution: "unresolved" as const,
    },
    ...(carried
      ? []
      : [
          {
            id: "F-02",
            severity: "material" as const,
            summary: `the ruling on ${ruled} is not carried out`,
            evidence,
            resolution: "unresolved" as const,
            concerns: ruled,
          },
        ]),
  ];
  await stores.examinations.put(
    ExaminationSchema.parse({
      schemaVersion: 1,
      projectId: input.node.projectId,
      programId: input.node.programId,
      runId: input.node.runId,
      examinationId: context.examinationId,
      executionNodeId: input.node.executionNodeId,
      verificationId: context.verificationId,
      commitSha: context.commitSha,
      patchId: context.patchId,
      implementerAgentId: context.implementerAgentId,
      examinerAgentId: input.agent.agentId,
      examinerRoute: context.examinerRoute,
      requiredByRisk: context.requiredByRisk,
      blocking: context.blocking,
      fixAttempt: context.fixAttempt,
      questions: context.questions,
      followsRulings: context.followsRulings,
      outcome: "findings_raised",
      findings,
      createdAt: nowIso(world.environment.clock),
    }) as Examination,
  );
  return { kind: "completed", sessionId: "examiner-session" };
};

/** Ruling checks per node, so a scenario can say what each one finds. */
const rulingChecks = new Map<string, number>();

const arbiter = async (
  world: World,
  input: HarnessStartInput,
  scenario: Scenario,
): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[RULING_CONTEXT_ENV] ?? "{}") as RulingContext;
  const ruling = scenario.ruling ?? "overturn";
  const decision: Decision = {
    schemaVersion: 1,
    projectId: input.node.projectId,
    programId: input.node.programId,
    runId: input.node.runId,
    decisionId: world.ids.next("dec"),
    executionNodeId: input.node.executionNodeId,
    agentId: input.agent.agentId,
    context: `ruling on ${context.findingId}`,
    alternatives: [{ summary: ruling === "overturn" ? "uphold" : "overturn" }],
    choice: ruling,
    rationale: "on the evidence",
    reversibility: "reversible",
    checkpointBefore: context.checkpointBefore,
    affectedNodes: [input.node.executionNodeId],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: nowIso(world.environment.clock),
  };
  await helperStores(world, input).decisions.put(decision);
  return { kind: "completed" };
};

interface RigOptions {
  readonly program?: Partial<ProgramContract>;
  /** The examiner's routing, in place of always `EXAMINER`. */
  readonly services?: Partial<
    Pick<ExaminationServices, "examinerRoute" | "strongestExaminerRoute">
  >;
  /** What the org says when no independent examiner can run now, at high risk. */
  readonly whenIndependentUnavailable?: "wait" | "strongest";
  /** The prerequisites as the control plane would answer them, read on every verification. */
  readonly prerequisites?: () => readonly Prerequisite[];
}

const rig = async (scenario: Scenario, options: RigOptions = {}) => {
  let world: World | undefined;
  const seen: Seen = { roles: [], tasks: [], resumes: [], checkouts: [], examinerModels: [] };
  const made = await createWorld({
    harness: createFakeHarness({ script: play(() => world as World, scenario, seen) }),
    ...(options.program === undefined ? {} : { program: options.program }),
    ...(options.whenIndependentUnavailable === undefined
      ? {}
      : {
          examinationPolicy: {
            ...DEFAULT_EXAMINATION_POLICY,
            high: {
              ...DEFAULT_EXAMINATION_POLICY.high,
              whenIndependentUnavailable: options.whenIndependentUnavailable,
            },
          },
        }),
  });
  world = made;
  const services: ExaminationServices = {
    examinerRoute:
      options.services?.examinerRoute ??
      ((input) => {
        if ((input.unavailable ?? []).some((route) => route.model === EXAMINER.model)) {
          throw new Error("no examiner left on the list");
        }
        return choice(EXAMINER);
      }),
    strongestExaminerRoute: options.services?.strongestExaminerRoute ?? (() => choice(EXAMINER)),
    arbiterRoute: () => choice(ARBITER),
    mcp: (identity) => ({
      name: "nightshift",
      command: process.execPath,
      args: [],
      env: {
        ...identity.extraEnv,
        NIGHTSHIFT_ROLE: identity.role,
        NIGHTSHIFT_EXECUTION_TOKEN: identity.executionToken,
      },
    }),
  };
  const book: PrerequisiteBook | undefined =
    options.prerequisites === undefined
      ? undefined
      : {
          prerequisites: async () => options.prerequisites?.() ?? [],
          recordDiscovered: async () => {
            throw new Error("nothing is discovered here");
          },
        };
  const environment: ExecutionEnvironment = {
    ...made.environment,
    examination: services,
    // A wait for a limited examiner passes on the stepping clock, not in real time.
    sleep: async () => {},
    ...(book === undefined ? {} : { prerequisites: book }),
  };
  const engine = createEngine({
    environment,
    session: made.session,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
    route: () => choice(BUILDER),
  });
  const job = JobContractSchema.parse({
    schemaVersion: 1,
    ...made.scope,
    jobContractId: made.ids.next("job"),
    objective: "examined",
    acceptance: ["It works."],
    dependencies: [],
    risk: scenario.risk,
    ambiguity: "low",
    createdAt: nowIso(made.environment.clock),
  });
  const submitted = await engine.submit({
    job,
    depth: 1,
    parentNodeId: made.session.rootNodeId,
    route: choice(BUILDER),
  });
  return {
    world: made,
    environment,
    engine,
    seen,
    job,
    jobId: job.jobContractId,
    nodeId: submitted.nodeId,
  };
};

const settledIdle = async (
  world: World,
  engine: ReturnType<typeof createEngine>,
  nodeId: ExecutionNodeId,
  want?: string,
): Promise<string> => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status =
      (await world.stores.executionNodes.get(world.scope, nodeId))?.status ?? "missing";
    if ((want === undefined ? isSettled(status as never) : status === want) && engine.idle())
      return status;
    if (Date.now() > deadline) throw new Error(`node ${nodeId} is still ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const examinationsOf = async (world: World, nodeId: ExecutionNodeId) =>
  [...(await world.stores.examinations.listByNode(world.scope, nodeId))].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

// ---------------------------------------------------------------------------
// What the tests read back
// ---------------------------------------------------------------------------

/** Waits for `count` examinations of the node, the engine idle, and the node settled. */
const untilExaminations = async (
  world: World,
  engine: ReturnType<typeof createEngine>,
  nodeId: ExecutionNodeId,
  count: number,
): Promise<void> => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const examinations = await examinationsOf(world, nodeId);
    const status = (await world.stores.executionNodes.get(world.scope, nodeId))?.status;
    if (
      examinations.length >= count &&
      status !== undefined &&
      isSettled(status as never) &&
      engine.idle()
    ) {
      return;
    }
    if (Date.now() > deadline)
      throw new Error(`only ${examinations.length} examinations, ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const lifecycleOf = async (world: World): Promise<LifecycleObservation[]> =>
  lifecycleObservationsOf(await eventsOf(world));

const resolutionsOf = (examination: Examination | undefined) =>
  examination?.findings.map((finding) => [finding.id, finding.resolution]);

/** The lifecycle observations a helper's published ledger holds. */
const ledgerLifecycle = async (world: World, role: string, nodeId: ExecutionNodeId) => {
  const summaries = await world.environment.stores.measurements.listByNode(world.scope, nodeId);
  const found: LifecycleObservation[] = [];
  for (const summary of summaries.filter((candidate) => candidate.role === role)) {
    for (const artifactId of summary.ledger.artifactIds) {
      const body = await world.bodies.get(world.scope, artifactId);
      if (body === undefined) continue;
      const chunk = MeasurementLedgerChunkSchema.safeParse(
        JSON.parse(new TextDecoder().decode(body)),
      );
      if (!chunk.success) continue;
      for (const observation of chunk.data.observations) {
        if (observation.kind === "lifecycle") found.push(observation);
      }
    }
  }
  return found;
};

const opsOf = (observations: readonly LifecycleObservation[], phase: string) =>
  observations
    .filter((observation) => observation.phase === phase)
    .map((observation) => [observation.operationId, observation.transition, observation.reason]);

describe("a repeated finding closed by a later attempt's clean examination", () => {
  it("links helpers to what they concern, observes their operations, and closes fixed only on reassessment", async () => {
    const { world, engine, jobId, nodeId, environment } = await rig({
      risk: "medium",
      ask: ["Why is the retry bounded?"],
      findings: (attempt) =>
        attempt === 0
          ? [{ severity: "material" }]
          : attempt === 1
            ? [{ severity: "minor" }, { severity: "material", repeats: true }]
            : [],
    });
    await untilExaminations(world, engine, nodeId, 1);
    expect(await engine.retry(jobId)).toBe(true);
    await untilExaminations(world, engine, nodeId, 2);

    // E2 raised the defect again as F-02: E1's finding is not closed.
    let [e1, e2] = await examinationsOf(world, nodeId);
    expect(e2?.findings[1]?.repeats).toEqual({
      examinationId: e1?.examinationId,
      findingId: "F-01",
    });
    expect(resolutionsOf(e1)).toEqual([["F-01", "unresolved"]]);

    expect(await engine.retry(jobId)).toBe(true);
    expect(await settledIdle(world, engine, nodeId, "integrated")).toBe("integrated");
    const examinations = await examinationsOf(world, nodeId);
    expect(examinations).toHaveLength(3);
    const e3 = examinations[2];
    [e1, e2] = examinations;
    expect(e3?.outcome).toBe("passed");

    // E3 is a later attempt that does not raise it: both are fixed, by E3.
    expect(resolutionsOf(e1)).toEqual([["F-01", "fixed"]]);
    expect(e1?.findings[0]?.resolvedBy).toMatchObject({
      authority: "agent",
      examinationId: e3?.examinationId,
      reason: `not raised again by ${e3?.examinationId}`,
    });
    expect(resolutionsOf(e2)).toEqual([
      ["F-01", "unresolved"],
      ["F-02", "fixed"],
    ]);
    expect(e2?.findings[1]?.resolvedBy?.examinationId).toBe(e3?.examinationId);

    // Helpers say what they concern.
    const routes = await world.stores.routingDecisions.listByNode(world.scope, nodeId);
    const concerning = (purpose: string) =>
      routes
        .filter((route) => route.purpose === purpose)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((route) => route.concerning);
    expect(concerning("examine")).toEqual(
      examinations.map((examination) => ({
        kind: "examination",
        examinationId: examination.examinationId,
      })),
    );
    expect(concerning("answer")).toEqual([
      { kind: "examination", examinationId: e1?.examinationId },
    ]);

    // Lifecycle observations: the examination operation, and the answer under it.
    const observed = await lifecycleOf(world);
    const op = (examinationId: string | undefined) => `examination:${nodeId}:${examinationId}`;
    expect(opsOf(observed, "examination")).toEqual([
      [op(e1?.examinationId), "start", undefined],
      [op(e1?.examinationId), "end", "verdict: findings_raised"],
      [op(e2?.examinationId), "start", undefined],
      [op(e2?.examinationId), "end", "verdict: findings_raised"],
      [op(e3?.examinationId), "start", undefined],
      [op(e3?.examinationId), "end", "verdict: passed"],
    ]);
    const start = observed.find(
      (o) => o.operationId === op(e1?.examinationId) && o.transition === "start",
    );
    expect(start).toMatchObject({
      source: "engine",
      provenance: { adapter: "execution" },
      inclusion: "self",
      executionNodeId: nodeId,
      blockers: [],
    });
    expect(start?.refs?.map((ref) => ref.kind)).toEqual([
      "commit",
      "verification",
      "routing_decision",
    ]);
    expect(start?.refs?.[0]?.ref).toBe(e1?.commitSha);
    expect(start?.refs?.[1]?.ref).toBe(e1?.verificationId);
    expect(opsOf(observed, "answer")).toEqual([
      [`answer:${e1?.examinationId}:1`, "start", undefined],
      [`answer:${e1?.examinationId}:1`, "end", "answered"],
    ]);
    for (const answer of observed.filter((o) => o.phase === "answer")) {
      expect(answer.parentOperationId).toBe(op(e1?.examinationId));
    }

    // And in the helpers' published ledgers.
    const examinerLedger = await ledgerLifecycle(world, "examiner", nodeId);
    expect(opsOf(examinerLedger, "examination")).toEqual(opsOf(observed, "examination"));
    const answererLedger = await ledgerLifecycle(world, "answerer", nodeId);
    expect(opsOf(answererLedger, "answer")).toEqual(opsOf(observed, "answer"));
    expect(environment.examination).toBeDefined();
  }, 120_000);

  it("leaves every earlier occurrence in a three-hop chain unresolved, and links the arbiter to its finding", async () => {
    const { world, engine, jobId, nodeId } = await rig({
      risk: "medium",
      findings: () => [{ severity: "material", repeats: true }],
      ruling: "overturn",
    });
    await untilExaminations(world, engine, nodeId, 1);
    expect(await engine.retry(jobId)).toBe(true);
    await untilExaminations(world, engine, nodeId, 2);
    expect(await engine.retry(jobId)).toBe(true);
    expect(await settledIdle(world, engine, nodeId, "integrated")).toBe("integrated");

    const [e1, e2, e3] = await examinationsOf(world, nodeId);
    expect(e3?.findings[0]?.repeats?.examinationId).toBe(e2?.examinationId);
    expect(e2?.findings[0]?.repeats?.examinationId).toBe(e1?.examinationId);
    expect(resolutionsOf(e1)).toEqual([["F-01", "unresolved"]]);
    expect(resolutionsOf(e2)).toEqual([["F-01", "unresolved"]]);
    expect(resolutionsOf(e3)).toEqual([["F-01", "overturned"]]);

    const routes = await world.stores.routingDecisions.listByNode(world.scope, nodeId);
    expect(
      routes.filter((route) => route.purpose === "arbitrate").map((r) => r.concerning),
    ).toEqual([{ kind: "examination", examinationId: e3?.examinationId, findingId: "F-01" }]);

    const observed = await lifecycleOf(world);
    const arbitration = `arbitration:${e3?.examinationId}:F-01`;
    const parent = `examination:${nodeId}:${e3?.examinationId}`;
    expect(opsOf(observed, "arbitration")).toEqual([
      [arbitration, "start", undefined],
      [arbitration, "end", "overturned"],
    ]);
    const ended = observed.find((o) => o.operationId === arbitration && o.transition === "end");
    expect(ended?.parentOperationId).toBe(parent);
    expect(ended?.refs).toEqual([
      { kind: "decision", ref: e3?.findings[0]?.resolvedBy?.decisionId },
    ]);
    const ledger = await ledgerLifecycle(world, "arbiter", nodeId);
    expect(opsOf(ledger, "arbitration")).toEqual(opsOf(observed, "arbitration"));
  }, 120_000);
});

describe("a strand's plan review", () => {
  it("is linked to the plan decision it reviewed and observed as an operation", async () => {
    const { world, engine, environment, nodeId, job } = await rig({ risk: "low" });
    expect(await settledIdle(world, engine, nodeId)).toBe("integrated");
    const node = (await world.stores.executionNodes.get(world.scope, nodeId)) as ExecutionNode;
    const plan = { decisionId: world.ids.next("dec"), choice: "J1: x", rationale: "because" };
    const worktree = await mkdtemp(join(tmpdir(), "plan-review-"));
    const review = await reviewStrandPlan(environment, {
      session: world.session,
      node,
      job,
      worktree,
      plan: plan as never,
      round: 1,
      builder: BUILDER,
    });
    expect(review).toBeUndefined();

    const routes = await world.stores.routingDecisions.listByNode(world.scope, nodeId);
    expect(routes.filter((route) => route.purpose === "examine").map((r) => r.concerning)).toEqual([
      { kind: "plan_review", decisionId: plan.decisionId },
    ]);
    const observed = await lifecycleOf(world);
    expect(opsOf(observed, "plan_review")).toEqual([
      [`plan_review:${nodeId}:1`, "start", undefined],
      [`plan_review:${nodeId}:1`, "end", "no_review"],
    ]);
  }, 60_000);
});

describe("what a later examination may close", () => {
  /** A settled node to hang hand-built examinations on. */
  const bare = async () => {
    const made = await rig({ risk: "low" });
    expect(await settledIdle(made.world, made.engine, made.nodeId)).toBe("integrated");
    const node = (await made.world.stores.executionNodes.get(
      made.world.scope,
      made.nodeId,
    )) as ExecutionNode;
    const [agent] = await made.world.stores.agents.listByNode(made.world.scope, made.nodeId);
    let clockTick = 0;
    const build = async (spec: {
      readonly fixAttempt: number;
      readonly outcome: Examination["outcome"];
      readonly findings: readonly {
        readonly id: string;
        readonly severity?: "material" | "minor";
        readonly resolution?: Examination["findings"][number]["resolution"];
        readonly repeats?: { examinationId: string; findingId: string };
      }[];
      readonly implementerAgentId?: string;
      readonly followsRulings?: Examination["followsRulings"];
    }): Promise<Examination> => {
      clockTick += 1;
      const base = (
        await made.world.stores.verifications.listByNode(made.world.scope, made.nodeId)
      )[0];
      const examination = ExaminationSchema.parse({
        schemaVersion: 1,
        ...made.world.scope,
        examinationId: made.world.ids.next("exam"),
        executionNodeId: made.nodeId,
        verificationId: base?.verificationId ?? made.world.ids.next("ver"),
        commitSha: "a".repeat(40),
        patchId: "b".repeat(40),
        implementerAgentId: spec.implementerAgentId ?? agent?.agentId,
        examinerAgentId: made.world.ids.next("agent"),
        examinerRoute: EXAMINER,
        requiredByRisk: "medium",
        blocking: true,
        fixAttempt: spec.fixAttempt,
        questions: [],
        ...(spec.followsRulings === undefined ? {} : { followsRulings: spec.followsRulings }),
        outcome: spec.outcome,
        findings: spec.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity ?? "material",
          summary: `finding ${finding.id}`,
          evidence: [{ kind: "contract", clause: "It works." }],
          resolution: finding.resolution ?? "unresolved",
          ...(finding.resolution === "disputed" || finding.resolution === "upheld"
            ? {
                resolvedBy: {
                  authority: "agent",
                  reason: "hand-built",
                  at: "2026-10-21T00:00:00.000Z",
                  ...(finding.resolution === "upheld"
                    ? { decisionId: made.world.ids.next("dec") }
                    : {}),
                },
              }
            : {}),
          ...(finding.repeats === undefined ? {} : { repeats: finding.repeats }),
        })),
        createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, clockTick)).toISOString(),
      });
      await made.world.stores.examinations.put(examination);
      return examination;
    };
    const close = (recorded: Examination) =>
      closeFixedFindings(made.environment, { session: made.world.session, node }, recorded);
    const reread = async (examination: Examination) =>
      (await examinationsOf(made.world, made.nodeId)).find(
        (candidate) => candidate.examinationId === examination.examinationId,
      );
    return { ...made, build, close, reread, agent };
  };

  it("closes nothing on a failed examination with no findings", async () => {
    const t = await bare();
    const e1 = await t.build({
      fixAttempt: 0,
      outcome: "findings_raised",
      findings: [{ id: "F-01" }],
    });
    const e2 = await t.build({ fixAttempt: 1, outcome: "failed", findings: [] });
    await t.close(e2);
    expect(resolutionsOf(await t.reread(e1))).toEqual([["F-01", "unresolved"]]);
  });

  it("closes nothing on an examination of the same attempt, and only material unresolved findings otherwise", async () => {
    const t = await bare();
    const e1 = await t.build({
      fixAttempt: 0,
      outcome: "findings_raised",
      findings: [{ id: "F-01" }, { id: "F-02", severity: "minor" }],
    });
    const sameAttempt = await t.build({ fixAttempt: 0, outcome: "passed", findings: [] });
    await t.close(sameAttempt);
    expect(resolutionsOf(await t.reread(e1))).toEqual([
      ["F-01", "unresolved"],
      ["F-02", "unresolved"],
    ]);
    const later = await t.build({ fixAttempt: 1, outcome: "passed", findings: [] });
    await t.close(later);
    expect(resolutionsOf(await t.reread(e1))).toEqual([
      ["F-01", "fixed"],
      ["F-02", "unresolved"],
    ]);
  });

  it("closes on a different implementer's examination of the same fix attempt number", async () => {
    const t = await bare();
    const e1 = await t.build({
      fixAttempt: 1,
      outcome: "findings_raised",
      findings: [{ id: "F-01" }],
    });
    const other = await t.build({
      fixAttempt: 1,
      outcome: "passed",
      findings: [],
      implementerAgentId: t.world.ids.next("agent"),
    });
    await t.close(other);
    expect(resolutionsOf(await t.reread(e1))).toEqual([["F-01", "fixed"]]);
  });

  it("never touches disputed or upheld findings", async () => {
    const t = await bare();
    const e1 = await t.build({
      fixAttempt: 0,
      outcome: "findings_raised",
      findings: [
        { id: "F-01", resolution: "disputed" },
        { id: "F-02", resolution: "upheld" },
        { id: "F-03" },
      ],
    });
    const e2 = await t.build({ fixAttempt: 1, outcome: "passed", findings: [] });
    await t.close(e2);
    expect(resolutionsOf(await t.reread(e1))).toEqual([
      ["F-01", "disputed"],
      ["F-02", "upheld"],
      ["F-03", "fixed"],
    ]);
  });

  it("lets a ruling-only check close nothing outside its rulings", async () => {
    const t = await bare();
    const e1 = await t.build({
      fixAttempt: 0,
      outcome: "findings_raised",
      findings: [{ id: "F-01" }, { id: "F-02" }],
    });
    const check = await t.build({
      fixAttempt: 1,
      outcome: "passed",
      findings: [],
      followsRulings: [
        {
          findingId: "F-02",
          decisionId: t.world.ids.next("dec"),
          summary: "finding F-02",
          rationale: "it stands",
        },
      ],
    });
    await t.close(check);
    expect(resolutionsOf(await t.reread(e1))).toEqual([
      ["F-01", "unresolved"],
      ["F-02", "fixed"],
    ]);
  });
});
