/**
 * The complete SC-12 history, end to end (P20, S-04 J3; acceptance criterion 10).
 *
 * One scripted story is driven through the real engine, real git, the production
 * API handler and the fake harness, which emits its usage through the S-01
 * measurement seam:
 *
 * - program A, run 1: two jobs run in parallel (`maxConcurrency` 2). One fails
 *   verification at its first attempt and is retried; one is examined, gets a
 *   material finding, is repaired and examined clean; one is replayed onto a
 *   head that moved under it, hits an integration conflict, is retried and
 *   lands. The run succeeds and a person rates it down.
 * - a failed run of program A, which spent tokens and delivered nothing.
 * - program B corrects a decision of run 1; its run succeeds and is rated up,
 *   down and up again, while run 1's verdict is cleared and given again.
 * - a completion history anchored at run 1, with the failed run and the
 *   correction as members and a checkpoint after the correction.
 *
 * The same history is then read through the report, the versioned export and
 * the CLI, and each must give the same figures. The records it leaves are
 * written to `test/fixtures/sc12-history/records.json` for a later Studio job.
 *
 * Time: the engine's stepping clock decides the timestamps of the engine phase,
 * and how many readings fall between two events depends on how the parallel
 * jobs interleave. So the engine phase's durations are asserted by relation and
 * by equality across the surfaces, never as literals; every figure the history
 * derives from run intervals and verdict times is pinned (`pin` below) and
 * asserted as a literal.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeTestPrincipal } from "@nightshift/api/testing";
import { type CliEnvironment, runCli } from "@nightshift/cli";
import {
  type Agent,
  type CompletionHistory,
  CompletionHistorySchema,
  type Decision,
  type Examination,
  ExaminationSchema,
  type ExecutionNode,
  type ExecutionNodeId,
  ExecutionNodeSchema,
  type IsoTimestamp,
  type JobContract,
  type JobContractId,
  JobContractSchema,
  type MeasurementSummary,
  MeasurementSummarySchema,
  type ModelPrice,
  type ProgramContract,
  ProgramContractSchema,
  ReportExportSchema,
  type RouteChoice,
  type RouteTarget,
  RoutingDecisionSchema,
  type Run,
  RunFeedbackSchema,
  type RunId,
  RunSchema,
  type UserPrincipal,
  VerificationSchema,
} from "@nightshift/contracts";
import {
  buildCompletionHistory,
  buildRunFeedback,
  type Clock,
  type CompletionFigures,
  completionEvidenceLines,
  completionOf,
  createSteppingClock,
  type DeliveryReport,
  exportReport,
  gatherMemberFigures,
  gatherReport,
  isSettled,
  type MemberEvidence,
  nowIso,
  type RunScope,
  renderReport,
  type WorkItemEvidence,
} from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  type Engine,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  type ExecutionEnvironment,
  failJob,
  nodeGitRunner,
  type RunSession,
  startRun,
} from "@nightshift/execution";
import type { HarnessExit, HarnessStartInput } from "@nightshift/harness";
import {
  ControlPlaneError,
  createFetchTransport,
  createHttpStores,
  type FetchLike,
  staticTokenProvider,
  writeCredentials,
  writeProfile,
} from "@nightshift/persistence/http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTH_DOMAIN, CLIENT_ID, SUBJECT } from "../cli/operator.js";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld, type World } from "./world.js";

// --- The price table -----------------------------------------------------------------------

const PRICE_SOURCE = "sc12-price-list";
const PRICE_VERSION = "2026-10-01";
const BUILDER_MODEL = "claude-sonnet-5";
const EXAMINER_MODEL = "gpt-6-astra";
const PRICES: Readonly<Record<string, ModelPrice>> = {
  [BUILDER_MODEL]: {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: PRICE_SOURCE,
    version: PRICE_VERSION,
  },
  [EXAMINER_MODEL]: {
    inputPerMTok: 2,
    outputPerMTok: 10,
    source: PRICE_SOURCE,
    version: PRICE_VERSION,
  },
};

const target = (provider: string, model: string): RouteTarget => ({
  harness: "fake",
  provider,
  model,
});
const choice = (routeTarget: RouteTarget): RouteChoice => ({
  target: routeTarget,
  eligibleOptions: [{ target: routeTarget, eligible: true }],
  ruleId: "R-sc12",
  wasOverride: false,
});
const BUILDER = target("anthropic", BUILDER_MODEL);
const EXAMINER = target("openai", EXAMINER_MODEL);

// --- What each attempt consumes ---------------------------------------------------------------

type Usage = { readonly input: number; readonly output: number };

/** Keyed `<job>:<attempt>`; the figures the fake harness emits, request by request. */
const BUILDER_USAGE: Readonly<Record<string, Usage>> = {
  "alpha:1": { input: 10_000, output: 2_000 },
  "alpha:2": { input: 12_000, output: 2_500 },
  "beta:1": { input: 20_000, output: 4_000 },
  "beta:2": { input: 8_000, output: 1_500 },
  "first:1": { input: 5_000, output: 1_000 },
  "second:1": { input: 6_000, output: 1_200 },
  "second:2": { input: 6_500, output: 1_300 },
  // Program A's second run, which fails.
  "doomed:1": { input: 3_000, output: 600 },
  // Program B's run.
  "fixit:1": { input: 4_000, output: 800 },
};
/** Keyed by the examiner's call on a node. */
const EXAMINER_USAGE: Readonly<Record<number, Usage>> = {
  1: { input: 3_000, output: 500 },
  2: { input: 2_500, output: 400 },
};

// --- Time ------------------------------------------------------------------------------------------

const START_MS = Date.parse("2026-09-15T12:00:00.000Z");
const at = (iso: string): number => Date.parse(iso);

type PinnableClock = Clock & { pin(iso: string): void; advance(ms: number): void };

/**
 * A clock that moves only when the story moves it. Every reading returns the
 * same instant until `pin` or `advance`, so how many times the engine, its
 * pollers and the API happen to read it cannot change a single timestamp: the
 * records of two runs of the story differ in ids and commits alone.
 */
const pinnableClock = (): PinnableClock => {
  let current = START_MS;
  return {
    now: () => current,
    pin: (iso) => {
      current = at(iso);
    },
    advance: (ms) => {
      current += ms;
    },
  };
};

// --- The scripted workers ---------------------------------------------------------------------------

const barrier = () => {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

const edit = async (worktree: string, path: string, change: (text: string) => string) => {
  const file = join(worktree, path);
  const existing = await readFile(file, "utf8").catch(() => "");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, change(existing), "utf8");
};

const SHARED = `${Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

const PASSING_TEST = (name: string): string =>
  `import { test } from "node:test";\nimport assert from "node:assert/strict";\n` +
  `import { ${name} } from "../src/${name}.js";\ntest("${name}", () => assert.equal(${name}(), "${name}"));\n`;

const addModule = async (worktree: string, name: string): Promise<void> => {
  await edit(worktree, `src/${name}.js`, () => `export const ${name} = () => "${name}";\n`);
  await edit(worktree, `test/${name}.test.js`, () => PASSING_TEST(name));
};

const editLine = async (worktree: string, line: number, text: string): Promise<void> => {
  await edit(worktree, "src/shared.js", (body) =>
    body
      .split("\n")
      .map((existing, index) => (index === line - 1 ? text : existing))
      .join("\n"),
  );
};

/** One observation through the S-01 seam: a request's tokens, metadata only. */
const requestObservation = (id: string, model: string, usage: Usage) =>
  ({
    schemaVersion: 1,
    observationId: id,
    source: "harness",
    provenance: { adapter: "fake" },
    inclusion: "self",
    kind: "request",
    model,
    counters: { inputTokens: usage.input, outputTokens: usage.output, inputIncludesCache: false },
  }) as never;

/** The launch's own total, which the recorder reconciles with the requests rather than adds to them. */
const exitUsage = (usage: Usage) => ({ inputTokens: usage.input, outputTokens: usage.output });

const helperStores = (world: World, input: HarnessStartInput) =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });

const examine = async (
  world: World,
  input: HarnessStartInput,
  call: number,
): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
  const findings =
    call === 1
      ? [
          {
            id: "F-01",
            severity: "material" as const,
            summary: "a material finding",
            evidence: [{ kind: "contract" as const, clause: "It works." }],
            resolution: "unresolved" as const,
          },
        ]
      : [];
  input.measurements?.observe(
    requestObservation(`examiner-${call}`, input.model.model, EXAMINER_USAGE[call] as Usage),
  );
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
      outcome: findings.length === 0 ? "passed" : "findings_raised",
      findings,
      createdAt: nowIso(world.environment.clock),
    }) as Examination,
  );
  return {
    kind: "completed",
    sessionId: "examiner-session",
    usage: exitUsage(EXAMINER_USAGE[call] as Usage),
    coverage: "complete",
  };
};

// --- The world ----------------------------------------------------------------------------------------

const withPrices = (session: RunSession): RunSession => {
  const policy = session.run?.policy;
  if (session.run === undefined || policy === undefined) return session;
  return {
    ...session,
    run: {
      ...session.run,
      policy: { ...policy, routingPolicy: { ...policy.routingPolicy, prices: PRICES } },
    },
  };
};

const mcp = () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} });

const settled = (status: string): boolean => isSettled(status as never);

const readAll = async <T>(
  page: (cursor: { cursor?: string }) => Promise<{ items: readonly T[]; cursor?: string }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const next = await page(cursor === undefined ? {} : { cursor });
    items.push(...next.items);
    cursor = next.cursor;
  } while (cursor !== undefined);
  return items;
};

/** A run attached to the world, as `createWorld` attaches the first: its own session and outbox. */
interface Attached {
  readonly scope: RunScope;
  readonly session: RunSession;
  readonly environment: ExecutionEnvironment;
  readonly engine: Engine;
  submit(
    objective: string,
    extra?: Partial<JobContract>,
  ): Promise<{ jobId: JobContractId; nodeId: ExecutionNodeId }>;
  until(nodeId: ExecutionNodeId, predicate: (status: string) => boolean): Promise<string>;
  idle(): Promise<void>;
}

const examinationServices: ExaminationServices = {
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

const attachEngine = (
  world: World,
  session: RunSession,
  environment: ExecutionEnvironment,
): Attached => {
  const engine = createEngine({
    environment: { ...environment, examination: examinationServices, sleep: async () => {} },
    session: withPrices(session),
    mcp,
    route: () => choice(BUILDER),
  });
  const scope = session.scope;
  return {
    scope,
    session,
    environment,
    engine,
    submit: async (objective, extra) => {
      const job = JobContractSchema.parse({
        schemaVersion: 1,
        ...scope,
        jobContractId: world.ids.next("job"),
        objective,
        acceptance: ["node --test passes"],
        dependencies: [],
        risk: "low",
        ambiguity: "low",
        ...extra,
        createdAt: nowIso(world.clock),
      });
      const submitted = await engine.submit({
        job,
        depth: 1,
        parentNodeId: session.rootNodeId,
        route: choice(BUILDER),
      });
      return { jobId: job.jobContractId, nodeId: submitted.nodeId as ExecutionNodeId };
    },
    until: async (nodeId, predicate) => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const status = (await world.stores.executionNodes.get(scope, nodeId))?.status ?? "missing";
        if (predicate(status)) return status;
        if (Date.now() > deadline) throw new Error(`node ${nodeId} is still ${status}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    idle: () => vi.waitFor(() => expect(engine.idle()).toBe(true), { timeout: 60_000 }),
  };
};

/** Starts a further run of `program` in the world, as `createWorld` starts the first. */
const attachRun = async (
  world: World,
  clock: PinnableClock,
  program: ProgramContract,
  startedAt: string,
): Promise<Attached> => {
  const { stores, ids } = world;
  // The run is recorded as started at exactly this instant, and its own clock runs on from it.
  clock.pin(startedAt);
  const started = await startRun(
    { stores, clock, ids, git: world.git },
    { program, repoPath: world.repo },
  );
  const scope: RunScope = {
    projectId: program.projectId,
    programId: program.programId,
    runId: started.run.runId,
  };
  await stores.runs.put({ ...started.run, status: "running" });
  const orchestrator: Agent = {
    schemaVersion: 1,
    ...scope,
    agentId: ids.next("agent"),
    executionNodeId: started.rootNode.executionNodeId,
    role: "orchestrator",
    harness: "test",
    provider: "test",
    model: "test",
    status: "created",
    createdAt: nowIso(clock),
  };
  await stores.agents.put(orchestrator);
  for (const status of ["queued", "running"] as const) {
    await stores.executionNodes.put({ ...started.rootNode, status, updatedAt: nowIso(clock) });
  }
  const session: RunSession = {
    scope,
    program: started.program,
    run: { ...started.run, status: "running" },
    rootNodeId: started.rootNode.executionNodeId,
    orchestratorAgentId: orchestrator.agentId,
    repoPath: world.repo,
  };
  const environment: ExecutionEnvironment = {
    ...world.environment,
    outbox: createEventOutbox({
      events: stores.events,
      scope,
      clock,
      ids,
      writerId: orchestrator.agentId,
      initialDelayMs: 1,
      maxDelayMs: 4,
    }),
  };
  return attachEngine(world, session, environment);
};

/** A run's end, as the orchestrator that finished it would record it: a status and a time. */
const endRun = async (
  world: World,
  attached: Attached,
  status: "succeeded" | "failed",
  endedAt: string,
  outcomeReason?: string,
): Promise<Run> => {
  await attached.environment.outbox.flush();
  const run = await world.stores.runs.get(attached.scope, attached.scope.runId);
  if (run === undefined) throw new Error("the run is not on the record");
  const ended: Run = {
    ...run,
    status,
    endedAt: endedAt as never,
    ...(outcomeReason === undefined ? {} : { outcomeReason }),
  };
  await world.stores.runs.put(ended);
  return ended;
};

// --- The operator's terminal ------------------------------------------------------------------------

interface Terminal {
  readonly repo: string;
  /** Runs `nightshift <argv> --repo <repo>`. */
  run(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }>;
  cleanup(): Promise<void>;
}

/** A signed-in CLI pointed at the world's own control plane, as `test/src/cli/operator.ts` signs one in. */
const signInTo = async (world: World, programs: Readonly<Record<string, ProgramContract>>) => {
  const root = await mkdtemp(join(tmpdir(), "nightshift-sc12-cli-"));
  const paths = {
    env: { NIGHTSHIFT_CONFIG_DIR: join(root, "config"), NIGHTSHIFT_STATE_DIR: join(root, "state") },
    platform: process.platform,
    home: root,
  };
  const clock = createSteppingClock(START_MS, 1_000);
  await writeProfile(
    { apiEndpoint: world.plane.url, authDomain: AUTH_DOMAIN, clientId: CLIENT_ID, stage: "test" },
    paths,
  );
  await writeCredentials(
    {
      refreshToken: "a-refresh-token-that-must-never-be-printed",
      subject: SUBJECT,
      clientId: CLIENT_ID,
      obtainedAt: nowIso(clock),
    },
    paths,
  );
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const real = globalThis.fetch as unknown as FetchLike;
  const fetch: FetchLike = async (url, init) => {
    if (!url.startsWith(`https://${AUTH_DOMAIN}/`)) return real(url, init);
    const body = JSON.stringify({
      id_token: `${part({ alg: "none", typ: "JWT" })}.${part({
        sub: SUBJECT,
        email: "operator@example.test",
        exp: Math.floor(START_MS / 1000) + 10 * 365 * 24 * 3600,
      })}.`,
      access_token: "unused",
      expires_in: 3600,
      token_type: "Bearer",
    });
    return { status: 200, text: async () => body };
  };
  const out: string[] = [];
  const err: string[] = [];
  const environment: CliEnvironment = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    cwd: root,
    paths,
    fetch,
    openBrowser: async () => false,
    readPaste: () => ({ line: new Promise<undefined>(() => undefined), cancel: () => undefined }),
    clock,
    ids: world.ids,
    git: nodeGitRunner,
    startLoopback: async () => {
      throw new Error("no command in this suite opens a loopback listener");
    },
    sleep: async () => undefined,
    stdoutIsTTY: false,
    onInterrupt: () => () => undefined,
  };
  const repo = join(root, "repo");
  for (const [name, program] of Object.entries(programs)) {
    await mkdir(join(repo, "docs", "programs", name), { recursive: true });
    await writeFile(
      join(repo, "docs", "programs", name, "contract.json"),
      JSON.stringify(program satisfies ProgramContract),
    );
    await writeFile(join(repo, "docs", "programs", name, "plan.md"), `# ${name}\n`);
  }
  const terminal: Terminal = {
    repo,
    run: async (...argv) => {
      out.length = 0;
      err.length = 0;
      const code = await runCli(environment, [...argv, "--repo", repo]);
      return { code, out: [...out], err: [...err] };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  return terminal;
};

// --- The story --------------------------------------------------------------------------------------------

interface Facts {
  readonly world: World;
  readonly terminal: Terminal;
  readonly programA: ProgramContract;
  readonly programB: ProgramContract;
  readonly names: ReadonlyMap<string, string>;
  readonly run1: RunScope;
  readonly failedRun: RunScope;
  readonly correctionRun: RunScope;
  readonly jobs: Readonly<Record<string, { jobId: JobContractId; nodeId: ExecutionNodeId }>>;
  readonly historyId: string;
  readonly peakWorkers: number;
  readonly asOf: IsoTimestamp;
  /** What rating run 1 must leave alone, read before the first verdict and after the last. */
  readonly untouched: { readonly before: Untouched; readonly after: Untouched };
  /** Every revision of each run's verdict, as the CLI said it. */
  readonly said: Readonly<Record<string, readonly string[]>>;
  readonly refusals: readonly { who: string; what: string; status: number | undefined }[];
  readonly duplicate: { code: number; err: string[] };
}

interface Untouched {
  readonly nodes: readonly [string, string][];
  readonly run: { readonly status: string; readonly outcomeReason: string | undefined };
  readonly verifications: number;
  readonly examinations: number;
}

const untouchedOf = async (world: World, scope: RunScope): Promise<Untouched> => {
  const nodes = await readAll<ExecutionNode>((p) =>
    world.stores.executionNodes.listByRun(scope, p),
  );
  let verifications = 0;
  let examinations = 0;
  for (const node of nodes) {
    verifications += (await world.stores.verifications.listByNode(scope, node.executionNodeId))
      .length;
    examinations += (await world.stores.examinations.listByNode(scope, node.executionNodeId))
      .length;
  }
  const run = await world.stores.runs.get(scope, scope.runId);
  return {
    nodes: nodes.map((node): [string, string] => [node.executionNodeId, node.status]),
    run: { status: run?.status ?? "missing", outcomeReason: run?.outcomeReason },
    verifications,
    examinations,
  };
};

const play = async (): Promise<Facts> => {
  const clock = pinnableClock();
  const attempts = new Map<string, number>();
  const calls = new Map<string, number>();
  const bump = (counts: Map<string, number>, key: string): number => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
  /** Both of a round's workers wait here, so the story can see them running at once. */
  const gates = [barrier(), barrier()];
  const hold = barrier();
  let atHold = false;
  const atGate = [new Set<string>(), new Set<string>()];

  /** What a worker does, by job and attempt. A `"fail"` is a worker that gives up. */
  const work = async (
    name: string,
    attempt: number,
    { worktree }: ScriptContext,
  ): Promise<"fail" | undefined> => {
    switch (name) {
      case "alpha":
        atGate[attempt - 1]?.add(name);
        await gates[attempt - 1]?.opened;
        await writeFile(join(worktree, "src", "shared.js"), SHARED, "utf8");
        await addModule(worktree, name);
        await edit(worktree, "test/broken.test.js", () =>
          attempt === 1
            ? `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("no", () => assert.equal(1, 2));\n`
            : `import { test } from "node:test";\ntest("repaired", () => {});\n`,
        );
        return undefined;
      case "beta":
        atGate[attempt - 1]?.add(name);
        await gates[attempt - 1]?.opened;
        await addModule(worktree, name);
        // Each attempt is a different change.
        await edit(worktree, "src/attempt.js", (text) => `${text}// attempt ${attempt}\n`);
        return undefined;
      case "first":
        await editLine(worktree, 5, "first changed line 5");
        return undefined;
      case "second":
        // Both edit line 5 from the same head; this one is ready only after the other landed.
        if (attempt === 1) {
          atHold = true;
          await hold.opened;
        }
        await editLine(worktree, 5, "second changed line 5");
        return undefined;
      case "doomed":
        return "fail";
      default:
        await addModule(worktree, name);
        return undefined;
    }
  };

  let world!: World;
  const harness = createFakeHarness({
    script: async (context): Promise<HarnessExit> => {
      const { input } = context;
      if (input.agent.role === "examiner") {
        return examine(world, input, bump(calls, input.node.executionNodeId));
      }
      const name = input.job.objective.split(" ")[0] ?? "";
      const attempt = bump(attempts, name);
      const used = BUILDER_USAGE[`${name}:${attempt}`] as Usage;
      input.measurements?.observe(
        requestObservation(`${name}-${attempt}`, input.model.model, used),
      );
      const ended = await Promise.race([
        work(name, attempt, context),
        context.cancelled.then(() => "cancelled" as const),
      ]);
      if (ended === "cancelled") return { kind: "cancelled" };
      const outbox = createEventOutbox({
        events: world.stores.events,
        scope: context.identity.scope,
        clock: world.environment.clock,
        ids: world.ids,
        writerId: context.identity.agentId,
        initialDelayMs: 1,
      });
      const environment = { stores: world.stores, clock: world.clock, git: world.git, outbox };
      if (ended === "fail") await failJob(environment, context.identity, `${name}: gave up`);
      else await completeJob(environment, context.identity, `${name}: done`);
      await outbox.flush();
      return { kind: "completed", usage: exitUsage(used), coverage: "complete" };
    },
  });
  world = await createWorld({
    harness,
    clock,
    program: { delegationLimits: { maxDepth: 2, maxConcurrency: 2 } },
  });
  const programA = world.program;
  const jobs: Record<string, { jobId: JobContractId; nodeId: ExecutionNodeId }> = {};

  // --- Run 1 ----------------------------------------------------------------------------------------
  const one = await attachRun0(world);
  jobs.alpha = await one.submit("alpha module");
  jobs.beta = await one.submit("beta module", { risk: "medium" });
  // Two workers are inside their first attempts at once, which is what maxConcurrency 2 allows,
  // and they work for a minute together.
  await vi.waitFor(() => expect(atGate[0]?.size).toBe(2), { timeout: 60_000 });
  const peakWorkers = atGate[0]?.size ?? 0;
  clock.advance(60_000);
  gates[0]?.open();
  expect(await one.until(jobs.alpha.nodeId, settled)).toBe("verification_failed");
  expect(await one.until(jobs.beta.nodeId, settled)).toBe("failed");
  await one.idle();
  clock.advance(30_000);
  expect(await one.engine.retry(jobs.alpha.jobId)).toBe(true);
  expect(await one.engine.retry(jobs.beta.jobId)).toBe(true);
  // Their second attempts overlap for two minutes.
  await vi.waitFor(() => expect(atGate[1]?.size).toBe(2), { timeout: 60_000 });
  clock.advance(120_000);
  gates[1]?.open();
  expect(await one.until(jobs.alpha.nodeId, (s) => s === "integrated")).toBe("integrated");
  expect(await one.until(jobs.beta.nodeId, (s) => s === "integrated")).toBe("integrated");
  await one.idle();

  clock.advance(30_000);
  // The 45 seconds belong to the integration interval of "first", which the merge queue closes
  // with an `end` observation stamped from the clock *after* "first" is stored as `integrated`
  // (merge-queue.ts, integrateOne). A story that advanced the clock once `until(first, settled)`
  // returned would race that observation: on a loaded machine the `end` is stamped before the
  // advance and the union is 0. So the advance happens inside the write of "first" as integrated,
  // which is guaranteed to precede the `end` observation and to follow the `start` one. It first
  // waits for the "second" worker to be at its hold, so its work interval opened at the same
  // instant "first" started integrating and runs the whole 45 seconds.
  let firstId: ExecutionNodeId | undefined;
  let landed = false;
  const nodes = world.stores.executionNodes;
  const putNode = nodes.put.bind(nodes);
  nodes.put = async (node) => {
    if (node.executionNodeId === firstId && node.status === "integrated" && !landed) {
      landed = true;
      await vi.waitFor(() => expect(atHold).toBe(true), { timeout: 60_000 });
      clock.advance(45_000);
    }
    return putNode(node);
  };
  jobs.first = await one.submit("first module");
  firstId = jobs.first.nodeId;
  jobs.second = await one.submit("second module");
  expect(await one.until(jobs.first.nodeId, settled)).toBe("integrated");
  // The second job was cut from the head the first one has now moved, and works for 45 seconds.
  expect(landed).toBe(true);
  hold.open();
  expect(await one.until(jobs.second.nodeId, settled)).toBe("failed");
  await one.idle();
  clock.advance(15_000);
  expect(await one.engine.retry(jobs.second.jobId)).toBe(true);
  expect(await one.until(jobs.second.nodeId, (s) => s === "integrated")).toBe("integrated");
  await one.idle();
  await one.engine.close("run 1 is done");
  await endRun(world, one, "succeeded", "2026-09-15T12:30:00.000Z");

  // A decision of run 1 that a human reverses, for the correction to name.
  const [startCheckpoint] = (await world.stores.checkpoints.listByRun(one.scope)).items;
  const decision: Decision = {
    schemaVersion: 1,
    ...one.scope,
    decisionId: world.ids.next("dec"),
    executionNodeId: one.session.rootNodeId,
    agentId: null,
    context: "How to share state between modules",
    alternatives: [{ summary: "a shared file", rejectedBecause: "modules edit it at once" }],
    choice: "one shared file",
    rationale: "simplest",
    reversibility: "reversible",
    checkpointBefore: startCheckpoint?.checkpointId as never,
    affectedNodes: [],
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: "2026-09-15T12:05:00.000Z" as never,
  };
  await world.stores.decisions.put(decision);
  const reversal: Decision = {
    ...decision,
    decisionId: world.ids.next("dec"),
    choice: "a file per module",
    rationale: "the modules collided",
    authority: "human",
    supersedesDecisionId: decision.decisionId,
    createdAt: "2026-09-15T12:35:00.000Z" as never,
  };
  await world.stores.decisions.put(reversal);

  // --- A second run of program A, which fails ------------------------------------------------------------------
  const doomedRun = await attachRun(world, clock, programA, "2026-09-15T12:20:00.000Z");
  jobs.doomed = await doomedRun.submit("doomed module");
  expect(await doomedRun.until(jobs.doomed.nodeId, settled)).toBe("failed");
  await doomedRun.idle();
  await doomedRun.engine.close("run 2 is done");
  await endRun(world, doomedRun, "failed", "2026-09-15T12:40:00.000Z", "the worker gave up");

  // --- Program B corrects run 1's decision --------------------------------------------------------------------
  const programB: ProgramContract = ProgramContractSchema.parse({
    ...programA,
    programId: world.ids.next("prog"),
    objective: "Correct what run 1 decided.",
    corrects: [
      {
        programId: one.scope.programId,
        runId: one.scope.runId,
        decisionId: decision.decisionId,
        reversedBy: reversal.decisionId,
      },
    ],
  });
  const correction = await attachRun(world, clock, programB, "2026-09-15T13:00:00.000Z");
  jobs.fixit = await correction.submit("fixit module");
  expect(await correction.until(jobs.fixit.nodeId, settled)).toBe("integrated");
  await correction.idle();
  await correction.engine.close("the correction is done");
  await endRun(world, correction, "succeeded", "2026-09-15T13:10:00.000Z");

  // --- The human phase: every instant is pinned ---------------------------------------------------------------------
  const terminal = await signInTo(world, { alpha: programA, beta: programB });
  const said: Record<string, string[]> = { run1: [], correction: [] };
  const cli = async (pin: string, ...argv: string[]) => {
    clock.pin(pin);
    const result = await terminal.run(...argv);
    expect(result.code, result.err.join("\n")).toBe(0);
    return result.out.join("\n");
  };

  // Rating creates no verification and moves no node or outcome: read around the whole of it.
  const before = await untouchedOf(world, one.scope);
  said.run1?.push(
    await cli("2026-09-15T13:20:00.000Z", "rate", "alpha", "down", "--run", one.scope.runId),
  );

  const created = await cli(
    "2026-09-15T13:30:00.000Z",
    "completion",
    "create",
    "alpha",
    "--title",
    "Ordered modules",
    "--run",
    one.scope.runId,
  );
  const historyId = /completion history (comp_\w+)/.exec(created)?.[1] as string;
  const member = (scope: RunScope) => `${scope.programId}/${scope.runId}`;
  await cli(
    "2026-09-15T13:31:00.000Z",
    "completion",
    "add",
    "alpha",
    "--history",
    historyId,
    "--member",
    member(doomedRun.scope),
    "--role",
    "contributing",
  );
  await cli(
    "2026-09-15T13:32:00.000Z",
    "completion",
    "add",
    "alpha",
    "--history",
    historyId,
    "--member",
    member(correction.scope),
    "--role",
    "correction",
  );
  // The same run named twice is one member.
  clock.pin("2026-09-15T13:33:00.000Z");
  const duplicate = await terminal.run(
    "completion",
    "add",
    "alpha",
    "--history",
    historyId,
    "--member",
    member(one.scope),
  );

  said.correction?.push(await cli("2026-09-15T14:00:00.000Z", "rate", "beta", "up"));
  said.correction?.push(await cli("2026-09-15T14:05:00.000Z", "rate", "beta", "down"));
  said.correction?.push(await cli("2026-09-15T14:10:00.000Z", "rate", "beta", "up"));
  said.run1?.push(
    await cli("2026-09-15T14:12:00.000Z", "rate", "alpha", "clear", "--run", one.scope.runId),
  );
  said.run1?.push(
    await cli("2026-09-15T14:15:00.000Z", "rate", "alpha", "down", "--run", one.scope.runId),
  );
  await cli(
    "2026-09-15T14:20:00.000Z",
    "completion",
    "checkpoint",
    "alpha",
    "--history",
    historyId,
    "--name",
    "after-correction",
    "--member",
    member(correction.scope),
  );
  const after = await untouchedOf(world, one.scope);

  // An execution principal may neither rate nor edit membership.
  clock.pin("2026-09-15T14:30:00.000Z");
  const refusals = await refusalsOf(
    world,
    one,
    historyId,
    jobs.alpha as { nodeId: ExecutionNodeId },
  );

  // Nothing is read after this instant, so every open interval of a report reads to it.
  clock.pin("2026-09-15T15:00:00.000Z");
  return {
    world,
    terminal,
    programA,
    programB,
    names: new Map(Object.entries(jobs).map(([name, job]) => [job.nodeId, name])),
    run1: one.scope,
    failedRun: doomedRun.scope,
    correctionRun: correction.scope,
    jobs,
    historyId,
    peakWorkers,
    asOf: "2026-09-15T15:00:00.000Z" as IsoTimestamp,
    untouched: { before, after },
    said,
    refusals,
    duplicate: { code: duplicate.code, err: duplicate.err },
  };
};

const attachRun0 = (world: World): Attached =>
  attachEngine(world, world.session, world.environment);

/** What each execution principal gets when it tries to rate run 1 and to edit the history's membership. */
const refusalsOf = async (
  world: World,
  one: Attached,
  historyId: string,
  workerNode: { nodeId: ExecutionNodeId },
) => {
  const stores = world.stores;
  const project = await stores.projects.get(one.scope.projectId);
  const actor = { kind: "user", userId: SUBJECT as never, orgId: project?.orgId } as UserPrincipal;
  const [worker] = await stores.agents.listByNode(one.scope, workerNode.nodeId);
  const principals = {
    worker: {
      kind: "execution",
      ...one.scope,
      nodeId: workerNode.nodeId,
      agentId: worker?.agentId,
      role: "worker",
    },
    orchestrator: {
      kind: "execution",
      ...one.scope,
      nodeId: one.session.rootNodeId,
      agentId: one.session.orchestratorAgentId,
      role: "orchestrator",
    },
  } as const;
  const history = (
    await readAll((p) => stores.completionHistories.listByProject(one.scope.projectId, p))
  ).find((h) => h.completionHistoryId === historyId) as CompletionHistory;
  const verdict = await stores.feedback.get(one.scope);
  const refusals: { who: string; what: string; status: number | undefined }[] = [];
  for (const [who, principal] of Object.entries(principals)) {
    const acting = createHttpStores({
      transport: createFetchTransport({
        endpoint: world.plane.url,
        tokens: staticTokenProvider(encodeTestPrincipal(principal as never)),
      }),
    });
    const attempts: [string, () => Promise<unknown>][] = [
      [
        "rate",
        () =>
          acting.feedback.put(
            buildRunFeedback({
              ...(verdict === undefined ? {} : { stored: verdict }),
              scope: one.scope,
              verdict: "worked",
              actor,
              at: nowIso(world.clock) as IsoTimestamp,
            }),
          ),
      ],
      [
        "membership",
        () =>
          acting.completionHistories.put(
            buildCompletionHistory({
              stored: history,
              scope: {
                projectId: history.projectId,
                programId: history.programId,
                runId: history.runId,
              },
              completionHistoryId: history.completionHistoryId,
              title: history.title,
              members: history.members.filter((m) => m.role !== "correction"),
              actor,
              at: nowIso(world.clock) as IsoTimestamp,
            }),
          ),
      ],
    ];
    for (const [what, attempt] of attempts) {
      const status = await attempt().then(
        () => undefined,
        (error: unknown) => (error instanceof ControlPlaneError ? error.status : -1),
      );
      refusals.push({ who, what, status });
    }
  }
  return refusals;
};

afterAll(cleanupWorlds);

let facts: Facts;
beforeAll(async () => {
  facts = await play();
}, 300_000);

// --- The fixture of the records --------------------------------------------------------------------

/** The same switch the Codex probe uses: `write` regenerates what is committed. */
const MEASUREMENT_FIXTURES_ENV = "NIGHTSHIFT_MEASUREMENT_FIXTURES";
const FIXTURE_NAME = "test/fixtures/sc12-history/records.json";
const FIXTURE_PATH = fileURLToPath(
  new URL("../../fixtures/sc12-history/records.json", import.meta.url),
);
const FIXTURE_ROOT = "/tmp/nightshift-sc12";

/**
 * Every record the story left, in an order that does not depend on which of two
 * parallel jobs reached the control plane first: nodes by run, depth and job
 * name, and each node's own records in the order they were made.
 */
const recordsOf = async (f: Facts) => {
  const { stores } = f.world;
  const scopes = [f.run1, f.failedRun, f.correctionRun];
  const nodes: ExecutionNode[] = [];
  for (const scope of scopes) {
    const found = await readAll((p) => stores.executionNodes.listByRun(scope, p));
    const nameOf = (node: ExecutionNode) => f.names.get(node.executionNodeId) ?? "";
    nodes.push(...found.sort((a, b) => a.depth - b.depth || nameOf(a).localeCompare(nameOf(b))));
  }
  const scopeOf = (node: ExecutionNode): RunScope => ({
    projectId: node.projectId,
    programId: node.programId,
    runId: node.runId,
  });
  const byNode = async <T>(
    read: (scope: RunScope, id: ExecutionNodeId) => Promise<readonly T[]>,
  ) => {
    const found: T[] = [];
    for (const node of nodes) found.push(...(await read(scopeOf(node), node.executionNodeId)));
    return found;
  };
  const routingDecisions = await byNode((scope, id) =>
    stores.routingDecisions.listByNode(scope, id),
  );
  const position = new Map(
    routingDecisions.map((route, index) => [route.routingDecisionId, index]),
  );
  const measurements: MeasurementSummary[] = [];
  for (const scope of scopes) {
    const found = await readAll((p) => stores.measurements.listByRun(scope, p));
    measurements.push(
      ...found.sort(
        (a, b) =>
          (position.get(a.routingDecisionId as never) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.routingDecisionId as never) ?? Number.MAX_SAFE_INTEGER),
      ),
    );
  }
  const present = <T>(items: readonly (T | undefined)[]): T[] =>
    items.filter((item): item is T => item !== undefined);
  return {
    programs: present(
      await Promise.all(
        [f.programA, f.programB].map((p) => stores.programContracts.get(p.projectId, p.programId)),
      ),
    ),
    runs: present(await Promise.all(scopes.map((scope) => stores.runs.get(scope, scope.runId)))),
    executionNodes: nodes,
    routingDecisions,
    measurements,
    feedback: present(await Promise.all(scopes.map((scope) => stores.feedback.get(scope)))),
    completionHistories: await readAll((p) =>
      stores.completionHistories.listByProject(f.run1.projectId, p),
    ),
    verifications: await byNode((scope, id) => stores.verifications.listByNode(scope, id)),
    examinations: await byNode((scope, id) => stores.examinations.listByNode(scope, id)),
  };
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 26-character identifier body that is a valid ULID and says nothing about when it was made. */
const placeholderUlid = (n: number): string => {
  let body = "";
  let rest = n;
  for (let digit = 0; digit < 16; digit += 1) {
    body = `${CROCKFORD[rest % 32]}${body}`;
    rest = Math.floor(rest / 32);
  }
  return `0000000000${body}`;
};

/** What a person could see change between two runs of the story is wall-clock time the machine measured. */
const MEASURED_BY_MACHINE = new Set(["durationMs", "quietMs"]);

const pinned = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(pinned);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      MEASURED_BY_MACHINE.has(key) ? 0 : pinned(inner),
    ]),
  );
};

const LINE_WIDTH = 100;

/** JSON as the repository's formatter lays it out, so a committed fixture is also a lint-clean one. */
const formatJson = (value: unknown, indent = 0, column = indent): string => {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const primitive = value.every((item) => typeof item !== "object" || item === null);
    const flat = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    if (primitive && column + flat.length + 1 <= LINE_WIDTH) return flat;
    return `[\n${value.map((item) => `${inner}${formatJson(item, indent + 2)}`).join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";
    const body = entries.map(([key, item]) => {
      const head = `${inner}${JSON.stringify(key)}: `;
      return `${head}${formatJson(item, indent + 2, head.length)}`;
    });
    return `{\n${body.join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
};

/**
 * The records as the fixture holds them: ids, commits and paths replaced by
 * placeholders in the order they first appear, and the durations the machine
 * measured set to zero. The placeholders keep the shape the contracts check.
 */
const fixtureText = async (f: Facts): Promise<string> => {
  let text = JSON.stringify(pinned(await recordsOf(f)));
  for (const root of new Set([f.world.root, await realpath(f.world.root)])) {
    text = text.split(root).join(FIXTURE_ROOT);
  }
  const ids = new Map<string, string>();
  text = text.replace(/\b([a-z]+)_([0-9A-HJKMNP-TV-Z]{26})\b/g, (whole, prefix: string) => {
    const known = ids.get(whole) ?? `${prefix}_${placeholderUlid(ids.size + 1)}`;
    ids.set(whole, known);
    return known;
  });
  const commits = new Map<string, string>();
  text = text.replace(/\b[0-9a-f]{40}\b/g, (sha) => {
    const known = commits.get(sha) ?? (commits.size + 1).toString(16).padStart(40, "0");
    commits.set(sha, known);
    return known;
  });
  return `${formatJson(JSON.parse(text))}\n`;
};

afterAll(async () => {
  await facts?.terminal.cleanup();
});

const FIXTURE_SCHEMAS = {
  programs: ProgramContractSchema,
  runs: RunSchema,
  executionNodes: ExecutionNodeSchema,
  routingDecisions: RoutingDecisionSchema,
  measurements: MeasurementSummarySchema,
  feedback: RunFeedbackSchema,
  completionHistories: CompletionHistorySchema,
  verifications: VerificationSchema,
  examinations: ExaminationSchema,
} as const;

const expectContractShapes = (records: Record<string, unknown[]>): void => {
  expect(Object.keys(records).sort()).toEqual(Object.keys(FIXTURE_SCHEMAS).sort());
  for (const [name, schema] of Object.entries(FIXTURE_SCHEMAS)) {
    for (const record of records[name] ?? []) {
      const parsed = schema.safeParse(record);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  }
};

// --- Reading the record ---------------------------------------------------------------------------------

const reportOf = (scope: RunScope) => gatherReport(facts.world.stores, scope);

/** The CLI's and the report's own spelling carries the moment of reading; the figures do not. */
const withoutAsOf = (text: string): string => text.replace(/\(as of \S+\)/g, "(as of <asOf>)");

const close = (actual: number | undefined, expected: number): void => {
  expect(actual).toBeCloseTo(expected, 9);
};

const nonZero = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));

const memberOf = (ref: { programId: string; runId: string }): string =>
  `${ref.programId}/${ref.runId}`;

/** What the story is known to have consumed, as literals. */
const RUN1 = { input: 73_000, output: 14_400, usd: 0.425 };
const FAILED = { input: 3_000, output: 600, usd: 0.018 };
const CORRECTION = { input: 4_000, output: 800, usd: 0.024 };
const HISTORY = { input: 80_000, output: 15_800, usd: 0.467 };

describe("the complete SC-12 history", () => {
  it("runs two jobs at once, and reworks the three that did not land first time", async () => {
    const { world, jobs, run1, peakWorkers } = facts;
    expect(peakWorkers).toBe(2);
    const report = await reportOf(run1);
    expect(report.operations.concurrency.peak).toBe(2);

    const attemptsOf = async (name: string) =>
      (await world.stores.routingDecisions.listByNode(run1, jobs[name]?.nodeId as ExecutionNodeId))
        .filter((route) => route.purpose === undefined)
        .sort((a, b) => a.attempt - b.attempt);
    const alpha = await attemptsOf("alpha");
    const beta = await attemptsOf("beta");
    const first = await attemptsOf("first");
    const second = await attemptsOf("second");
    expect([alpha, beta, first, second].map((attempts) => attempts.length)).toEqual([2, 2, 1, 2]);
    expect(alpha[0]?.outcome).toBe("verification_failed");
    expect(alpha[1]?.causes?.map((cause) => cause.kind)).toEqual(["verification_failed"]);
    expect(beta[1]?.causes?.map((cause) => cause.kind)).toEqual(["examination_findings"]);
    expect(second[1]?.causes).toEqual([{ kind: "integration_conflict", paths: ["src/shared.js"] }]);
    expect(first[0]?.causes).toBeUndefined();

    // Every job landed, and each is one work item however many attempts it took.
    for (const name of ["alpha", "beta", "first", "second"]) {
      const node = await world.stores.executionNodes.get(run1, jobs[name]?.nodeId as never);
      expect(node?.status, name).toBe("integrated");
    }
    expect(report.run.status).toBe("succeeded");

    // Delivery: 1 of 4 work items landed at its first attempt; the other three each reworked once.
    expect(report.delivery.workItems).toBe(4);
    expect(report.delivery.attempts).toBe(7);
    expect(report.delivery.firstAttempt).toMatchObject({
      succeeded: 1,
      denominator: 4,
      rate: 0.25,
    });
    expect(nonZero(report.delivery.outcomes.counts)).toEqual({ landed: 4 });
    expect(report.delivery.rework.attempts).toBe(3);
    expect(
      report.delivery.rework.byCause.map((row) => [row.kind, row.attempts, row.sharedAttempts]),
    ).toEqual([
      ["examination_findings", 1, 0],
      ["integration_conflict", 1, 0],
      ["verification_failed", 1, 0],
    ]);
    expect(report.operations.endings).toMatchObject({
      integrated: 4,
      integration_conflict: 1,
      verification_failed: 1,
    });

    // Examiner dispositions: one material finding, fixed by the clean second examination.
    const { review } = report;
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      severity: "material",
      latest: "fixed",
      linkage: "linked",
    });
    expect(review.dispositions.unique).toBe(1);
    expect(nonZero(review.dispositions.byLatest)).toEqual({ fixed: 1 });
    expect(review.coverage.examinations).toMatchObject({
      total: 2,
      byOutcome: { passed: 1, findings_raised: 1 },
    });
    expect(review.coverage).toMatchObject({ examinedNodes: 1, landedUnexamined: 3 });
    expect(review.overhead.examiner.calls).toBe(2);
    expect(review.repairs.attempts).toBe(1);
  });

  it("measures each attempt: tokens, the API-equivalent estimate and the price list it came from", async () => {
    const report = await reportOf(facts.run1);
    const [work, examine] = report.usage;
    expect(work).toMatchObject({
      harness: "fake",
      model: BUILDER_MODEL,
      purpose: "work",
      attempts: 7,
      inputTokens: 67_500,
      outputTokens: 13_500,
      unpriced: 0,
      estimated: true,
    });
    close(work?.costUsd, 0.405);
    expect(examine).toMatchObject({
      model: EXAMINER_MODEL,
      purpose: "examine",
      attempts: 2,
      inputTokens: 5_500,
      outputTokens: 900,
    });
    close(examine?.costUsd, 0.02);
    // The engine's root launch has no measurement summary here: its row is unmeasured (D-02), with no price list.
    for (const row of report.usage.filter((r) => r.purpose !== "root")) {
      expect(row.priceBases?.map((basis) => [basis.source, basis.version])).toEqual([
        [PRICE_SOURCE, PRICE_VERSION],
      ]);
    }
    // Run 1: 73,000 in and 14,400 out, and it is the sum of its nine attempts.
    expect(report.usage.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(RUN1.input);
    expect(report.usage.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(RUN1.output);
    close(report.budget?.usd, RUN1.usd);
    expect(report.budget?.tokens).toBe(RUN1.input + RUN1.output);

    // Each attempt's own figures, from the emitted usage and the price table.
    const rows = report.attempts ?? [];
    expect(rows).toHaveLength(9);
    const byAttempt = rows
      .filter((row) => row.purpose === "work")
      .map((row) => [facts.names.get(row.nodeId), row.attempt, row.resources.tokens.input]);
    expect(byAttempt.sort()).toEqual(
      [
        ["alpha", 1, 10_000],
        ["alpha", 2, 12_000],
        ["beta", 1, 20_000],
        ["beta", 2, 8_000],
        ["first", 1, 5_000],
        ["second", 1, 6_000],
        ["second", 2, 6_500],
      ].sort(),
    );
    expect(rows.every((row) => row.coverage === "complete")).toBe(true);

    // The two other runs are measured on their own.
    const failed = await reportOf(facts.failedRun);
    // Plus the run's root launch, which has no measurement summary: an unmeasured row (D-02).
    expect(failed.usage).toHaveLength(2);
    expect(failed.usage[0]).toMatchObject({ attempts: 1, inputTokens: 3_000, outputTokens: 600 });
    close(failed.budget?.usd, FAILED.usd);
    expect(nonZero(failed.delivery.outcomes.counts)).toEqual({ failed: 1 });
    const correction = await reportOf(facts.correctionRun);
    expect(correction.usage[0]).toMatchObject({
      attempts: 1,
      inputTokens: 4_000,
      outputTokens: 800,
    });
    close(correction.budget?.usd, CORRECTION.usd);
    expect(nonZero(correction.delivery.outcomes.counts)).toEqual({ landed: 1 });
  });

  it("separates elapsed time from the union of active intervals", async () => {
    const report = await reportOf(facts.run1);
    const { operations } = report;
    // The run's window is 12:00 to 12:30; the clock moved only where the story moved it.
    expect(operations.elapsedMs).toBe(1_800_000);
    // Two workers for 60s, two for 120s, one for 45s: summed 405s, counted once 225s.
    expect(operations.concurrency.summedWorkMs).toBe(405_000);
    expect(operations.unions.work).toBe(225_000);
    expect(operations.unions.integration).toBe(45_000);
    expect(operations.concurrency.averageOverElapsed).toBeCloseTo(0.225, 9);
    expect(operations.ambiguousMs).toBe(0);

    // The completion history: three runs over 4,200s of calendar, 3,000s of it with a run active.
    const [completion] = report.completions;
    expect(completion?.current).toMatchObject({
      leadTimeSeconds: 7_800,
      runCompletionSeconds: 4_200,
      activeSeconds: 3_000,
    });
    expect(completion?.current.acceptedRun).toEqual({
      programId: facts.correctionRun.programId,
      runId: facts.correctionRun.runId,
    });
  });

  it("keeps one effective verdict per run and the attributed history of each change", async () => {
    const { world, run1, failedRun, correctionRun, said } = facts;
    const user = (revision: { actor: { userId: string } }) => revision.actor.userId;
    const verdicts = await readAll((p) => world.stores.feedback.listByProgram(run1, p));
    expect(verdicts.map((record) => record.runId)).toEqual([run1.runId]);

    const own = await world.stores.feedback.get(run1);
    expect(own).toMatchObject({ version: 3, verdict: "did_not_work" });
    expect(own?.revisions.map((r) => [r.version, r.verdict, r.recordedAt])).toEqual([
      [1, "did_not_work", "2026-09-15T13:20:00.000Z"],
      [2, null, "2026-09-15T14:12:00.000Z"],
      [3, "did_not_work", "2026-09-15T14:15:00.000Z"],
    ]);
    const other = await world.stores.feedback.get(correctionRun);
    expect(other).toMatchObject({ version: 3, verdict: "worked" });
    expect(other?.revisions.map((r) => [r.version, r.verdict, r.recordedAt])).toEqual([
      [1, "worked", "2026-09-15T14:00:00.000Z"],
      [2, "did_not_work", "2026-09-15T14:05:00.000Z"],
      [3, "worked", "2026-09-15T14:10:00.000Z"],
    ]);
    // Every revision names who gave it, taken from the session and not from the request.
    for (const revision of [...(own?.revisions ?? []), ...(other?.revisions ?? [])]) {
      expect(user(revision)).toBe(SUBJECT);
      expect(revision.actor.orgId).toBe(own?.actor.orgId);
    }
    // The failed run was never rated: no record at all, which is neither a yes nor a no.
    expect(await world.stores.feedback.get(failedRun)).toBeUndefined();

    expect(said.correction?.map((line) => line.replace(/run_\w+/, "<run>"))).toEqual([
      "rated run <run> as worked (revision 1)",
      "rated run <run> as did not work (revision 2)",
      "rated run <run> as worked (revision 3)",
    ]);
    expect(said.run1?.map((line) => line.replace(/run_\w+/, "<run>"))).toEqual([
      "rated run <run> as did not work (revision 1)",
      "cleared the verdict on run <run>",
      "rated run <run> as did not work (revision 3)",
    ]);

    // Coverage: rated of eligible, positives and negatives; an unrated run is neither.
    const report = await reportOf(run1);
    expect(report.feedback).toMatchObject({
      verdict: "did_not_work",
      revisions: 3,
      by: SUBJECT,
      recordedAt: "2026-09-15T14:15:00.000Z",
      ratingDelaySeconds: 6_300,
    });
    expect(report.feedbackCoverage).toMatchObject({
      eligible: 2,
      rated: 1,
      positive: 0,
      negative: 1,
      positiveShare: 0,
      unrated: 1,
    });
    const [completion] = report.completions;
    expect(completion?.coverage).toMatchObject({
      eligible: 3,
      rated: 2,
      positive: 1,
      negative: 1,
      positiveShare: 0.5,
      unrated: 1,
    });
  });

  it("names each member's program and run, and what the correction corrects", async () => {
    const { world, run1, failedRun, correctionRun, programA, programB, historyId } = facts;
    const histories = await readAll((p) =>
      world.stores.completionHistories.listByProject(run1.projectId, p),
    );
    expect(histories).toHaveLength(1);
    const [history] = histories;
    expect(history).toMatchObject({
      completionHistoryId: historyId,
      title: "Ordered modules",
      version: 4,
      programId: run1.programId,
      runId: run1.runId,
    });
    expect(history?.members).toEqual([
      { programId: programA.programId, runId: run1.runId, role: "anchor" },
      { programId: programA.programId, runId: failedRun.runId, role: "contributing" },
      { programId: programB.programId, runId: correctionRun.runId, role: "correction" },
    ]);
    expect(
      history?.checkpoints.map((c) => [c.name, c.programId, c.runId, c.membershipVersion]),
    ).toEqual([["after-correction", programB.programId, correctionRun.runId, 4]]);
    expect(history?.checkpoints[0]?.feedbackVersion).toBe(3);
    expect(history?.checkpoints[0]?.verdictRecordedAt).toBe("2026-09-15T14:10:00.000Z");
    // Every revision of the membership is attributed.
    expect(history?.revisions.map((r) => [r.version, r.actor.userId])).toEqual([
      [1, SUBJECT],
      [2, SUBJECT],
      [3, SUBJECT],
      [4, SUBJECT],
    ]);

    // The correction names the decision it corrects, and who reversed it.
    const report = await reportOf(correctionRun);
    expect(programB.corrects).toHaveLength(1);
    expect(report.corrections).toHaveLength(1);
    const [correction] = report.corrections;
    expect(correction?.target).toMatchObject({
      programId: programA.programId,
      runId: run1.runId,
      decisionId: programB.corrects?.[0]?.decisionId,
    });
    expect(correction?.decision?.authority).toBe("agent");
    expect(correction?.reversal).toMatchObject({
      authority: "human",
      supersedesDecisionId: correction?.target.decisionId,
    });

    // The anchor's report names every member, correction included, by program and run.
    const anchor = await reportOf(run1);
    expect(anchor.completions[0]?.members.map((m) => [m.programId, m.runId, m.role])).toEqual([
      [programA.programId, run1.runId, "anchor"],
      [programA.programId, failedRun.runId, "contributing"],
      [programB.programId, correctionRun.runId, "correction"],
    ]);
  });

  it("counts every attempt once across the history, however the members overlap", async () => {
    const { world, run1, failedRun, correctionRun } = facts;
    const reports = [
      await reportOf(run1),
      await reportOf(failedRun),
      await reportOf(correctionRun),
    ];
    const rows = reports.flatMap((report) => report.attempts ?? []);
    // Eleven attempts, each under its own identity, in exactly one member.
    expect(rows).toHaveLength(11);
    expect(new Set(rows.map((row) => row.routingDecisionId)).size).toBe(11);
    expect(new Set(rows.map((row) => row.measurementSummaryId)).size).toBe(11);

    const tokens = (rowsOf: typeof rows, key: "input" | "output") =>
      rowsOf.reduce((sum, row) => sum + (row.resources.tokens[key] ?? 0), 0);
    expect(tokens(rows, "input")).toBe(HISTORY.input);
    expect(tokens(rows, "output")).toBe(HISTORY.output);
    expect(HISTORY.input).toBe(RUN1.input + FAILED.input + CORRECTION.input);
    expect(HISTORY.output).toBe(RUN1.output + FAILED.output + CORRECTION.output);

    // The history's own total is that sum, no more.
    const [completion] = reports[0]?.completions ?? [];
    expect(completion?.current.resources?.tokens).toMatchObject({ input: 80_000, output: 15_800 });
    close(completion?.current.resources?.usd.estimated, HISTORY.usd);
    expect(completion?.current.measuredMembers).toBe(3);
    expect(completion?.current.resources?.coverage).toEqual({
      complete: 11,
      partial: 0,
      unknown: 0,
      legacy: 0,
      // One unmeasured root launch per member run (D-02): the estimate is a lower bound.
      missing: 3,
    });

    // The same run named twice, or a member carried in twice, is read once.
    const stored = (
      await readAll((p) => world.stores.completionHistories.listByProject(run1.projectId, p))
    )[0];
    const members = [...(stored?.members ?? []), ...(stored?.members ?? [])];
    const runs = new Map(
      await Promise.all(
        (stored?.members ?? []).map(async (member) => {
          const run = await world.stores.runs.get(
            { projectId: run1.projectId, programId: member.programId },
            member.runId,
          );
          return [memberOf(member), run as Run] as const;
        }),
      ),
    );
    const gathered = await gatherMemberFigures(
      world.stores,
      run1.projectId,
      members,
      runs,
      facts.asOf,
    );
    expect(gathered.resources.size).toBe(3);
    expect(gathered.unavailable.size).toBe(0);
    const summed = [...gathered.resources.values()].reduce(
      (sum, resources) => sum + (resources.tokens.input ?? 0),
      0,
    );
    expect(summed).toBe(HISTORY.input);
    const report = completionOf({
      history: { ...(stored as CompletionHistory), members },
      runs,
      feedback: new Map(),
      resources: gathered.resources,
      asOf: facts.asOf,
    });
    expect(report.current.resources?.tokens.input).toBe(HISTORY.input);
    expect(report.current.measuredMembers).toBe(3);
  });

  it("creates no verification and moves no status when a run is rated, and refuses an execution principal", async () => {
    const { world, run1, historyId, untouched, refusals } = facts;
    expect(untouched.before.verifications).toBe(7);
    expect(untouched.before.examinations).toBe(2);
    // Everything rating could touch is the same after four verdict writes and a checkpoint.
    expect(untouched.after).toEqual(untouched.before);
    expect(untouched.after.run).toEqual({ status: "succeeded", outcomeReason: undefined });
    expect(untouched.after.nodes.map(([, status]) => status).sort()).toEqual([
      "integrated",
      "integrated",
      "integrated",
      "integrated",
      "running",
    ]);
    // A verdict names no verification and carries no result of its own.
    const verdict = await world.stores.feedback.get(run1);
    expect(Object.keys(verdict ?? {}).sort()).toEqual(
      [
        "actor",
        "programId",
        "projectId",
        "recordedAt",
        "revisions",
        "runId",
        "schemaVersion",
        "verdict",
        "version",
      ].sort(),
    );

    // A worker and an orchestrator are each refused both writes, with nothing changed.
    expect(refusals).toEqual([
      { who: "worker", what: "rate", status: 403 },
      { who: "worker", what: "membership", status: 403 },
      { who: "orchestrator", what: "rate", status: 403 },
      { who: "orchestrator", what: "membership", status: 403 },
    ]);
    expect(verdict).toMatchObject({ version: 3, verdict: "did_not_work" });
    const [history] = await readAll((p) =>
      world.stores.completionHistories.listByProject(run1.projectId, p),
    );
    expect(history).toMatchObject({ completionHistoryId: historyId, version: 4 });
    expect(history?.members).toHaveLength(3);

    // The same run named twice as a member is refused by the control plane, and nothing changes.
    expect(facts.duplicate.code).toBe(1);
  });

  it("reads the same history through the rendered report, the export and the CLI", async () => {
    const { terminal, run1, failedRun, correctionRun, historyId, programA, programB } = facts;
    const report = await reportOf(run1);
    const text = renderReport(report);
    const exported = exportReport(report);

    // The rendered report.
    for (const line of [
      "| fake | claude-sonnet-5 | work | 7 | 67500 | 13500 | 0.40* | none | 7: $0.40 | API-equivalent estimate; price list sc12-price-list 2026-10-01; 7 of 7 attempts valued |",
      "| fake | gpt-6-astra | examine | 2 | 5500 | 900 | 0.02* | none | 2: $0.02 | API-equivalent estimate; price list sc12-price-list 2026-10-01; 2 of 2 attempts valued |",
      "4 work item(s) and 0 repair job(s) in 0 strand(s); 7 attempt(s), 2 helper call(s).",
      "all jobs: 1/4 (25%), 0 unfinished",
      "**Rework:** 3 attempt(s), each counted once",
      "examination_findings: 1 attempt(s)",
      "integration_conflict: 1 attempt(s)",
      "verification_failed: 1 attempt(s)",
      "1 unique finding(s); latest fixed 1",
      "2 examination(s) (passed 1, findings_raised 1)",
      "examiner: 2 call(s); input 5500, output 900 tokens",
      "Elapsed 30m 00s",
      "Peak concurrency 2",
      "**summed work (overlapping; not elapsed):** 6m 45s",
      "work 3m 45s",
      "Verdict: **did not work**",
      "1 of 2 ended run(s) rated; 0 worked, 1 did not; positive share among rated 0%; 1 unrated.",
      "Coverage: 2 of 3 rated; 1 worked, 1 did not; positive share among rated 50%.",
      "Now: lead time 130 min 0 s; run completion 70 min 0 s; active union 50 min 0 s; tokens in 80000, out 15800; estimated: $0.47 for 11 of 14 attempts, reported: none (separate figures)",
      // The three unmeasured root launches keep the combined estimate a lower bound (D-02).
      "token coverage complete 11, partial 0, unknown 0, legacy 0, missing 3.",
      `${programB.programId}/${correctionRun.runId}: correction, succeeded, worked`,
      `${programA.programId}/${failedRun.runId}: contributing, failed, not_rated`,
      `${programA.programId}/${run1.runId}: anchor, succeeded, did_not_work`,
    ]) {
      expect(text, line).toContain(line);
    }

    // The versioned export, parsed through the contract.
    expect(ReportExportSchema.parse(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
    expect(
      exported.usage.map((row) => [
        row.model,
        row.purpose,
        row.attempts,
        row.inputTokens,
        row.outputTokens,
      ]),
    ).toEqual([
      [BUILDER_MODEL, "work", 7, 67_500, 13_500],
      [EXAMINER_MODEL, "examine", 2, 5_500, 900],
      // The root launch has no measurement summary: its own unmeasured row (D-02).
      ["unmeasured", "root", 1, undefined, undefined],
    ]);
    expect(exported.usage.map((row) => row.priceBases.map((b) => [b.source, b.version]))).toEqual([
      [[PRICE_SOURCE, PRICE_VERSION]],
      [[PRICE_SOURCE, PRICE_VERSION]],
      [],
    ]);
    close(exported.usage[0]?.costUsd, 0.405);
    close(exported.budget?.usd, RUN1.usd);
    expect(exported.operations).toMatchObject({
      elapsedMs: 1_800_000,
      unions: { work: 225_000, integration: 45_000 },
      concurrency: { peak: 2, summedWorkMs: 405_000 },
    });
    expect(exported.delivery.firstAttempt).toMatchObject({ succeeded: 1, denominator: 4 });
    // The export carries the delivery section as the report computed it.
    const delivery = exported.delivery as unknown as DeliveryReport;
    expect(delivery.rework.byCause.map((row) => [row.kind, row.attempts])).toEqual([
      ["examination_findings", 1],
      ["integration_conflict", 1],
      ["verification_failed", 1],
    ]);
    expect(exported.review.dispositions).toMatchObject({ unique: 1, byLatest: { fixed: 1 } });
    expect(exported.feedbackCoverage).toMatchObject({
      eligible: 2,
      rated: 1,
      positive: 0,
      negative: 1,
    });
    const [exportedHistory] = exported.completions;
    expect(exportedHistory?.coverage).toMatchObject({
      eligible: 3,
      rated: 2,
      positive: 1,
      negative: 1,
    });
    const current = exportedHistory?.current as CompletionFigures | undefined;
    expect(current).toMatchObject({
      leadTimeSeconds: 7_800,
      runCompletionSeconds: 4_200,
      activeSeconds: 3_000,
    });
    expect(current?.resources?.tokens).toMatchObject({
      input: 80_000,
      output: 15_800,
    });
    close(current?.resources?.usd.estimated, HISTORY.usd);
    expect(exportedHistory?.checkpoints[0]).toMatchObject({
      name: "after-correction",
      leadTimeSeconds: 7_800,
      activeSeconds: 3_000,
    });

    // `nightshift report --json`, through the CLI: the same text and the same export.
    const cli = await terminal.run("report", "alpha", "--run", run1.runId, "--json");
    expect(cli.code, cli.err.join("\n")).toBe(0);
    const directory = join(terminal.repo, "docs", "programs", "alpha");
    expect(withoutAsOf(await readFile(join(directory, "report.md"), "utf8"))).toBe(
      withoutAsOf(text),
    );
    const fromCli = ReportExportSchema.parse(
      JSON.parse(await readFile(join(directory, "report.json"), "utf8")),
    );
    expect({ ...fromCli, asOf: exported.asOf }).toEqual(exported);

    // The other two runs, through the CLI.
    const failedCli = await terminal.run("report", "alpha", "--run", failedRun.runId);
    expect(failedCli.code, failedCli.err.join("\n")).toBe(0);
    expect(await readFile(join(directory, "report.md"), "utf8")).toContain(
      "| fake | claude-sonnet-5 | work | 1 | 3000 | 600 | 0.02* |",
    );
    const correctionCli = await terminal.run("report", "beta");
    expect(correctionCli.code, correctionCli.err.join("\n")).toBe(0);
    expect(
      await readFile(join(terminal.repo, "docs", "programs", "beta", "report.md"), "utf8"),
    ).toContain("| fake | claude-sonnet-5 | work | 1 | 4000 | 800 | 0.02* |");

    // `nightshift completion show`.
    const shown = await terminal.run("completion", "show", "alpha", "--history", historyId);
    expect(shown.code, shown.err.join("\n")).toBe(0);
    const lines = shown.out;
    // Member lines carry their own figures after the verdict; this checks the identities.
    expect(lines.slice(0, 5).map((line) => line.replace(/, carried strands .*$/, ""))).toEqual([
      `completion history ${historyId} "Ordered modules" (version 4)`,
      `member ${memberOf(run1)} anchor succeeded did_not_work`,
      `member ${memberOf(failedRun)} contributing failed not_rated`,
      `member ${memberOf(correctionRun)} correction succeeded worked`,
      "rated 2 of 3 finished runs, positive share 50%",
    ]);
    const times = "lead time 2h 10m, run completion 1h 10m, active union 50m 0s, ";
    const spent =
      "tokens input 80000, output 15800, cache read none, cache write none, reasoning none, " +
      "estimated: $0.4670 for 11 of 14 attempts, reported: none";
    expect(lines[5]).toContain(`now: ${times}${spent}`);
    expect(lines[5]).toContain(
      "combined API-equivalent estimate lower bound $0.4670 (model $0.4670",
    );
    expect(lines[5]).toContain("3 members measured");
    // The live view then prints the history-wide delivery, rework, review and bottleneck lines.
    expect(lines.slice(6, 10).map((line) => line.split(":")[0])).toEqual([
      "  delivery",
      "  rework",
      "  review",
      "  bottlenecks, summed over member runs (not elapsed)",
    ]);
    expect(lines[10]).toContain("checkpoint `after-correction` (2026-09-15T14:20:00.000Z): ");
    expect(lines[10]).toContain(`${times}measured to 2026-09-15T14:10:00.000Z, ${spent}`);
    expect(lines.slice(11)).toEqual([
      `  snapshot member ${memberOf(run1)} anchor succeeded did_not_work`,
      `  snapshot member ${memberOf(failedRun)} contributing failed not_rated`,
      `  snapshot member ${memberOf(correctionRun)} correction succeeded worked`,
    ]);
  });

  it("reads history-wide delivery, rework, review and bottlenecks the same through the report, the export and the CLI", async () => {
    const { terminal, run1, historyId } = facts;
    const report = await reportOf(run1);
    const exported = exportReport(report);
    const shown = await terminal.run("completion", "show", "alpha", "--history", historyId);
    expect(shown.code, shown.err.join("\n")).toBe(0);

    const coverage = { withEvidence: 3, readable: 3, unavailable: [] };
    const [completion] = report.completions;
    expect(completion?.current).toMatchObject({
      evidenceCoverage: coverage,
      delivery: {
        workItems: 6,
        succeededFirstAttempt: 2,
        denominator: 6,
        unfinished: 0,
        cancelled: 0,
        reattemptedAcrossRuns: 0,
        carriedFromOutside: 0,
        excludingRepairs: { succeededFirstAttempt: 2, denominator: 6, unfinished: 0 },
        coverage,
      },
      rework: {
        attempts: 3,
        crossRunAttempts: 0,
        byCause: [
          { kind: "examination_findings", attempts: 1, crossRunAttempts: 0, sharedAttempts: 0 },
          { kind: "integration_conflict", attempts: 1, crossRunAttempts: 0, sharedAttempts: 0 },
          { kind: "verification_failed", attempts: 1, crossRunAttempts: 0, sharedAttempts: 0 },
        ],
        unknownCause: 0,
        coverage,
      },
      review: {
        dispositions: { upheld: 0, overturned: 0, risk_accepted: 0 },
        uniqueFindings: 1,
        overhead: { examiner: { calls: 2 }, answerer: { calls: 0 } },
        coverage,
      },
      operations: {
        summed: { wait: 0, queue: 0, integration: 45_000, examination: 0, summedWorkMs: 405_000 },
        coverage,
      },
    });
    expect(completion?.current.review?.overhead.examiner.resources.tokens).toMatchObject({
      input: 5_500,
      output: 900,
    });
    expect(
      completion?.current.operations?.members.map((m) => [m.elapsedMs, m.summedWorkMs]),
    ).toEqual([
      [1_800_000, 405_000],
      [1_200_000, 0],
      [600_000, 0],
    ]);
    // Each member links its own summary.
    expect(completion?.members.map((m) => m.summary)).toEqual([
      {
        firstAttempt: { succeeded: 1, of: 4 },
        reworkAttempts: 3,
        uniqueFindings: 1,
        elapsedMs: 1_800_000,
      },
      {
        firstAttempt: { succeeded: 0, of: 1 },
        reworkAttempts: 0,
        uniqueFindings: 0,
        elapsedMs: 1_200_000,
      },
      {
        firstAttempt: { succeeded: 1, of: 1 },
        reworkAttempts: 0,
        uniqueFindings: 0,
        elapsedMs: 600_000,
      },
    ]);

    // The export passes the blocks through unchanged.
    expect(exported.completions[0]?.current).toMatchObject({
      delivery: completion?.current.delivery,
      rework: completion?.current.rework,
      review: completion?.current.review,
      operations: completion?.current.operations,
      evidenceCoverage: coverage,
    });
    expect(exported.metricsBySection.completions).toEqual(
      expect.arrayContaining([
        "first_attempt_success",
        "rework_by_cause",
        "examiner_dispositions",
        "review_overhead",
        "summed_work_time",
      ]),
    );
    for (const id of exported.metricsBySection.completions ?? []) {
      expect(exported.definitions.map((d) => d.id)).toContain(id);
    }

    // The report and the CLI print the same four lines.
    const lines = [
      "delivery: first attempt succeeded 2 of 6 settled work items (0 unfinished, 0 cancelled), 0 re-attempted across runs; evidence from 3 of 3 members",
      "rework: 3 attempts — examination_findings 1, integration_conflict 1, verification_failed 1; 0 from later runs re-attempting; evidence from 3 of 3 members",
      "review: dispositions upheld 0, overturned 0, risk accepted 0; 1 unique finding; overhead examiner 2 calls, answerer 0, arbiter 0, plan review 0, tokens in 5500, out 900; evidence from 3 of 3 members",
      "bottlenecks, summed over member runs (not elapsed): waiting 0s, queue 0s, integration 45s, examination 0s; work 405s; evidence from 3 of 3 members",
    ];
    const text = renderReport(report);
    for (const line of lines) {
      expect(text).toContain(`- ${line}`);
      expect(shown.out).toContain(`  ${line}`);
    }
    expect(text).toContain(
      "Checkpoints freeze time and resources only; the delivery, rework, review and bottleneck lines above are the live view.",
    );
  });

  it("counts a work item attempted in several member runs once, and a carried strand once", async () => {
    const { world, run1, failedRun, correctionRun, programA, programB } = facts;
    const [stored] = await readAll((p) =>
      world.stores.completionHistories.listByProject(run1.projectId, p),
    );
    const history = stored as CompletionHistory;
    const runs = new Map(
      await Promise.all(
        history.members.map(async (member) => {
          const run = await world.stores.runs.get(
            { projectId: run1.projectId, programId: member.programId },
            member.runId,
          );
          return [memberOf(member), run as Run] as const;
        }),
      ),
    );
    const gathered = await gatherMemberFigures(
      world.stores,
      run1.projectId,
      history.members,
      runs,
      facts.asOf,
    );
    const key = (ref: { programId: string; runId: string }) => memberOf(ref);
    const A = programA.programId;
    const B = programB.programId;
    const item = (
      identity: string,
      firstAt: string,
      outcome: WorkItemEvidence["outcome"],
      failure?: string,
    ): WorkItemEvidence => ({
      identity,
      strandBearing: true,
      repair: false,
      nodeId: `${identity}@${firstAt}`,
      firstAt,
      attempts: 1,
      outcome,
      ...(failure === undefined ? {} : { failure }),
    });
    const evidence = (
      ref: { programId: string; runId: string },
      workItems: WorkItemEvidence[],
      carriedStrands: MemberEvidence["carriedStrands"] = [],
    ): [string, MemberEvidence] => [
      key(ref),
      { ...(gathered.evidence.get(key(ref)) as MemberEvidence), workItems, carriedStrands },
    ];
    const outside = "run_0000000000000000000000OUT1" as RunId;
    const report = completionOf({
      history,
      runs,
      feedback: new Map(),
      resources: gathered.resources,
      evidence: new Map([
        // Run 1 failed s1 and landed s0.
        evidence(run1, [
          item(`${A}/s1`, "2026-09-15T12:00:00.000Z", "verification_failed", "verification_failed"),
          item(`${A}/s0`, "2026-09-15T12:00:05.000Z", "landed"),
        ]),
        // The failed run carried s0 from run 1 (a member), re-attempted s1 and failed s2.
        evidence(
          failedRun,
          [
            item(`${A}/s0`, "2026-09-15T12:20:00.000Z", "landed"),
            item(`${A}/s1`, "2026-09-15T12:21:00.000Z", "landed"),
            item(`${A}/s2`, "2026-09-15T12:22:00.000Z", "failed", "integration_conflict"),
          ],
          [{ strandId: "s0", fromRunId: run1.runId, landed: [] }] as never,
        ),
        // The correction run, in program B, carried s9 from a run outside the history.
        evidence(correctionRun, [item(`${B}/s2`, "2026-09-15T13:00:00.000Z", "landed")], [
          { strandId: "s9", fromRunId: outside, landed: [] },
        ] as never),
      ]),
      asOf: facts.asOf,
    });
    // A member whose evidence is missing is named, never counted as zero.
    const partial = completionOf({
      history,
      runs,
      feedback: new Map(),
      evidence: new Map([...gathered.evidence].filter(([k]) => k !== key(correctionRun))),
      evidenceUnavailable: new Map([[key(correctionRun), "events: refused"]]),
      asOf: facts.asOf,
    });
    expect(partial.current.evidenceCoverage).toEqual({
      withEvidence: 2,
      readable: 3,
      unavailable: [key(correctionRun)],
      reasons: { [key(correctionRun)]: "events: refused" },
    });
    expect(partial.current.delivery?.coverage.withEvidence).toBe(2);
    expect(completionEvidenceLines(partial.current)[0]).toContain(
      `evidence from 2 of 3 members; no evidence for ${key(correctionRun)} (events: refused)`,
    );
    const none = completionOf({
      history,
      runs,
      feedback: new Map(),
      evidence: new Map(),
      asOf: facts.asOf,
    });
    expect(
      completionEvidenceLines(none.current).map((l) => l.split(":")[1]?.trim().slice(0, 12)),
    ).toEqual(["not observed", "not observed", "not observed", "not observed"]);
    const { delivery, rework } = report.current;
    // s1 once (its first attempt failed), s0 once (not again for the run that carried it), s2, and B's s2.
    expect(delivery).toMatchObject({
      workItems: 4,
      succeededFirstAttempt: 2,
      denominator: 4,
      unfinished: 0,
      reattemptedAcrossRuns: 1,
      carriedFromOutside: 1,
    });
    expect(rework?.attempts).toBe(4);
    expect(rework?.crossRunAttempts).toBe(1);
    expect(rework?.byCause.map((row) => [row.kind, row.attempts, row.crossRunAttempts])).toEqual([
      ["examination_findings", 1, 0],
      ["integration_conflict", 1, 0],
      ["verification_failed", 2, 1],
    ]);
  });

  it("keeps the committed fixture of the records it left", async () => {
    const text = await fixtureText(facts);
    const committed = await readFile(FIXTURE_PATH, "utf8").catch(() => undefined);
    if (process.env[MEASUREMENT_FIXTURES_ENV] === "write") {
      await mkdir(join(FIXTURE_PATH, ".."), { recursive: true });
      await writeFile(FIXTURE_PATH, text, "utf8");
    } else if (committed !== text) {
      throw new Error(
        `${FIXTURE_NAME} ${committed === undefined ? "is missing" : "no longer matches the records this story produces"}.\n` +
          `If the change is intended, regenerate it and commit the result:\n` +
          `  ${MEASUREMENT_FIXTURES_ENV}=write npx vitest run test/src/execution/sc12-history.test.ts`,
      );
    }
    expect(await readFile(FIXTURE_PATH, "utf8")).toBe(text);

    // Nothing in it belongs to a machine: no commit, no temporary path, no address.
    for (const forbidden of [facts.world.root, tmpdir(), "127.0.0.1", "localhost"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    const shas = text.match(/\b[0-9a-f]{40}\b/g) ?? [];
    expect(shas.length).toBeGreaterThan(0);
    expect(shas.every((sha) => /^0{30}[0-9a-f]{10}$/.test(sha))).toBe(true);

    // It loads through the contract schemas.
    const records = JSON.parse(text) as Record<string, unknown[]>;
    expectContractShapes(records);
    expect(
      Object.fromEntries(Object.entries(records).map(([name, items]) => [name, items.length])),
    ).toEqual({
      programs: 2,
      runs: 3,
      executionNodes: 9,
      routingDecisions: 11,
      measurements: 11,
      feedback: 2,
      completionHistories: 1,
      verifications: 8,
      examinations: 2,
    });
  });
});
