/**
 * Examination in the execution layer (P8, T3; D-P8-09 … D-P8-15), over the
 * fake harness playing every part (the builder, the examiner, the answering
 * builder, the arbiter), real git, and the production API handler, which holds
 * each verdict and ruling to the agents it stores.
 *
 * The run's policy is the seeded org default: high risk is examined by another
 * provider; medium by a different model; a material finding blocks at both.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGGREGATE_EXAMPLES,
  type Decision,
  type Examination,
  ExaminationSchema,
  type ExecutionNodeId,
  JobContractSchema,
  type Prerequisite,
  type ProgramContract,
  type RiskLevel,
  type RouteChoice,
  type RouteTarget,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  carriedExamination,
  completeJob,
  createEngine,
  createEventOutbox,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  type ExecutionEnvironment,
  FixLimitError,
  type PrerequisiteBook,
  patchIdOf,
  RULING_CONTEXT_ENV,
  type RulingContext,
  resumeDeferred,
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
type Finding = { readonly severity: "material" | "minor"; readonly evidence?: boolean };

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
}

interface Seen {
  readonly roles: string[];
  readonly tasks: HarnessStartInput["task"][];
  readonly resumes: (string | undefined)[];
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
    switch (input.agent.role) {
      case "examiner":
        return examiner(w, input, scenario);
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

const examiner = async (
  world: World,
  input: HarnessStartInput,
  scenario: Scenario,
): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
  const stores = helperStores(world, input);
  if (context.round === 1 && scenario.ask !== undefined) {
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
  const findings = (scenario.findings?.(context.fixAttempt) ?? []).map((finding, index) => ({
    id: `F-0${index + 1}`,
    severity: finding.severity,
    summary: `finding ${index + 1} on attempt ${context.fixAttempt}`,
    evidence:
      finding.evidence === false ? [] : [{ kind: "contract" as const, clause: "It works." }],
    resolution: "unresolved" as const,
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
  /** The prerequisites as the control plane would answer them, read on every verification. */
  readonly prerequisites?: () => readonly Prerequisite[];
}

const rig = async (scenario: Scenario, options: RigOptions = {}) => {
  let world: World | undefined;
  const seen: Seen = { roles: [], tasks: [], resumes: [] };
  const made = await createWorld({
    harness: createFakeHarness({ script: play(() => world as World, scenario, seen) }),
    ...(options.program === undefined ? {} : { program: options.program }),
  });
  world = made;
  const services: ExaminationServices = {
    examinerRoute: () => choice(EXAMINER),
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
    scope: { includes: ["src/**", "test/**"] },
    acceptance: ["It works."],
    dependencies: [],
    risk: scenario.risk,
    ambiguity: "low",
    createdAt: nowIso(made.environment.clock),
  });
  const submitted = await engine.submit({
    job,
    scope: made.session.program.scope,
    depth: 1,
    parentNodeId: made.session.rootNodeId,
    route: choice(BUILDER),
  });
  return {
    world: made,
    environment,
    engine,
    seen,
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

describe("examination beside the merge queue (D-P8-09)", () => {
  it("examines high-risk work by another provider, on a candidate check, and lands it through examination", async () => {
    const { world, engine, seen, nodeId } = await rig({ risk: "high" });
    expect(await settledIdle(world, engine, nodeId)).toBe("integrated");
    expect(seen.roles).toEqual(["worker", "examiner"]);

    const [examination] = await examinationsOf(world, nodeId);
    expect(examination).toMatchObject({
      outcome: "passed",
      blocking: true,
      fixAttempt: 0,
      examinerRoute: EXAMINER,
    });
    expect(examination?.patchId).toMatch(/^[0-9a-f]{40}$/);
    const verifications = await world.stores.verifications.listByNode(world.scope, nodeId);
    expect(verifications.map((verification) => verification.phase ?? "queue").sort()).toEqual([
      "candidate",
      "queue",
    ]);

    // Carried over in the queue: examined once, and sealed through the examination edge.
    const events = (await eventsOf(world)).filter((event) => event.executionNodeId === nodeId);
    expect(events.filter((event) => event.type === "examination.completed")).toHaveLength(1);
    const routes = await world.stores.routingDecisions.listByNode(world.scope, nodeId);
    expect(routes.map((route) => route.purpose ?? "work").sort()).toEqual(["examine", "work"]);
  });

  it("lands low-risk work with no examiner at all (SC-P8-08)", async () => {
    const { world, engine, seen, nodeId } = await rig({ risk: "low" });
    expect(await settledIdle(world, engine, nodeId)).toBe("integrated");
    expect(seen.roles).toEqual(["worker"]);
    expect(await examinationsOf(world, nodeId)).toEqual([]);
  });

  it("stops medium-risk work on a material finding, and a fix lands it (as amended 2026-09-26)", async () => {
    const { world, engine, jobId, nodeId } = await rig({
      risk: "medium",
      findings: (attempt) => (attempt === 0 ? [{ severity: "material" }] : []),
    });
    expect(await settledIdle(world, engine, nodeId)).toBe("failed");
    const [examination] = await examinationsOf(world, nodeId);
    expect(examination).toMatchObject({ blocking: true, outcome: "findings_raised" });
    expect(examination?.examinerRoute.model).not.toBe(BUILDER.model);
    expect(await engine.retry(jobId)).toBe(true);
    expect(await settledIdle(world, engine, nodeId, "integrated")).toBe("integrated");
  });

  it("lands medium-risk work with a minor finding recorded: minor findings never block", async () => {
    const { world, engine, nodeId } = await rig({
      risk: "medium",
      findings: () => [{ severity: "minor" }],
    });
    expect(await settledIdle(world, engine, nodeId)).toBe("integrated");
    const [examination] = await examinationsOf(world, nodeId);
    expect(examination).toMatchObject({ blocking: true, outcome: "findings_raised" });
    expect(examination?.findings[0]?.resolution).toBe("unresolved");
  });

  it("fails the job, not climbing, when the examiner gives no verdict: a finding without evidence is refused", async () => {
    const { world, engine, nodeId } = await rig({
      risk: "high",
      findings: () => [{ severity: "material", evidence: false }],
    });
    expect(await settledIdle(world, engine, nodeId)).toBe("failed");
    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.outcomeReason).toMatch(/^examiner_failed: /);
  });
});

describe("a blocking finding: fixes, the limit, the arbiter (D-P8-13)", () => {
  it("fails the job with the findings, and a retry is a fix that is examined again", async () => {
    const { world, engine, seen, jobId, nodeId } = await rig({
      risk: "high",
      findings: (attempt) => (attempt === 0 ? [{ severity: "material" }] : []),
    });
    expect(await settledIdle(world, engine, nodeId)).toBe("failed");
    expect((await world.stores.executionNodes.get(world.scope, nodeId))?.outcomeReason).toMatch(
      /^examination_failed: 1 material finding/,
    );

    expect(await engine.retry(jobId)).toBe(true);
    expect(await settledIdle(world, engine, nodeId, "integrated")).toBe("integrated");
    const fix = seen.tasks[seen.roles.lastIndexOf("worker")];
    expect(fix?.kind).toBe("fix");
    const examinations = await examinationsOf(world, nodeId);
    expect(
      examinations.map((examination) => [examination.fixAttempt, examination.outcome]),
    ).toEqual([
      [0, "findings_raised"],
      [1, "passed"],
    ]);
  });

  it("after two fixes, sends a finding still standing to an arbiter; upheld, it carries the ruling out itself and lands", async () => {
    const { world, engine, seen, jobId, nodeId } = await rig({
      risk: "high",
      findings: () => [{ severity: "material" }],
      ruling: "uphold",
    });
    expect(await settledIdle(world, engine, nodeId)).toBe("failed");
    for (const _fix of [1, 2]) {
      expect(await engine.retry(jobId)).toBe(true);
      if (_fix === 1) expect(await settledIdle(world, engine, nodeId, "failed")).toBe("failed");
    }
    // The arbiter upholds after the second fix, and nobody retries: the engine
    // starts the attempt that carries the ruling out, and it lands (as amended
    // 2026-09-25: the arbiter is final, and the run keeps building on it).
    expect(await settledIdle(world, engine, nodeId, "integrated")).toBe("integrated");

    const examinations = await examinationsOf(world, nodeId);
    expect(examinations.map((examination) => examination.fixAttempt)).toEqual([0, 1, 2, 2]);
    const [upheld] = examinations[2]?.findings ?? [];
    expect(upheld?.resolution).toBe("upheld");
    const check = examinations[3];
    expect(check?.followsRulings).toEqual([
      expect.objectContaining({
        findingId: upheld?.id,
        decisionId: upheld?.resolvedBy?.decisionId,
      }),
    ]);
    // A material finding the ruling was not about is recorded and does not block.
    expect(check?.findings.map((finding) => [finding.severity, finding.concerns])).toEqual([
      ["material", undefined],
    ]);
    const carried = seen.tasks[seen.roles.lastIndexOf("worker")];
    expect(carried).toMatchObject({ kind: "fix", rulings: [{ findingId: upheld?.id }] });
    // Whoever retries after it has landed finds nothing to do.
    expect(await engine.retry(jobId)).toBe(false);
  });

  it("carries out a ruling on a dispute it upholds, and never takes a dispute of the ruling's check", async () => {
    const { world, engine, jobId, nodeId } = await rig({
      risk: "high",
      findings: () => [{ severity: "material" }],
      ruling: "uphold",
      rulingCarried: () => false,
    });
    expect(await settledIdle(world, engine, nodeId)).toBe("failed");
    const result = await engine.dispute(jobId, "the retry loop is bounded by the caller");
    expect(result.kind).toBe("upheld");

    // Two attempts at the ruling, neither carrying it out: the work's failure.
    const deadline = Date.now() + 60_000;
    let examinations = await examinationsOf(world, nodeId);
    while (
      examinations.filter((examination) => examination.followsRulings !== undefined).length < 2 ||
      !engine.idle()
    ) {
      if (Date.now() > deadline) throw new Error("the ruling was not carried out twice");
      await new Promise((resolve) => setTimeout(resolve, 20));
      examinations = await examinationsOf(world, nodeId);
    }
    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.status).toBe("failed");
    expect(node?.outcomeReason).toMatch(/^examination_ruling_unmet: /);
    await expect(engine.retry(jobId)).rejects.toBeInstanceOf(FixLimitError);
    // The ruling is final: its check is not argued again.
    const again = await engine.dispute(jobId, "it is carried out");
    expect(again).toMatchObject({ kind: "refused" });
    expect(again.kind === "refused" ? again.reason : "").toMatch(/ruling is final/);
  });

  it("never carries over an examination whose finding was upheld", () => {
    const upheld = {
      ...(structuredClone(AGGREGATE_EXAMPLES.Examination) as Examination),
      blocking: true,
    };
    const withRuling: Examination = {
      ...upheld,
      findings: upheld.findings.map((finding) => ({
        ...finding,
        severity: "material" as const,
        resolution: "upheld" as const,
      })),
    };
    expect(carriedExamination([withRuling], withRuling.patchId)).toBeUndefined();
  });

  it("lands the examined work as it is when a dispute is overturned, the ruling a rollback point", async () => {
    const { world, engine, seen, jobId, nodeId } = await rig({
      risk: "high",
      findings: () => [{ severity: "material" }],
      ruling: "overturn",
    });
    expect(await settledIdle(world, engine, nodeId)).toBe("failed");
    const [before] = await examinationsOf(world, nodeId);

    const result = await engine.dispute(jobId, "the retry loop is bounded by the caller");
    expect(result).toEqual({ kind: "overturned", nodeId });
    expect(await settledIdle(world, engine, nodeId, "integrated")).toBe("integrated");
    // No worker ran again: the commit that landed is the one that was examined.
    expect(seen.roles.filter((role) => role === "worker")).toHaveLength(1);
    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.commitSha).toBe(before?.commitSha);

    const [ruled] = await examinationsOf(world, nodeId);
    const decisionId = ruled?.findings[0]?.resolvedBy?.decisionId;
    expect(ruled?.findings[0]?.resolution).toBe("overturned");
    // Its rollback point on both sides once the work has landed, written just after it does.
    const deadline = Date.now() + 30_000;
    let decision =
      decisionId === undefined
        ? undefined
        : await world.stores.decisions.get(world.scope, decisionId);
    while (
      decision?.checkpointAfter === undefined &&
      decisionId !== undefined &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      decision = await world.stores.decisions.get(world.scope, decisionId);
    }
    expect(decision).toMatchObject({ authority: "agent", choice: "overturn" });
    expect(decision?.checkpointAfter).toBeDefined();
    expect(decision?.checkpointAfter).not.toBe(decision?.checkpointBefore);
  });
});

describe("the examiner's questions to the builder (D-P8-15)", () => {
  it("resumes the builder's own session to answer, then the examiner's, and records both", async () => {
    const { world, engine, seen, nodeId } = await rig({
      risk: "high",
      ask: ["Is the retry bounded on purpose?"],
    });
    const status = await settledIdle(world, engine, nodeId);
    expect(
      status,
      (await world.stores.executionNodes.get(world.scope, nodeId))?.outcomeReason,
    ).toBe("integrated");
    expect(seen.roles).toEqual(["worker", "examiner", "answerer", "examiner"]);
    expect(seen.resumes.slice(1)).toEqual([undefined, "builder-session", "examiner-session"]);
    const [examination] = await examinationsOf(world, nodeId);
    expect(examination?.questions).toEqual([
      {
        question: "Is the retry bounded on purpose?",
        answer: "deliberate, from memory",
        answeredBy: "resumed_session",
      },
    ]);
  });

  it("answers from the builder's transcript when its session cannot be resumed, and says so", async () => {
    const { world, engine, nodeId } = await rig({
      risk: "high",
      ask: ["Why no test for the error path?"],
      builderSession: false,
    });
    expect(await settledIdle(world, engine, nodeId)).toBe("integrated");
    const [examination] = await examinationsOf(world, nodeId);
    expect(examination?.questions[0]).toMatchObject({ answeredBy: "transcript" });
  });
});

describe("the patch id (D-P8-09, D-P8-12)", () => {
  const diffAt = (line: number, body: string) =>
    [
      "diff --git a/src/a.js b/src/a.js",
      "index 1111111..2222222 100644",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      `@@ -${line},2 +${line},3 @@`,
      " const a = 1;",
      `+${body}`,
      " const b = 2;",
    ].join("\n");

  it("is the same for the same change wherever it sits, and different for a different change", () => {
    expect(patchIdOf(diffAt(3, "const c = 3;"))).toBe(patchIdOf(diffAt(40, "const c = 3;")));
    expect(patchIdOf(diffAt(3, "const c = 3;"))).not.toBe(patchIdOf(diffAt(3, "const c = 4;")));
  });
});

describe("examination and deferral compose, in that order (D-P8-14)", () => {
  const HP01 = (status: "pending" | "satisfied"): Prerequisite => ({
    id: "HP-01",
    description: "The deploy credential is in place.",
    remediation: "Ask the owner.",
    verifyCommand: "true",
    status,
    ...(status === "satisfied"
      ? { lastCheck: { exitCode: 0, checkedAt: "2026-09-25T00:00:00.000Z" } }
      : {}),
  });
  const GATED: Partial<ProgramContract> = {
    verification: [
      { id: "test", command: "node --test" },
      { id: "gate", command: 'node -e "process.exit(0)"', requires: ["HP-01"] },
    ],
    prerequisites: [HP01("pending")],
  };
  const deferred = async () => {
    let met = false;
    const r = await rig(
      { risk: "high" },
      { program: GATED, prerequisites: () => [HP01(met ? "satisfied" : "pending")] },
    );
    expect(await settledIdle(r.world, r.engine, r.nodeId, "deferred")).toBe("deferred");
    return { ...r, meet: () => (met = true) };
  };

  it("examines nothing while the checks are deferred, and examines at resume once they pass", async () => {
    const r = await deferred();
    // Never examined on unverified work: nothing yet.
    expect(await examinationsOf(r.world, r.nodeId)).toEqual([]);
    expect(r.seen.roles).not.toContain("examiner");

    r.meet();
    const result = await resumeDeferred(r.environment, r.world.session);
    expect(result, JSON.stringify(result)).toEqual({ landed: [r.nodeId], retried: [], failed: [] });
    expect(await r.world.stores.executionNodes.get(r.world.scope, r.nodeId)).toMatchObject({
      status: "integrated",
    });
    const [examination] = await examinationsOf(r.world, r.nodeId);
    expect(examination).toMatchObject({
      outcome: "passed",
      blocking: true,
      examinerRoute: { provider: "openai" },
    });
  }, 60_000);

  it("leaves it deferred, saying why, when the resume has no examiner to run", async () => {
    const r = await deferred();
    r.meet();
    const { examination: _none, ...without } = r.environment;
    const result = await resumeDeferred(without, r.world.session);
    expect(result.landed).toEqual([]);
    expect(result.stoppedAt).toMatchObject({ nodeId: r.nodeId, kind: "refused" });
    expect(result.stoppedAt?.reason).toMatch(/^awaiting_examination: /);
    expect(await r.world.stores.executionNodes.get(r.world.scope, r.nodeId)).toMatchObject({
      status: "deferred",
    });
  }, 60_000);
});
