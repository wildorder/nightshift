/**
 * The project environment, threaded (P16, D-10).
 *
 * On a machine the engine is handed the project environment
 * (`ExecutionEnvironment.projectEnv`) and gives it, whole, to every step that
 * runs the project's code: the setup that prepares a checkout, verification's
 * first run and its rerun of a failed check (with or without a worker user),
 * an examined job's candidate check, and the setup reference in the program
 * checkout. It never takes it as its own: `process.env` is the same after.
 *
 * Each probe below records, outside any checkout, whether the variables only
 * the project environment carries reached it, and fails on its first
 * `failures` runs so a rerun happens.
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
  prepareSetupReference,
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
import { cleanupWorlds, createWorld, type World } from "./world.js";

const dirs: string[] = [];
afterEach(async () => {
  await cleanupWorlds();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Variables only the project environment carries: none is in this process's. */
const PROJECT_ENV: Readonly<Record<string, string>> = {
  NS_PROJECT_ONLY: "from-project",
  DOCKER_HOST: "unix:///run/ns-project-env-test/docker.sock",
  npm_config_cache: "/ns-project-env-test/stores/npm",
  PNPM_HOME: "/ns-project-env-test/stores/pnpm",
  CARGO_HOME: "/ns-project-env-test/stores/cargo",
  JAVA_HOME: "/ns-project-env-test/runtimes/java",
  RUSTUP_TOOLCHAIN: "1.82.0",
};

/**
 * A command that appends `ok` or `missing` to a file outside any checkout,
 * by whether every project variable reached it, and exits 0 only when they
 * did and it has already failed `failures` times.
 */
const probe = async (failures = 0) => {
  const dir = await mkdtemp(join(tmpdir(), "ns-projenv-"));
  dirs.push(dir);
  // Forward slashes: valid on Windows too, and nothing to escape in the command.
  const file = join(dir, "runs").replace(/\\/g, "/");
  const checks = Object.entries(PROJECT_ENV)
    .map(([name, value]) => `e['${name}']==='${value}'`)
    .join("&&");
  const command = `"${process.execPath}" -e "const fs=require('fs');const f='${file}';const e=process.env;const ok=${checks};const n=fs.existsSync(f)?fs.readFileSync(f,'utf8').split(' ').length-1:0;fs.appendFileSync(f,(ok?'ok':'missing')+' ');process.exit(!ok?7:n<${failures}?1:0)"`;
  return {
    command,
    runs: async (): Promise<readonly string[]> =>
      (await readFile(file, "utf8").catch(() => "")).split(" ").filter((run) => run !== ""),
  };
};

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

/** A machine's engine world, or with `laptop` one that has no project environment. */
const worldWith = async (
  program: Partial<ProgramContract>,
  options: { readonly laptop?: boolean } = {},
): Promise<World> => {
  let world: World | undefined;
  world = await createWorld({
    program,
    ...(options.laptop === true ? {} : { projectEnv: PROJECT_ENV }),
    harness: createFakeHarness({
      script: (context) =>
        context.input.agent.role === "examiner"
          ? examine(world as World, context.input)
          : build(world as World, context),
    }),
  });
  return world;
};

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

/** `process.env` as it is now, to compare with after. */
const snapshot = (): Record<string, string | undefined> => ({ ...process.env });

const expectUntouched = (before: Record<string, string | undefined>): void => {
  expect({ ...process.env }).toEqual(before);
  expect(process.env.NS_PROJECT_ONLY).toBeUndefined();
};

describe("the project environment, threaded to every project step (P16, D-10)", () => {
  it("reaches setup, verification's first run and its rerun without a worker user, and is never adopted", async () => {
    const before = snapshot();
    const setup = await probe();
    const check = await probe(1);
    const world = await worldWith({
      setup: [{ id: "install", command: setup.command }],
      verification: [{ id: "probe", command: check.command }],
    });
    expect(world.environment.runAs).toBeUndefined();
    const nodeId = await runDirect(world);

    expect((await world.stores.executionNodes.get(world.scope, nodeId))?.status).toBe("integrated");
    // Preparing the worker's worktree, then verification's own setup.
    expect(await setup.runs()).toEqual(["ok", "ok"]);
    // The first run, which fails on purpose, and the rerun, which passes.
    expect(await check.runs()).toEqual(["ok", "ok"]);
    const [verification] = await verificationsOf(world, nodeId);
    expect(commandOf(verification, "probe")).toMatchObject({
      exitCode: 0,
      flaky: { firstExitCode: 1 },
    });
    expectUntouched(before);
  });

  it("reaches an examined job's candidate setup, check and rerun", async () => {
    const before = snapshot();
    const setup = await probe();
    // Fails once: the candidate's first run. Its rerun and the queue's run pass.
    const check = await probe(1);
    const world = await worldWith({
      setup: [{ id: "install", command: setup.command }],
      verification: [{ id: "probe", command: check.command }],
    });
    const nodeId = await runThroughEngine(world, "high");

    expect((await world.stores.executionNodes.get(world.scope, nodeId))?.status).toBe("integrated");
    expect(await check.runs()).toEqual(["ok", "ok", "ok"]);
    expect((await setup.runs()).every((run) => run === "ok")).toBe(true);
    const candidate = (await verificationsOf(world, nodeId)).find(
      (verification) => verification.phase === "candidate",
    );
    expect(candidate?.outcome).toBe("passed");
    expect(commandOf(candidate, "probe")).toMatchObject({ flaky: { firstExitCode: 1 } });
    expectUntouched(before);
  });

  it("reaches the setup reference in the program checkout", async () => {
    const before = snapshot();
    const setup = await probe();
    const world = await worldWith({ setup: [{ id: "install", command: setup.command }] });

    expect(
      await prepareSetupReference(
        world.environment,
        world.session,
        world.session.rootNodeId,
        "for the test",
      ),
    ).toBe(true);
    expect(await setup.runs()).toEqual(["ok"]);
    expectUntouched(before);
  });

  it("on a laptop, with none, a step runs in this process's environment as before", async () => {
    const setup = await probe();
    const world = await worldWith(
      { setup: [{ id: "install", command: setup.command }] },
      { laptop: true },
    );

    expect(world.environment.projectEnv).toBeUndefined();
    expect(
      await prepareSetupReference(
        world.environment,
        world.session,
        world.session.rootNodeId,
        "for the test",
      ),
    ).toBe(false);
    expect(await setup.runs()).toEqual(["missing"]);
  });
});
