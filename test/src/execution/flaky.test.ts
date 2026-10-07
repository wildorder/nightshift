/**
 * Flaky detection in verification (P15, D-P15-06, SC-P15-06).
 *
 * A check that fails is run once more on the same commit. When the rerun
 * passes, the check is recorded as flaky, the work lands as a pass does, the
 * route does not climb, and `gate.flaked` names the step. When it fails again,
 * it is the failure it always was. Both hold for the queue's verification and
 * for the candidate check an examined job gets beside the queue.
 *
 * The flaky check counts its runs in a file **outside** the checkout, so the
 * pristine checkout (which removes everything uncommitted) cannot reset it, and
 * fails until it has run a given number of times.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Examination,
  ExaminationSchema,
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type ProgramContract,
  type RiskLevel,
  type RouteChoice,
  type RouteTarget,
  type Verification,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExecutionEnvironment,
  runJob,
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

const counters: string[] = [];
afterEach(async () => {
  await cleanupWorlds();
  for (const dir of counters.splice(0)) await rm(dir, { recursive: true, force: true });
});

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

/** A counter file outside any checkout, and the command that fails its first `failures` runs. */
const counter = async (failures: number) => {
  const dir = await mkdtemp(join(tmpdir(), "ns-flaky-"));
  counters.push(dir);
  // Forward slashes: valid on Windows too, and nothing to escape in the command.
  const file = join(dir, "runs").replace(/\\/g, "/");
  const command = `"${process.execPath}" -e "const fs=require('fs');const f='${file}';const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));console.log('run '+(n+1));process.exit(n<${failures}?1:0)"`;
  return {
    command,
    runs: async (): Promise<number> =>
      Number(await readFile(file, "utf8").catch(() => "0")) as number,
  };
};

const programWith = (command: string): Partial<ProgramContract> => ({
  verification: [
    { id: "test", command: "node --test" },
    { id: "flaky", command },
  ],
});

const jobFor = (world: World, risk: RiskLevel = "low"): JobContract =>
  JobContractSchema.parse({
    schemaVersion: 1,
    ...world.scope,
    jobContractId: world.ids.next("job"),
    objective: "Add a helper.",
    scope: { includes: ["src/**", "test/**"] },
    acceptance: ["It works."],
    dependencies: [],
    risk,
    ambiguity: "low",
    createdAt: nowIso(world.environment.clock),
  });

/** The worker: one file, and a report. */
const build = async (world: World, context: ScriptContext): Promise<HarnessExit> => {
  const outbox = createEventOutbox({
    events: world.stores.events,
    scope: context.identity.scope,
    clock: world.environment.clock,
    ids: world.ids,
    writerId: context.identity.agentId,
    initialDelayMs: 1,
  });
  await writeFile(join(context.worktree, "src", "helper.js"), "export const helper = 1;\n", "utf8");
  await completeJob(
    { stores: world.stores, clock: world.environment.clock, git: world.git, outbox },
    context.identity,
    "Added a helper.",
  );
  await outbox.flush();
  return { kind: "completed" };
};

/** The examiner: passes the work, through its own token. */
const examine = async (world: World, input: HarnessStartInput): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
  const stores = createHttpStores({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });
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
      outcome: "passed",
      findings: [],
      createdAt: nowIso(world.environment.clock),
    }) as Examination,
  );
  return { kind: "completed" };
};

/** A world whose harness plays the builder and, for an examined job, the examiner. */
const worldWith = async (program: Partial<ProgramContract>): Promise<World> => {
  let world: World | undefined;
  world = await createWorld({
    program,
    harness: createFakeHarness({
      script: (context) =>
        context.input.agent.role === "examiner"
          ? examine(world as World, context.input)
          : build(world as World, context),
    }),
  });
  return world;
};

/** A job delegated straight to the runner: the queue's verification and nothing else. */
const runDirect = async (world: World): Promise<ExecutionNodeId> => {
  const started = await runJob(world.environment, {
    session: world.session,
    job: jobFor(world),
    scope: world.session.program.scope,
    depth: 1,
    parentNodeId: world.session.rootNodeId,
    route: choice(BUILDER),
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
  });
  await started.completion;
  await world.outbox.flush();
  return started.nodeId;
};

/** A job submitted to the engine at `risk`, run until it settles. */
const runThroughEngine = async (world: World, risk: RiskLevel): Promise<ExecutionNodeId> => {
  const environment: ExecutionEnvironment = {
    ...world.environment,
    examination: {
      examinerRoute: () => choice(EXAMINER),
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
    },
  };
  const engine = createEngine({
    environment,
    session: world.session,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
    route: () => choice(BUILDER),
  });
  const { nodeId } = await engine.submit({
    job: jobFor(world, risk),
    scope: world.session.program.scope,
    depth: 1,
    parentNodeId: world.session.rootNodeId,
    route: choice(BUILDER),
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = (await world.stores.executionNodes.get(world.scope, nodeId))?.status;
    if (status !== undefined && isSettled(status) && engine.idle()) break;
    if (Date.now() > deadline) throw new Error(`node ${nodeId} is still ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await world.outbox.flush();
  return nodeId;
};

const verificationsOf = async (world: World, nodeId: ExecutionNodeId) =>
  [...(await world.stores.verifications.listByNode(world.scope, nodeId))].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );

const commandOf = (verification: Verification | undefined, stepId: string) =>
  verification?.commands.find((command) => command.stepId === stepId);

const nodeEvents = async (world: World, nodeId: ExecutionNodeId, type: string) =>
  (await eventsOf(world)).filter(
    (event) => event.executionNodeId === nodeId && event.type === type,
  );

/** The flake's evidence: both runs' logs kept, each saying which run it was. */
const expectBothLogs = (world: World, verification: Verification, stepId: string): void => {
  const command = commandOf(verification, stepId);
  const body = (id: string | undefined) =>
    world.plane.bodies.text(
      `${world.scope.projectId}/${world.scope.programId}/${world.scope.runId}/${id}`,
    );
  expect(command?.logArtifactId).toBeDefined();
  expect(command?.flaky?.firstLogArtifactId).toBeDefined();
  expect(command?.logArtifactId).not.toBe(command?.flaky?.firstLogArtifactId);
  expect(body(command?.flaky?.firstLogArtifactId)).toContain("run 1");
  expect(body(command?.logArtifactId)).toContain("run 2");
};

describe("a check that fails and then passes on the same commit (SC-P15-06)", () => {
  it("is recorded as flaky, lands the work, and does not climb the route", async () => {
    const flaky = await counter(1);
    const world = await worldWith(programWith(flaky.command));
    const nodeId = await runDirect(world);

    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.status).toBe("integrated");
    // Run once, rerun once: nothing more.
    expect(await flaky.runs()).toBe(2);

    const [verification, ...others] = await verificationsOf(world, nodeId);
    expect(others).toEqual([]);
    expect(verification?.outcome).toBe("passed");
    expect(commandOf(verification, "flaky")).toMatchObject({
      exitCode: 0,
      flaky: { firstExitCode: 1 },
    });
    // A check that passed the first time is not touched.
    expect(commandOf(verification, "test")?.flaky).toBeUndefined();
    expectBothLogs(world, verification as Verification, "flaky");

    const flaked = await nodeEvents(world, nodeId, "gate.flaked");
    expect(flaked.map((event) => event.payload)).toEqual([
      {
        verificationId: verification?.verificationId,
        commitSha: verification?.commitSha,
        stepIds: ["flaky"],
      },
    ]);
    const [completed] = await nodeEvents(world, nodeId, "verification.completed");
    expect(completed?.payload).toMatchObject({ outcome: "passed", flakyStepIds: ["flaky"] });

    // No climb: one route, one attempt, and no verification_failed anywhere.
    const routes = await world.stores.routingDecisions.listByNode(world.scope, nodeId);
    expect(routes).toHaveLength(1);
    const outcomes = (await nodeEvents(world, nodeId, "verification.completed")).map(
      (event) => (event.payload as { outcome?: string }).outcome,
    );
    expect(outcomes.every((outcome) => outcome === "passed")).toBe(true);
  });

  it("in an examined job's candidate check, goes on to the examiner and lands", async () => {
    // Fails once: the candidate's first run. Its rerun and the queue's run pass.
    const flaky = await counter(1);
    const world = await worldWith(programWith(flaky.command));
    const nodeId = await runThroughEngine(world, "high");

    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.status).toBe("integrated");
    expect(await flaky.runs()).toBe(3);

    const verifications = await verificationsOf(world, nodeId);
    const candidate = verifications.find((verification) => verification.phase === "candidate");
    const queue = verifications.find((verification) => verification.phase !== "candidate");
    expect(candidate?.outcome).toBe("passed");
    expect(commandOf(candidate, "flaky")).toMatchObject({
      exitCode: 0,
      flaky: { firstExitCode: 1 },
    });
    expectBothLogs(world, candidate as Verification, "flaky");
    // The queue's run passed the first time: not a flake there.
    expect(queue?.outcome).toBe("passed");
    expect(commandOf(queue, "flaky")?.flaky).toBeUndefined();

    const flaked = await nodeEvents(world, nodeId, "gate.flaked");
    expect(flaked.map((event) => event.payload)).toEqual([
      {
        verificationId: candidate?.verificationId,
        commitSha: candidate?.commitSha,
        stepIds: ["flaky"],
      },
    ]);

    // Examined, not climbed: one work route and the examiner's.
    const routes = await world.stores.routingDecisions.listByNode(world.scope, nodeId);
    expect(routes.map((route) => route.purpose ?? "work").sort()).toEqual(["examine", "work"]);
    const outcomes = (await nodeEvents(world, nodeId, "verification.completed")).map(
      (event) => (event.payload as { outcome?: string }).outcome,
    );
    expect(outcomes.every((outcome) => outcome === "passed")).toBe(true);
  });
});

describe("a check that fails twice", () => {
  it("is verification_failed exactly as before: no flaky marker, no gate.flaked", async () => {
    // Would pass on a third run, which never happens: one rerun, no more.
    const flaky = await counter(2);
    const world = await worldWith(programWith(flaky.command));
    const nodeId = await runDirect(world);

    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.status).toBe("verification_failed");
    expect(node?.outcomeReason).toContain("flaky exited 1");
    expect(await flaky.runs()).toBe(2);

    const [verification, ...others] = await verificationsOf(world, nodeId);
    expect(others).toEqual([]);
    expect(verification?.outcome).toBe("failed");
    expect(verification?.commands.some((command) => command.flaky !== undefined)).toBe(false);
    // Recorded as its first run.
    const command = commandOf(verification, "flaky");
    expect(command?.exitCode).toBe(1);
    expect(
      world.plane.bodies.text(
        `${world.scope.projectId}/${world.scope.programId}/${world.scope.runId}/${command?.logArtifactId}`,
      ),
    ).toContain("run 1");

    expect(await nodeEvents(world, nodeId, "gate.flaked")).toEqual([]);
    const [completed] = await nodeEvents(world, nodeId, "verification.completed");
    expect(completed?.payload).toMatchObject({ outcome: "failed", failingSteps: ["flaky"] });
    expect(completed?.payload).not.toHaveProperty("flakyStepIds");
  });

  it("in an examined job's candidate check, ends the job verification_failed as before", async () => {
    const flaky = await counter(2);
    const world = await worldWith(programWith(flaky.command));
    const nodeId = await runThroughEngine(world, "high");

    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    expect(node?.status).toBe("verification_failed");
    expect(await flaky.runs()).toBe(2);
    const [candidate] = await verificationsOf(world, nodeId);
    expect(candidate?.phase).toBe("candidate");
    expect(candidate?.outcome).toBe("failed");
    expect(commandOf(candidate, "flaky")?.flaky).toBeUndefined();
    expect(await nodeEvents(world, nodeId, "gate.flaked")).toEqual([]);
  });
});

describe("what is never rerun", () => {
  it("a setup that fails", async () => {
    const setup = await counter(Number.MAX_SAFE_INTEGER);
    const world = await worldWith({ setup: [{ id: "install", command: setup.command }] });
    const nodeId = await runDirect(world);

    expect((await world.stores.executionNodes.get(world.scope, nodeId))?.status).toBe(
      "verification_failed",
    );
    // Once preparing the worker's worktree, once in verification: never again.
    expect(await setup.runs()).toBe(2);
    const [verification, ...others] = await verificationsOf(world, nodeId);
    expect(others).toEqual([]);
    expect(verification?.commands.map((command) => [command.stepId, command.exitCode])).toEqual([
      ["setup:install", 1],
    ]);
    expect(verification?.commands[0]?.flaky).toBeUndefined();
    expect(await nodeEvents(world, nodeId, "gate.flaked")).toEqual([]);
  });

  it("a check that declares it cannot run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ns-flaky-"));
    counters.push(dir);
    const file = join(dir, "runs").replace(/\\/g, "/");
    const declares = `"${process.execPath}" -e "const fs=require('fs');const f='${file}';const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));console.log('NIGHTSHIFT_DEFER HP-07 a sandbox key nobody has');process.exit(75)"`;
    const world = await worldWith(programWith(declares));
    const nodeId = await runDirect(world);

    expect((await world.stores.executionNodes.get(world.scope, nodeId))?.status).toBe("deferred");
    expect(Number(await readFile(file, "utf8"))).toBe(1);
    const [verification] = await verificationsOf(world, nodeId);
    expect(commandOf(verification, "flaky")?.deferred).toEqual({ prerequisiteId: "HP-07" });
    expect(await nodeEvents(world, nodeId, "gate.flaked")).toEqual([]);
  });
});
