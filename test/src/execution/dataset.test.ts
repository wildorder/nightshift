/**
 * The routing dataset, schema 2 (P20, S-04 J4), over the real engine, real git,
 * the production API handler and the fake harness: each decision carries the
 * judgement that its own links name, never its node's final one; agent time and
 * settlement time are two figures; a root line exists only with a root summary.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Examination,
  ExaminationSchema,
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type LifecycleObservation,
  lifecycleObservationsOf,
  lifecycleOperationId,
  type MeasurementSummary,
  type RouteChoice,
  type RouteTarget,
  type RoutingDatasetLine,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  createMergeQueue,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  type ExecutionEnvironment,
  routingDataset,
} from "@nightshift/execution";
import type { HarnessExit, HarnessStartInput } from "@nightshift/harness";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, describe, expect, it, vi } from "vitest";
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

type Work = (context: ScriptContext) => Promise<unknown>;

const writeModule = async (worktree: string, name: string, passes: boolean) => {
  await writeFile(
    join(worktree, "src", `${name}.js`),
    `export const ${name} = () => "${name}";\n`,
    "utf8",
  );
  await writeFile(
    join(worktree, "test", `${name}.test.js`),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\n` +
      `import { ${name} } from "../src/${name}.js";\n` +
      `test("${name}", () => assert.equal(${name}(), "${passes ? name : "other"}"));\n`,
    "utf8",
  );
};

const helperStores = (world: World, input: HarnessStartInput) =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });

/** An examiner that passes the work, writing the record as the MCP server does. */
const examinePasses = async (world: World, input: HarnessStartInput): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
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
      ...(context.implementerRoutingDecisionId === undefined
        ? {}
        : { implementerRoutingDecisionId: context.implementerRoutingDecisionId }),
      examinerAgentId: input.agent.agentId,
      examinerRoute: context.examinerRoute,
      requiredByRisk: context.requiredByRisk,
      blocking: context.blocking,
      fixAttempt: context.fixAttempt,
      questions: context.questions,
      outcome: "passed",
      findings: [],
      createdAt: nowIso(world.environment.clock),
    }) as Examination,
  );
  return { kind: "completed", sessionId: "examiner-session" };
};

const rig = async (work: Readonly<Record<string, Work>>) => {
  let world: World | undefined;
  const made = await createWorld({
    harness: createFakeHarness({
      script: async (context): Promise<HarnessExit> => {
        const { input } = context;
        const w = world as World;
        if (input.agent.role === "examiner") return examinePasses(w, input);
        const name = input.job.objective.split(" ")[0] ?? "";
        await (work[name] ?? (async () => {}))(context);
        const outbox = createEventOutbox({
          events: w.stores.events,
          scope: context.identity.scope,
          clock: w.environment.clock,
          ids: w.ids,
          writerId: context.identity.agentId,
          initialDelayMs: 1,
        });
        const environment = { stores: w.stores, clock: w.environment.clock, git: w.git, outbox };
        await completeJob(environment, context.identity, `${name}: done`);
        await outbox.flush();
        return { kind: "completed" };
      },
    }),
    program: { delegationLimits: { maxDepth: 2, maxConcurrency: 3 } },
  });
  world = made;
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
    ...made.environment,
    examination: services,
    sleep: async () => {},
  };
  const engine = createEngine({
    environment,
    session: made.session,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
    mergeQueue: createMergeQueue(environment),
    route: () => choice(BUILDER),
  });
  const submit = async (objective: string, extra?: Partial<JobContract>) => {
    const job = JobContractSchema.parse({
      schemaVersion: 1,
      ...made.scope,
      jobContractId: made.ids.next("job"),
      objective,
      acceptance: ["node --test passes"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      ...extra,
      createdAt: nowIso(made.environment.clock),
    });
    const submitted = await engine.submit({
      job,
      depth: 1,
      parentNodeId: made.session.rootNodeId,
      route: choice(BUILDER),
    });
    return { jobId: job.jobContractId, nodeId: submitted.nodeId };
  };
  const until = async (nodeId: ExecutionNodeId, predicate: (status: string) => boolean) => {
    const deadline = Date.now() + 60_000;
    let last = "missing";
    do {
      last = (await made.stores.executionNodes.get(made.scope, nodeId))?.status ?? "missing";
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new Error(`node ${nodeId} is still ${last}`);
  };
  const idle = (): Promise<void> =>
    vi.waitFor(() => expect(engine.idle()).toBe(true), { timeout: 30_000 });
  return {
    world: made,
    engine,
    submit,
    until,
    idle,
    lines: async (): Promise<readonly RoutingDatasetLine[]> => {
      await made.outbox.flush();
      return routingDataset(made.stores, made.scope);
    },
    observations: async (): Promise<LifecycleObservation[]> => {
      await made.outbox.flush();
      return lifecycleObservationsOf(await eventsOf(made));
    },
  };
};

const settled = (status: string): boolean => isSettled(status as never);

/** A node whose attempt 1 fails verification and whose attempt 2 passes it. */
const retried = async () => {
  let attempts = 0;
  const r = await rig({
    flaky: async ({ worktree }) => {
      attempts += 1;
      await writeModule(worktree, "flaky", attempts > 1);
    },
  });
  const job = await r.submit("flaky module");
  expect(await r.until(job.nodeId, settled)).toBe("verification_failed");
  await r.idle();
  expect(await r.engine.retry(job.jobId)).toBe(true);
  expect(await r.until(job.nodeId, (status) => status === "integrated")).toBe("integrated");
  await r.idle();
  return { r, job };
};

describe("each attempt exports its own judgement", () => {
  it("keeps a failed attempt's failed verification while the retry shows passed", async () => {
    const { r, job } = await retried();
    const lines = (await r.lines()).filter((line) => line.executionNodeId === job.nodeId);
    const byAttempt = new Map(lines.map((line) => [line.attempt, line]));
    expect(lines.map((line) => line.attempt).sort()).toEqual([1, 2]);
    expect(byAttempt.get(1)?.schemaVersion).toBe(2);
    expect(byAttempt.get(1)?.judgement).toEqual({
      verification: "failed",
      examination: null,
      link: "attempt",
      historical: false,
    });
    expect(byAttempt.get(2)?.judgement).toEqual({
      verification: "passed",
      examination: null,
      link: "attempt",
      historical: false,
    });
    const verifications = await r.world.stores.verifications.listByNode(r.world.scope, job.nodeId);
    const decisions = await r.world.stores.routingDecisions.listByNode(r.world.scope, job.nodeId);
    for (const verification of verifications) {
      const decision = decisions.find(
        (candidate) => candidate.routingDecisionId === verification.routingDecisionId,
      );
      expect(decision?.attempt).toBe(verification.outcome === "failed" ? 1 : 2);
    }
  }, 90_000);

  it("gives a node's final records, marked historical, when the records carry no links", async () => {
    const { r, job } = await retried();
    const { stores, scope } = r.world;
    const unlinked = {
      ...stores,
      verifications: {
        ...stores.verifications,
        listByNode: async (...args: Parameters<typeof stores.verifications.listByNode>) =>
          (await stores.verifications.listByNode(...args)).map(
            ({ routingDecisionId: _link, ...rest }) => rest,
          ),
      },
    } as typeof stores;
    const lines = (await routingDataset(unlinked, scope)).filter(
      (line) => line.executionNodeId === job.nodeId,
    );
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.judgement).toEqual({
        verification: "passed",
        examination: null,
        link: "node_final",
        historical: true,
      });
    }
  }, 90_000);

  it("never gives an examiner the implementer's verification as its own judgement", async () => {
    const r = await rig({
      alpha: async ({ worktree }) => writeModule(worktree, "alpha", true),
    });
    const job = await r.submit("alpha module", { risk: "high" });
    expect(await r.until(job.nodeId, settled)).toBe("integrated");
    await r.idle();
    const lines = (await r.lines()).filter((line) => line.executionNodeId === job.nodeId);
    const work = lines.find((line) => line.purpose === "work");
    const examiner = lines.find((line) => line.purpose === "examine");
    expect(work?.judgement).toEqual({
      verification: "passed",
      examination: { outcome: "passed", blocking: expect.any(Boolean), fixAttempt: 0 },
      link: "attempt",
      historical: false,
    });
    expect(examiner?.judgement.verification).toBeNull();
    expect(examiner?.judgement.link).toBe("attempt");
    expect(examiner?.judgement.examination?.outcome).toBe("passed");
    const examination = (
      await r.world.stores.examinations.listByNode(r.world.scope, job.nodeId)
    )[0];
    expect(examination?.implementerRoutingDecisionId).toBe(work?.routingDecisionId);
    expect(examiner?.agentMs).not.toBeNull();
  }, 90_000);
});

describe("agent time and settlement time", () => {
  it("is shorter than settlement for an attempt that queued and verified, and is the work interval", async () => {
    const r = await rig({
      alpha: async ({ worktree }) => writeModule(worktree, "alpha", true),
    });
    const job = await r.submit("alpha module");
    expect(await r.until(job.nodeId, settled)).toBe("integrated");
    await r.idle();
    const line = (await r.lines()).find((candidate) => candidate.executionNodeId === job.nodeId);
    const observed = (await r.observations()).filter(
      (observation) => observation.operationId === lifecycleOperationId("work", job.nodeId, "1"),
    );
    const at = (transition: string) =>
      Date.parse(
        observed.find((observation) => observation.transition === transition)?.occurredAt as string,
      );
    const interval = at("end") - at("start");
    expect(interval).toBeGreaterThan(0);
    expect(line?.agentMs).toBe(interval);
    expect(line?.settlementMs).toBeGreaterThan(line?.agentMs as number);
  }, 90_000);
});

describe("the root line", () => {
  const summaryFor = (world: World): MeasurementSummary => ({
    schemaVersion: 1,
    measurementVersion: 1,
    ...world.scope,
    measurementSummaryId: world.ids.next("meas"),
    executionNodeId: world.session.rootNodeId,
    agentId: world.ids.next("agent"),
    role: "orchestrator",
    routingDecisionId: null,
    route: BUILDER,
    observedModels: [],
    segments: [],
    totals: { inputTokens: 120, outputTokens: 30, inputIncludesCache: false },
    coverage: "partial",
    gaps: [{ reason: "receipt_lost", count: 1 }],
    ledger: { chunks: 0, artifactIds: [], observationCount: 0, publishedCount: 0 },
    valuation: { source: "reported", usd: 0.25, reportedUsd: 0.25 },
    createdAt: nowIso(world.environment.clock),
    updatedAt: nowIso(world.environment.clock),
  });

  it("is present with the summary's totals and coverage, and absent without one", async () => {
    const r = await rig({});
    expect((await r.lines()).filter((line) => line.purpose === "root")).toEqual([]);
    const summary = summaryFor(r.world);
    await r.world.stores.measurements.put(summary);
    const roots = (await r.lines()).filter((line) => line.purpose === "root");
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      routingDecisionId: null,
      attempt: 1,
      executionNodeId: r.world.session.rootNodeId,
      usage: { inputTokens: 120, outputTokens: 30, actualCostUsd: 0.25 },
      measurementSummaryId: summary.measurementSummaryId,
      measurementCoverage: "partial",
      judgement: { verification: null, examination: null, link: "none", historical: false },
    });
  });
});
