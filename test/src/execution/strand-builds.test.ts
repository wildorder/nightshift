/**
 * A strand built as P18 builds it (D-P18-01 … D-P18-06), through the real
 * engine, runner, merge queue, verification, examination and git, with a fake
 * harness.
 *
 * The strand's orchestrator is scripted to write exactly the records its tools
 * write — its job plan as a decision, each job as a Job Contract and a
 * `validated` node, its own node `implemented` at its branch's head — so what
 * is under test is the engine's side of each: the plan reviewed before
 * anything is built, a dependent job held until its dependency has merged, the
 * jobs merged onto the strand's branch with no verification of their own, the
 * strand landing once, and a failed landing — red gates, or a blocking finding
 * of its examination — handed back to the same session.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_EXAMINATION_POLICY,
  ExaminationSchema,
  type ExecutionNode,
  type ExecutionNodeId,
  type JobContract,
  type JobContractId,
  JobContractSchema,
  type RiskLevel,
  type RouteChoice,
  type RouteTarget,
} from "@nightshift/contracts";
import { isSettled, markImplemented, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  type ExecutionEnvironment,
  git,
  PLAN_REVIEW_FILE_ENV,
  planReviewVerdictOf,
  planStateOf,
  recordWorkerDecision,
  STRAND_PLAN_CONTEXT,
  type StrandMove,
} from "@nightshift/execution";
import type { AgentTask, HarnessExit, HarnessStartInput } from "@nightshift/harness";
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
  ruleId: "p5-configured",
  wasOverride: false,
});
const ROUTE = choice(target("anthropic", "claude-sonnet-5"));
const EXAMINER = target("openai", "gpt-6-astra");

const mcp = () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} });

const until = async <T>(what: string, read: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A test the program's `node --test` gate runs, red until the fix removes it. */
const RED_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'test("j2 left this wrong", () => { assert.equal(1, 2); });',
  "",
].join("\n");

const MISSED = "the strand misses an answer its acceptance asks for";

interface Built {
  readonly world: World;
  readonly starts: HarnessStartInput[];
  readonly delegated: Map<string, JobContractId>;
  readonly strandNodeId: ExecutionNodeId;
  readonly final: ExecutionNode;
  /** Every move of a strand's branch the engine asked to publish (A-60). */
  readonly moves: StrandMove[];
  readonly close: () => Promise<unknown>;
}

/**
 * A strand of two jobs, J2 on J1, built until it settles. With `redTest`, J2
 * leaves a failing test behind; with `examined`, the strand's risk is medium,
 * examined under the seeded policy, and each examination's verdict is
 * `examined(round)`: a material finding, or none.
 */
const buildStrand = async (options: {
  readonly redTest: boolean;
  readonly examined?: (round: number) => "material" | "clean";
  /** What the plan reviewer writes to the file it is given; nothing when absent. */
  readonly review?: string;
}): Promise<Built> => {
  let world: World | undefined;
  const starts: HarnessStartInput[] = [];
  const moves: StrandMove[] = [];
  const delegated = new Map<string, JobContractId>();
  let examinations = 0;
  let fixes = 0;

  const outboxFor = (context: ScriptContext) =>
    createEventOutbox({
      events: (world as World).stores.events,
      scope: context.identity.scope,
      clock: (world as World).environment.clock,
      ids: (world as World).ids,
      writerId: context.identity.agentId,
      initialDelayMs: 1,
    });

  /** `delegate`, as the strand orchestrator's tool writes it. */
  const delegate = async (
    context: ScriptContext,
    name: string,
    objective: string,
    dependsOn: readonly string[] = [],
  ): Promise<void> => {
    const w = world as World;
    const at = nowIso(w.environment.clock);
    const job: JobContract = JobContractSchema.parse({
      schemaVersion: 1,
      ...w.scope,
      jobContractId: w.ids.next("job"),
      objective,
      acceptance: ["node --test passes"],
      dependencies: dependsOn.map((dependency) => delegated.get(dependency)),
      risk: "low",
      ambiguity: "low",
      createdAt: at,
    });
    await w.stores.jobContracts.put(job);
    const node: ExecutionNode = {
      schemaVersion: 1,
      ...w.scope,
      executionNodeId: w.ids.next("node"),
      kind: "job",
      parentNodeId: context.identity.executionNodeId,
      depth: 2,
      status: "validated",
      jobContractId: job.jobContractId,
      commitSha: null,
      createdAt: at,
      updatedAt: at,
    };
    await w.stores.executionNodes.put(node);
    delegated.set(name, job.jobContractId);
  };

  const statusOf = async (name: string): Promise<string | undefined> => {
    const w = world as World;
    const nodes = (await w.stores.executionNodes.listByRun(w.scope)).items;
    return nodes.find((node) => node.jobContractId === delegated.get(name))?.status;
  };

  /** `subprogram.complete`: its node implemented at its branch's head. */
  const complete = async (context: ScriptContext): Promise<void> => {
    const w = world as World;
    const head = (await git(w.git, ["rev-parse", "HEAD"], { cwd: context.worktree })).trim();
    const node = await w.stores.executionNodes.get(w.scope, context.identity.executionNodeId);
    await w.stores.executionNodes.put(
      markImplemented(node as ExecutionNode, head as never, nowIso(w.environment.clock)),
    );
  };

  const orchestrate = async (context: ScriptContext): Promise<HarnessExit> => {
    const w = world as World;
    const task = context.input.task as AgentTask | undefined;
    if (task?.kind === "strand_fix") {
      // The same session, told exactly what failed (D-P18-05).
      fixes += 1;
      const name = `F${fixes}`;
      await delegate(
        context,
        name,
        task.findings.length > 0 ? "[answer] Answer the finding." : "[fix] Remove j2's wrong test.",
      );
      await until(`${name} to merge`, async () =>
        (await statusOf(name)) === "merged" ? true : undefined,
      );
      await complete(context);
      return { kind: "completed", sessionId: "strand-session" };
    }
    // The plan, as strand.plan records it, and its review waited for (D-P18-01).
    const outbox = outboxFor(context);
    await recordWorkerDecision(
      { stores: w.stores, clock: w.environment.clock, git: w.git, outbox },
      context.identity,
      w.ids,
      {
        context: `${STRAND_PLAN_CONTEXT} round 1 — 2 jobs, 1 starting at once`,
        alternatives: [{ summary: "the plan as authored" }],
        choice: "J1: the a module\nJ2: the b module, on J1",
        rationale: "J2 needs J1's module.",
        reversibility: "reversible",
      },
    );
    await outbox.flush();
    await until("the plan's review", async () => {
      const state = await planStateOf(w.environment, w.scope, context.identity.executionNodeId);
      return state.reviews.length > 0 ? true : undefined;
    });
    await delegate(context, "J1", "[a] Add the a module.");
    await delegate(context, "J2", "[b] Add the b module, which needs a.", ["J1"]);
    await until("both jobs to merge", async () =>
      (await statusOf("J1")) === "merged" && (await statusOf("J2")) === "merged" ? true : undefined,
    );
    await complete(context);
    return { kind: "completed", sessionId: "strand-session" };
  };

  const work = async (context: ScriptContext): Promise<HarnessExit> => {
    const objective = context.input.job.objective;
    const file = (name: string, text: string) => writeFile(join(context.worktree, name), text);
    if (objective.startsWith("[a]")) await file("src/a.js", "export const a = 1;\n");
    if (objective.startsWith("[b]")) {
      await file("src/b.js", 'import { a } from "./a.js";\nexport const b = a + 1;\n');
      if (options.redTest) await file("test/b.test.js", RED_TEST);
    }
    if (objective.startsWith("[fix]")) {
      await git((world as World).git, ["rm", "-q", "test/b.test.js"], { cwd: context.worktree });
    }
    if (objective.startsWith("[answer]")) await file("src/answer.js", "export const ok = 1;\n");
    const outbox = outboxFor(context);
    await completeJob(
      {
        stores: (world as World).stores,
        clock: (world as World).environment.clock,
        git: (world as World).git,
        outbox,
      },
      context.identity,
      objective,
    );
    await outbox.flush();
    return { kind: "completed" };
  };

  /** The strand's examiner: its verdict, recorded through its own token. */
  const examine = async (input: HarnessStartInput): Promise<HarnessExit> => {
    const w = world as World;
    examinations += 1;
    const context = JSON.parse(
      input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}",
    ) as ExaminationContext;
    const stores = createHttpStores({
      transport: createFetchTransport({
        endpoint: w.plane.url,
        tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
      }),
    });
    const findings =
      options.examined?.(examinations) === "material"
        ? [
            {
              id: "F-01",
              severity: "material" as const,
              summary: MISSED,
              evidence: [{ kind: "contract" as const, clause: "node --test passes" }],
              resolution: "unresolved" as const,
            },
          ]
        : [];
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
        outcome: findings.length === 0 ? "passed" : "findings_raised",
        findings,
        createdAt: nowIso(w.environment.clock),
      }),
    );
    return { kind: "completed", sessionId: "examiner-session" };
  };

  world = await createWorld({
    // A strand delegates its jobs one level below itself.
    program: { delegationLimits: { maxDepth: 2, maxConcurrency: 2 } },
    ...(options.examined === undefined ? {} : { examinationPolicy: DEFAULT_EXAMINATION_POLICY }),
    harness: createFakeHarness({
      script: (context) => {
        starts.push(context.input);
        if (context.input.agent.role === "examiner") {
          // A plan review hands its verdict back in a file; writing none, the
          // plan is recorded as not reviewed and the strand builds (D-P18-01).
          if (context.input.task?.kind === "review_plan") {
            const file = context.input.mcp?.env[PLAN_REVIEW_FILE_ENV];
            return options.review === undefined || file === undefined
              ? Promise.resolve({ kind: "completed" as const })
              : writeFile(file, options.review).then(() => ({ kind: "completed" as const }));
          }
          return examine(context.input);
        }
        return context.input.node.kind === "sub-program" ? orchestrate(context) : work(context);
      },
    }),
  });
  const w = world;
  const services: ExaminationServices = {
    examinerRoute: () => choice(EXAMINER),
    strongestExaminerRoute: () => choice(EXAMINER),
    arbiterRoute: () => choice(EXAMINER),
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
  const environment: ExecutionEnvironment = {
    ...w.environment,
    ...(options.examined === undefined ? {} : { examination: services }),
    publishStrand: async (move) => {
      moves.push(move);
    },
  };
  const engine = createEngine({
    environment,
    session: w.session,
    mcp,
    route: () => ROUTE,
    discoveryIntervalMs: 50,
  });
  const risk: RiskLevel = options.examined === undefined ? "low" : "medium";
  const strand = await engine.submit({
    job: JobContractSchema.parse({
      schemaVersion: 1,
      ...w.scope,
      jobContractId: w.ids.next("job"),
      objective: "The a and b modules.",
      acceptance: ["node --test passes"],
      dependencies: [],
      risk,
      ambiguity: "low",
      kind: "orchestrate",
      createdAt: nowIso(w.environment.clock),
    }),
    depth: 1,
    parentNodeId: w.session.rootNodeId,
    route: ROUTE,
    kind: "sub-program",
  });
  const strandNodeId = strand.nodeId as ExecutionNodeId;
  const final = await until("the strand to settle", async () => {
    const node = await w.stores.executionNodes.get(w.scope, strandNodeId);
    return node !== undefined && isSettled(node.status) && engine.idle() ? node : undefined;
  });
  return {
    world: w,
    starts,
    moves,
    delegated,
    strandNodeId,
    final,
    close: () => engine.close("the test is done"),
  };
};

const programFiles = (w: World) =>
  git(w.git, ["ls-tree", "-r", "--name-only", w.session.program.repository.programBranch], {
    cwd: w.session.repoPath,
  });

describe("a strand built as P18 builds it", () => {
  it("reviews its plan, holds a dependent job, merges its jobs, and lands once after its own session fixes a red landing", async () => {
    const built = await buildStrand({ redTest: true });
    const w = built.world;

    // It landed once its own session fixed it.
    expect(built.final.status, built.final.outcomeReason).toBe("integrated");
    const events = await eventsOf(w);

    // D-P18-01: reviewed (here by nobody, so recorded as such) before anything was built.
    const state = await planStateOf(w.environment, w.scope, built.strandNodeId);
    expect(state.plans).toHaveLength(1);
    expect(state.reviews).toHaveLength(1);

    // D-P18-02: J2 started only once J1 had merged.
    const nodes = (await w.stores.executionNodes.listByRun(w.scope)).items;
    const nodeOf = (name: string) =>
      nodes.find((node) => node.jobContractId === built.delegated.get(name));
    const indexOf = (type: string, name: string) =>
      events.findIndex(
        (event) => event.type === type && event.executionNodeId === nodeOf(name)?.executionNodeId,
      );
    expect(indexOf("node.merged", "J1")).toBeGreaterThan(-1);
    expect(indexOf("node.started", "J2")).toBeGreaterThan(indexOf("node.merged", "J1"));

    // D-P18-03: each job merged, and verified nothing of its own.
    for (const name of ["J1", "J2", "F1"]) {
      const node = nodeOf(name) as ExecutionNode;
      expect(node.status, name).toBe("merged");
      expect(await w.stores.verifications.listByNode(w.scope, node.executionNodeId), name).toEqual(
        [],
      );
    }

    // D-P18-04, D-P18-05: the strand's first landing was red; the same session
    // was resumed with the failing gate, and its second landing passed.
    const landings = await w.stores.verifications.listByNode(w.scope, built.strandNodeId);
    expect(landings.map((verification) => verification.outcome)).toEqual(["failed", "passed"]);
    const orchestrations = built.starts.filter((input) => input.agent.role === "orchestrator");
    expect(orchestrations).toHaveLength(2);
    expect(orchestrations[1]?.resume).toEqual({ sessionId: "strand-session" });
    const fix = orchestrations[1]?.task;
    expect(fix?.kind).toBe("strand_fix");
    if (fix?.kind === "strand_fix") {
      expect(fix.failedChecks.map((check) => check.stepId)).toContain("test");
      expect(fix.failedChecks[0]?.output).toContain("j2 left this wrong");
    }

    // A-60: every move of the strand's branch went to be published, each job's
    // merge among them, and the last at the head that landed.
    const strandRef = `nightshift/${w.scope.runId}/${built.strandNodeId}`;
    expect(built.moves.every((move) => move.branch === strandRef)).toBe(true);
    expect(built.moves.length).toBeGreaterThanOrEqual(3);
    expect(built.moves.at(-1)?.head).toBe(built.final.commitSha);

    // The program branch has the strand's work, and not the test the fix removed.
    const files = await programFiles(w);
    expect(files).toContain("src/a.js");
    expect(files).toContain("src/b.js");
    expect(files).not.toContain("test/b.test.js");
    await built.close();
  }, 120_000);

  it("is examined as a whole, with its orchestrator as its builder, and lands once its own session answers a blocking finding", async () => {
    // admin-redesign, 2026-10-18: a strand's examination looked for a worker on
    // the strand's node and found none, and the retry its fix round needed was
    // refused from examination_failed, because it let go of a verified commit.
    const built = await buildStrand({
      redTest: false,
      examined: (round) => (round === 1 ? "material" : "clean"),
    });
    const w = built.world;
    expect(built.final.status, built.final.outcomeReason).toBe("integrated");

    const examinations = [
      ...(await w.stores.examinations.listByNode(w.scope, built.strandNodeId)),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(examinations.map((examination) => examination.outcome)).toEqual([
      "findings_raised",
      "passed",
    ]);
    // The builder it judged is the strand's orchestrator, on the strand's node.
    const orchestrators = (await w.stores.agents.listByNode(w.scope, built.strandNodeId)).filter(
      (agent) => agent.role === "orchestrator",
    );
    expect(orchestrators.map((agent) => agent.agentId)).toContain(
      examinations[0]?.implementerAgentId,
    );

    // The finding went back to the same session, as its strand fix.
    const fixes = built.starts.filter(
      (input) => input.agent.role === "orchestrator" && input.task?.kind === "strand_fix",
    );
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.resume).toEqual({ sessionId: "strand-session" });
    const task = fixes[0]?.task;
    expect(task?.kind === "strand_fix" ? task.findings.map((f) => f.summary) : []).toEqual([
      MISSED,
    ]);
    expect(await programFiles(w)).toContain("src/answer.js");
    await built.close();
  }, 120_000);
});

describe("a strand plan review's verdict (PIP-32)", () => {
  const reviewOf = async (review: string) => {
    const built = await buildStrand({ redTest: false, examined: () => "clean", review });
    const state = await planStateOf(built.world.environment, built.world.scope, built.strandNodeId);
    await built.close();
    expect(state.reviews).toHaveLength(1);
    return state.reviews[0] as NonNullable<(typeof state.reviews)[0]>;
  };

  it("carries a revise's findings in the recorded review", async () => {
    const review = await reviewOf(
      JSON.stringify({
        verdict: "revise",
        summary: "J1 and J2 collide.",
        findings: [
          { severity: "material", summary: "J1 and J2 both change src/a.js", jobs: ["J1"] },
        ],
      }),
    );
    expect(planReviewVerdictOf(review)).toBe("revise");
    expect(review.choice).toContain("- [MATERIAL] J1 and J2 both change src/a.js (J1)");
  }, 120_000);

  it("takes a revise that names nothing to change as sound", async () => {
    const review = await reviewOf(
      JSON.stringify({ verdict: "revise", summary: "Looks off.", findings: [] }),
    );
    expect(planReviewVerdictOf(review)).toBe("sound");
  }, 120_000);

  it("records a review it cannot read as undeliverable, not as not reviewed", async () => {
    const review = await reviewOf("{ this is not a review");
    expect(planReviewVerdictOf(review)).toBe("undeliverable");
    expect(review.choice).toContain("could not be read");
  }, 120_000);
});
