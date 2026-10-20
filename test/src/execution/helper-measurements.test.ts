/**
 * Measurement of the helper agents (P20 S-01): an examiner, an answerer and an
 * arbiter each own a recorder spanning their launches. The rig is the
 * examination rig's: a fake harness through the real HTTP plane, whose scripts
 * emit observations through `input.measurements` and return exits with usage.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ExaminationSchema,
  JobContractSchema,
  type MeasurementCounters,
  type MeasurementSummary,
  type RouteChoice,
  type RouteTarget,
  type RoutingDecision,
} from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  type ExecutionEnvironment,
} from "@nightshift/execution";
import type { Harness, HarnessExit, HarnessStartInput } from "@nightshift/harness";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld, type World } from "./world.js";

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

/** A harness-sourced observation of session-scoped counters, as an adapter would report. */
const sessionSnapshot = (observationId: string, counters: MeasurementCounters) =>
  ({
    kind: "cumulative_snapshot",
    schemaVersion: 1,
    observationId,
    source: "harness",
    provenance: { adapter: "test" },
    inclusion: "self",
    counters,
    counterScope: "session",
  }) as const;

interface Scenario {
  /** Counters the builder's stored summary holds for its session; absent means no summary. */
  readonly builderSessionInput?: number;
  /** Whether the builder's session can be resumed by the answerer. */
  readonly resumableBuilder?: boolean;
  /** What each examiner round reports. */
  readonly examiner?: {
    readonly round1: { readonly input: number; readonly output: number };
    readonly round2: {
      readonly input: number;
      readonly output: number;
      /** The session-scoped input the second round reports through the sink. */
      readonly sessionInput?: number;
      readonly sessionInputRound1?: number;
    };
  };
  /** What the answerer reports through the sink and its exit. */
  readonly answerer?: { readonly sessionInput?: number; readonly fail?: boolean };
  /** The examiner's launch cannot be attempted. */
  readonly examinerCannotLaunch?: boolean;
  readonly ask?: readonly string[];
}

const helperStores = (world: World, input: HarnessStartInput) =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });

const play =
  (world: () => World, scenario: Scenario) =>
  async (context: ScriptContext): Promise<HarnessExit> => {
    const { input } = context;
    const w = world();
    switch (input.agent.role) {
      case "examiner":
        return examiner(w, input, scenario);
      case "answerer": {
        if (scenario.answerer?.sessionInput !== undefined) {
          input.measurements?.observe(
            sessionSnapshot("answer-session", { inputTokens: scenario.answerer.sessionInput }),
          );
        }
        if (input.resume !== undefined && scenario.resumableBuilder === false) {
          return { kind: "failed", exitCode: 1 };
        }
        const task = input.task;
        const questions = task?.kind === "answer" ? task.questions : [];
        return {
          kind: "completed",
          result: JSON.stringify(questions.map((question) => ({ question, answer: "deliberate" }))),
          sessionId: "answerer-session",
          usage: { inputTokens: 1 },
        };
      }
      default: {
        const outbox = createEventOutbox({
          events: w.stores.events,
          scope: context.identity.scope,
          clock: w.environment.clock,
          ids: w.ids,
          writerId: context.identity.agentId,
          initialDelayMs: 1,
        });
        await writeFile(join(context.worktree, "src", "measured.js"), "export const m = 1;\n");
        await completeJob(
          { stores: w.stores, clock: w.environment.clock, git: w.git, outbox },
          context.identity,
          "measured: done",
        );
        await outbox.flush();
        if (scenario.builderSessionInput !== undefined) {
          // The session snapshot, delivered through the seam the runner's recorder owns.
          input.measurements?.observe({
            ...sessionSnapshot("builder-session", { inputTokens: scenario.builderSessionInput }),
            sessionId: "builder-session",
          });
        }
        return { kind: "completed", sessionId: "builder-session" };
      }
    }
  };

const examiner = async (
  world: World,
  input: HarnessStartInput,
  scenario: Scenario,
): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
  const shape = scenario.examiner;
  if (context.round === 1 && scenario.ask !== undefined) {
    const stores = helperStores(world, input);
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
    if (shape?.round2.sessionInputRound1 !== undefined) {
      input.measurements?.observe(
        sessionSnapshot("ex-1", { inputTokens: shape.round2.sessionInputRound1 }),
      );
    }
    return {
      kind: "completed",
      sessionId: "examiner-session",
      usage: { inputTokens: shape?.round1.input ?? 0, outputTokens: shape?.round1.output ?? 0 },
    };
  }
  if (shape?.round2.sessionInput !== undefined) {
    input.measurements?.observe(
      sessionSnapshot("ex-2", { inputTokens: shape.round2.sessionInput }),
    );
  }
  await helperStores(world, input).examinations.put(
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
      outcome: "passed",
      findings: [],
      createdAt: nowIso(world.environment.clock),
    }),
  );
  return {
    kind: "completed",
    sessionId: "examiner-session",
    usage: {
      inputTokens: shape?.round2.input ?? 0,
      outputTokens: shape?.round2.output ?? 0,
    },
  };
};

const rig = async (scenario: Scenario) => {
  let world: World | undefined;
  const fake = createFakeHarness({ script: play(() => world as World, scenario) });
  const harness: Harness = {
    ...fake,
    start: async (input) => {
      if (scenario.examinerCannotLaunch === true && input.agent.role === "examiner") {
        throw new Error("the adapter could not attempt a launch");
      }
      return fake.start(input);
    },
  };
  const made = await createWorld({ harness });
  world = made;
  const services: ExaminationServices = {
    examinerRoute: () => choice(EXAMINER),
    strongestExaminerRoute: () => choice(EXAMINER),
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
  const environment: ExecutionEnvironment = {
    ...made.environment,
    examination: services,
    sleep: async () => {},
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
    objective: "measured",
    acceptance: ["It works."],
    dependencies: [],
    risk: "high",
    ambiguity: "low",
    createdAt: nowIso(made.environment.clock),
  });
  const submitted = await engine.submit({
    job,
    depth: 1,
    parentNodeId: made.session.rootNodeId,
    route: choice(BUILDER),
  });
  // Until the examiner's routing decision has an outcome, and the engine has nothing left to do.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const routes = await made.stores.routingDecisions.listByNode(made.scope, submitted.nodeId);
    const examining = routes.filter((route) => route.purpose === "examine");
    if (examining.length > 0 && examining.every((r) => r.outcome !== "pending") && engine.idle()) {
      break;
    }
    if (Date.now() > deadline) throw new Error("the examination did not finish");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const summaries = await made.environment.stores.measurements.listByNode(
    made.scope,
    submitted.nodeId,
  );
  const routes = await made.stores.routingDecisions.listByNode(made.scope, submitted.nodeId);
  const agents = await made.stores.agents.listByNode(made.scope, submitted.nodeId);
  const summaryOf = (role: string): MeasurementSummary[] =>
    summaries
      .filter((summary) => summary.role === role)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const routeOf = (purpose: string): RoutingDecision | undefined =>
    routes.find((route) => route.purpose === purpose);
  return { made, summaries, routes, agents, summaryOf, routeOf };
};

describe("an examiner resumed for round 2", () => {
  it("ends with two segments whose totals are the reconciled sum, and its route carries them", async () => {
    const { summaryOf, routeOf } = await rig({
      ask: ["Is it bounded?"],
      examiner: { round1: { input: 50, output: 5 }, round2: { input: 30, output: 7 } },
    });
    const [summary, ...rest] = summaryOf("examiner");
    expect(rest).toEqual([]);
    expect(summary?.segments.map((s) => [s.segment, s.resumedSession])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(summary?.segments[1]?.sessionId).toBe("examiner-session");
    expect(summary?.segments[0]?.launchId).not.toBe(summary?.segments[1]?.launchId);
    expect(summary?.totals).toMatchObject({ inputTokens: 80, outputTokens: 12 });
    expect(summary?.routingDecisionId).toBe(routeOf("examine")?.routingDecisionId);
    expect(routeOf("examine")).toMatchObject({
      purpose: "examine",
      outcome: "succeeded",
      usage: { inputTokens: 80, outputTokens: 12 },
    });
  });

  it("takes the second segment as a delta from the first when the session is reported cumulatively", async () => {
    const { summaryOf, routeOf } = await rig({
      ask: ["Is it bounded?"],
      examiner: {
        round1: { input: 50, output: 5 },
        round2: { input: 30, output: 7, sessionInput: 80, sessionInputRound1: 50 },
      },
    });
    const [summary] = summaryOf("examiner");
    expect(summary?.segments[1]?.baseline).toMatchObject({ inputTokens: 50 });
    expect(summary?.segments[1]?.counters).toMatchObject({ inputTokens: 30 });
    expect(summary?.totals).toMatchObject({ inputTokens: 80, outputTokens: 12 });
    expect(routeOf("examine")?.usage).toMatchObject({ inputTokens: 80, outputTokens: 12 });
  });
});

describe("an answerer resumed from the builder's session", () => {
  it("claims only what is above the builder's stored baseline", async () => {
    const { summaryOf } = await rig({
      ask: ["Why?"],
      builderSessionInput: 100,
      answerer: { sessionInput: 130 },
      examiner: { round1: { input: 1, output: 1 }, round2: { input: 1, output: 1 } },
    });
    const [answerer, ...rest] = summaryOf("answerer");
    expect(rest).toEqual([]);
    expect(answerer?.segments).toHaveLength(1);
    expect(answerer?.segments[0]).toMatchObject({
      resumedSession: true,
      sessionId: "builder-session",
      baseline: { inputTokens: 100 },
    });
    expect(answerer?.totals.inputTokens).toBe(30);
  });

  it("records baseline_unknown, and claims no session-scoped total, when the builder has no summary", async () => {
    const { summaryOf } = await rig({
      ask: ["Why?"],
      answerer: { sessionInput: 130 },
      examiner: { round1: { input: 1, output: 1 }, round2: { input: 1, output: 1 } },
    });
    const [answerer] = summaryOf("answerer");
    expect(answerer?.gaps.map((gap) => gap.reason)).toContain("baseline_unknown");
    expect(answerer?.segments[0]?.baseline).toBeUndefined();
    // Only the exit's launch-scoped figure is claimed, never the builder's 130.
    expect(answerer?.totals.inputTokens).toBe(1);
  });

  it("gives the fresh answerer after a failed resume its own agent and summary", async () => {
    const { summaryOf, agents } = await rig({
      ask: ["Why?"],
      resumableBuilder: false,
      examiner: { round1: { input: 1, output: 1 }, round2: { input: 1, output: 1 } },
    });
    const answerers = summaryOf("answerer");
    expect(answerers).toHaveLength(2);
    expect(new Set(answerers.map((summary) => summary.agentId)).size).toBe(2);
    const launches = answerers.flatMap((summary) => summary.segments.map((s) => s.launchId));
    expect(new Set(launches).size).toBe(launches.length);
    expect(answerers[0]?.segments[0]).toMatchObject({ resumedSession: true, exitKind: "failed" });
    expect(answerers[1]?.segments[0]).toMatchObject({ segment: 0, resumedSession: false });
    expect(agents.filter((agent) => agent.role === "answerer")).toHaveLength(2);
  });
});

describe("a helper whose launch could not be attempted", () => {
  it("has a failed segment with unknown coverage, and a failed route", async () => {
    const { summaryOf, routeOf } = await rig({ examinerCannotLaunch: true });
    const [summary] = summaryOf("examiner");
    expect(summary?.segments).toHaveLength(1);
    expect(summary?.segments[0]).toMatchObject({
      exitKind: "failed",
      coverage: "unknown",
      open: false,
    });
    expect(routeOf("examine")?.outcome).toBe("failed");
  });
});
