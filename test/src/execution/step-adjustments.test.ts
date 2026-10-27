/**
 * A run's step adjustments reach every verification the engine makes (P19 S-02,
 * D-05, D-06): a skip whose step's latest actual run timed out is applied and
 * recorded; one the run's complete history contradicts is not, and says so;
 * the candidate record is followed by `verification.completed`; the end gates
 * run again after a later adjustment.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Decision,
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
  VerificationSchema,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExecutionEnvironment,
  fingerprintAtCommit,
  gateDefinitions,
  gitBlobReader,
  runJob,
  verifyRunHead,
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

/**
 * A command that, on its Nth run (counted in a file outside any checkout),
 * sleeps past a 1 s timeout when `plan[N]` is "hang" and exits 1 otherwise.
 */
const scripted = async (plan: readonly ("hang" | "fail")[]) => {
  const dir = await mkdtemp(join(tmpdir(), "ns-rerun-"));
  counters.push(dir);
  const file = join(dir, "runs").replace(/\\/g, "/");
  const modes = JSON.stringify(plan);
  return `"${process.execPath}" -e "const fs=require('fs');const f='${file}';const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));const m=${modes.replace(/"/g, "'")}[n];if(m==='hang')setTimeout(()=>{},60000);else process.exit(1)"`;
};

const programWith = (command: string, at?: "end"): Partial<ProgramContract> => ({
  verification: [
    { id: "test", command: "node --test" },
    { id: "trial", command, ...(at === undefined ? {} : { at }) },
  ],
});

const jobFor = (world: World, risk: RiskLevel = "low"): JobContract =>
  JobContractSchema.parse({
    schemaVersion: 1,
    ...world.scope,
    jobContractId: world.ids.next("job"),
    objective: "Add a helper.",
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

const skipContext = "STEP SKIPPED: trial";

/** A verification on the root node (another node than the job's) in which `trial` last ran with `exitCode`. */
const seedRun = async (world: World, exitCode: number): Promise<void> => {
  const at = nowIso(world.environment.clock);
  await world.stores.verifications.put(
    VerificationSchema.parse({
      schemaVersion: 1,
      ...world.scope,
      verificationId: world.ids.next("ver"),
      executionNodeId: world.session.rootNodeId,
      jobContractId: null,
      agentId: world.session.orchestratorAgentId,
      commitSha: world.baseCommit,
      phase: "run",
      commands: [{ stepId: "trial", command: "trial", exitCode, durationMs: 5 }],
      outcome: exitCode === 0 ? "passed" : "failed",
      startedAt: at,
      endedAt: at,
    }) as Verification,
  );
};

/** A node of `kind` under the root, for a decision to be recorded on. */
const nodeOfKind = async (world: World, kind: "job" | "sub-program"): Promise<ExecutionNodeId> => {
  const root = await world.stores.executionNodes.get(world.scope, world.session.rootNodeId);
  if (root === undefined) throw new Error("no root node");
  const executionNodeId = world.ids.next("node") as ExecutionNodeId;
  await world.stores.executionNodes.put({
    ...root,
    executionNodeId,
    kind,
    parentNodeId: root.executionNodeId,
    depth: 1,
    status: "failed",
  });
  return executionNodeId;
};

const decide = async (
  world: World,
  context: string,
  nodeId: ExecutionNodeId = world.session.rootNodeId,
): Promise<Decision> => {
  const decision: Decision = {
    schemaVersion: 1,
    ...world.scope,
    decisionId: world.ids.next("dec"),
    executionNodeId: nodeId,
    agentId: world.session.orchestratorAgentId,
    context,
    alternatives: [{ summary: "wait" }],
    choice: context,
    rationale: "the trial hangs",
    reversibility: "reversible",
    checkpointBefore: world.ids.next("ckpt"),
    affectedNodes: [],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: nowIso(world.environment.clock),
  };
  await world.stores.decisions.put(decision);
  return decision;
};

describe("a skip decision at verification", () => {
  it("is applied when the step's latest actual run timed out: recorded, not run, outcome from the others", async () => {
    const trial = await counter(Number.MAX_SAFE_INTEGER);
    const world = await worldWith(programWith(trial.command));
    await seedRun(world, 124);
    const decision = await decide(world, skipContext);
    const nodeId = await runDirect(world);

    expect((await world.stores.executionNodes.get(world.scope, nodeId))?.status).toBe("integrated");
    expect(await trial.runs()).toBe(0);
    const [verification] = await verificationsOf(world, nodeId);
    expect(verification?.outcome).toBe("passed");
    const command = commandOf(verification, "trial");
    expect(command).toMatchObject({ skipped: { decisionId: decision.decisionId }, durationMs: 0 });
    expect(command?.exitCode).toBeUndefined();
    expect(verification?.commands.map((c) => c.stepId)).toEqual(["test", "trial"]);
    const [requested] = await nodeEvents(world, nodeId, "verification.requested");
    expect(requested?.payload).toMatchObject({ skippedSteps: ["trial"] });
    const [completed] = await nodeEvents(world, nodeId, "verification.completed");
    expect(completed?.payload).toMatchObject({ outcome: "passed", skippedSteps: ["trial"] });
  });

  it.each([
    [1, "ran and failed with exit 1"],
    [0, "passed on its most recent run"],
  ])(
    "is not applied when a newer run elsewhere exited %i: the step runs and the progress line says why",
    async (exitCode, said) => {
      const trial = await counter(Number.MAX_SAFE_INTEGER);
      const world = await worldWith(programWith(trial.command));
      await seedRun(world, 124);
      const decision = await decide(world, skipContext);
      // A later run on another node, with no event for it.
      await seedRun(world, exitCode);
      const nodeId = await runDirect(world);

      expect(await trial.runs()).toBeGreaterThan(0);
      const [verification] = await verificationsOf(world, nodeId);
      const command = commandOf(verification, "trial");
      expect(command?.skipped).toBeUndefined();
      expect(command?.exitCode).toBe(1);
      expect(verification?.outcome).toBe("failed");
      const progress = (await nodeEvents(world, nodeId, "verification.progress")).map(
        (event) => (event.payload as { message?: string }).message ?? "",
      );
      const line = progress.find((message) => message.startsWith("skip of trial"));
      expect(line).toContain(`skip of trial by decision ${decision.decisionId} not applied: `);
      expect(line).toContain(said);
    },
  );
});

describe("who may skip a step", () => {
  const progressOf = async (world: World, nodeId: ExecutionNodeId) =>
    (await nodeEvents(world, nodeId, "verification.progress")).map(
      (event) => (event.payload as { message?: string }).message ?? "",
    );

  it("a worker's STEP SKIPPED decision does not skip the step: it runs, and no skip is claimed", async () => {
    const trial = await counter(Number.MAX_SAFE_INTEGER);
    const world = await worldWith(programWith(trial.command));
    await seedRun(world, 124);
    await decide(world, skipContext, await nodeOfKind(world, "job"));
    const nodeId = await runDirect(world);

    expect(await trial.runs()).toBeGreaterThan(0);
    const [verification] = await verificationsOf(world, nodeId);
    const command = commandOf(verification, "trial");
    expect(command?.skipped).toBeUndefined();
    expect(command?.exitCode).toBe(1);
    expect((await progressOf(world, nodeId)).some((line) => line.startsWith("skip of trial"))).toBe(
      false,
    );
    const [requested] = await nodeEvents(world, nodeId, "verification.requested");
    expect(requested?.payload).not.toMatchObject({ skippedSteps: ["trial"] });
  });

  it("the same decision on the strand's sub-program node is honoured", async () => {
    const trial = await counter(Number.MAX_SAFE_INTEGER);
    const world = await worldWith(programWith(trial.command));
    await seedRun(world, 124);
    const decision = await decide(world, skipContext, await nodeOfKind(world, "sub-program"));
    const nodeId = await runDirect(world);

    expect(await trial.runs()).toBe(0);
    const [verification] = await verificationsOf(world, nodeId);
    expect(commandOf(verification, "trial")).toMatchObject({
      skipped: { decisionId: decision.decisionId },
    });
  });
});

describe("a step whose automatic rerun failed differently (D-06)", () => {
  it.each([
    ["times out, then exits 1 on its rerun", ["hang", "fail"] as const, 124, 1],
    ["exits 1, then times out on its rerun", ["fail", "hang"] as const, 1, 124],
  ])(
    "a step that %s is recorded so, and a skip decision for it is not applied",
    async (_name, plan, first, second) => {
      const command = await scripted(plan);
      const world = await worldWith({
        verification: [
          { id: "test", command: "node --test" },
          { id: "trial", command, timeoutSeconds: 1, cleanupSeconds: 1 },
        ],
      });
      const firstNode = await runDirect(world);
      const [recorded] = await verificationsOf(world, firstNode);
      const trial = commandOf(recorded, "trial");
      expect(trial).toMatchObject({ exitCode: first, rerun: { exitCode: second } });
      expect(trial?.skipped).toBeUndefined();

      const decision = await decide(world, skipContext, await nodeOfKind(world, "sub-program"));
      const nodeId = await runDirect(world);
      const [verification] = await verificationsOf(world, nodeId);
      const next = commandOf(verification, "trial");
      expect(next?.skipped).toBeUndefined();
      expect(next?.exitCode).toBeDefined();
      const progress = (await nodeEvents(world, nodeId, "verification.progress")).map(
        (event) => (event.payload as { message?: string }).message ?? "",
      );
      const line = progress.find((message) => message.startsWith("skip of trial"));
      expect(line).toContain(`skip of trial by decision ${decision.decisionId} not applied: `);
      expect(line).toContain(
        first === 124
          ? "timed out and then ran and failed with exit 1 on its rerun; fix it, it cannot be skipped"
          : "ran and failed with exit 1 before timing out on its rerun; fix it, it cannot be skipped",
      );
    },
    60_000,
  );
});

describe("the candidate verification", () => {
  it("applies a skip and is followed by verification.completed naming its record", async () => {
    const trial = await counter(Number.MAX_SAFE_INTEGER);
    const world = await worldWith(programWith(trial.command));
    await seedRun(world, 124);
    await decide(world, skipContext);
    const nodeId = await runThroughEngine(world, "high");

    expect(await trial.runs()).toBe(0);
    const candidate = (await verificationsOf(world, nodeId)).find(
      (verification) => verification.phase === "candidate",
    );
    expect(candidate?.outcome).toBe("passed");
    expect(commandOf(candidate, "trial")?.skipped).toBeDefined();
    const completed = (await nodeEvents(world, nodeId, "verification.completed")).find(
      (event) => (event.payload as { phase?: string }).phase === "candidate",
    );
    expect(completed?.payload).toMatchObject({
      verificationId: candidate?.verificationId,
      outcome: "passed",
      commitSha: candidate?.commitSha,
      phase: "candidate",
      skippedSteps: ["trial"],
    });
  });

  it("records the job's base, its environment and, with a gate-health record, the gate fingerprint", async () => {
    const trial = await counter(0);
    const world = await worldWith(programWith(trial.command));
    await world.stores.gateHealth.put({
      schemaVersion: 1,
      projectId: world.program.projectId,
      programId: world.program.programId,
      commit: world.baseCommit,
      fingerprint: "a".repeat(64),
      verdict: "healthy",
      findings: [],
      machinery: ["package.json"],
      auditedBy: {
        kind: "user",
        userId: world.subject as never,
        orgId: "org_01M4REPA1R0000000000000000" as never,
      },
      auditedAt: nowIso(world.environment.clock),
    } as never);
    const nodeId = await runThroughEngine(world, "high");

    const stored = (await world.stores.verifications.listByNode(world.scope, nodeId)).find(
      (verification) => verification.phase === "candidate",
    );
    expect(stored?.baseSha).toBe(world.baseCommit);
    expect(stored?.environment).toEqual({ where: "laptop" });
    expect(stored?.gateFingerprint).toBe(
      await fingerprintAtCommit(
        gitBlobReader(world.session.repoPath),
        stored?.commitSha as never,
        await gateDefinitions(world.environment, world.session).then((gates) => ({
          setup: [...gates.setup],
          verification: [...gates.verification],
        })),
        ["package.json"],
      ),
    );
  });
});

describe("verifyRunHead", () => {
  it("reuses the record of the head, and runs the end gates again after a later adjustment", async () => {
    const trial = await counter(Number.MAX_SAFE_INTEGER);
    const world = await worldWith(programWith(trial.command, "end"));
    const runsOf = async () =>
      (await world.stores.verifications.listByNode(world.scope, world.session.rootNodeId)).filter(
        (verification) => verification.phase === "run",
      );

    const first = await verifyRunHead(world.environment, world.session);
    expect(first.status).toBe("failed");
    expect(await runsOf()).toHaveLength(1);
    // The stored end-gate record says what it ran against, and where.
    const [stored] = await runsOf();
    expect(stored?.baseSha).toBeDefined();
    expect(stored?.environment).toEqual({ where: "laptop" });
    await verifyRunHead(world.environment, world.session);
    expect(await runsOf()).toHaveLength(1);

    await decide(world, "STEP TIMEOUT: trial timeoutSeconds=900");
    await verifyRunHead(world.environment, world.session);
    expect(await runsOf()).toHaveLength(2);
    // The new record stands for the head again.
    await verifyRunHead(world.environment, world.session);
    expect(await runsOf()).toHaveLength(2);
    const completed = (await eventsOf(world)).filter(
      (event) => event.type === "verification.completed",
    );
    expect(completed).toHaveLength(2);
  });
});
