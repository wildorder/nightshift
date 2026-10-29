/**
 * The line's repair as an engine repair job (S-02, D-02, P15 D-P15-04), over the
 * fake harness, a real local git repository and the production control plane on
 * loopback: the composer's `repair` port records a decision, puts the line
 * branch at the request's base, delegates a high-risk repair and answers what
 * landed or the failed worker's words.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommitSha, LineRange } from "@nightshift/contracts";
import { ExaminationSchema, type RouteChoice } from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  createMergeQueue,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  failJob,
  git,
  type LineRepairRequest,
  nodeGitRunner,
  revParse,
} from "@nightshift/execution";
import type { HarnessExit, HarnessStartInput } from "@nightshift/harness";
import { createLineRepair, lineRepairBrief } from "@nightshift/mcp";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type ScriptContext } from "../execution/fake-harness.js";
import { cleanupWorlds, createWorld, PROGRAM_BRANCH, type World } from "../execution/world.js";

afterEach(cleanupWorlds);

const MATH = "src/math.js";
const RESOLVED = "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n// resolved\n";
const MARKED = [
  "<<<<<<< line",
  "export const sum = (xs) => xs.reduce((a, b) => a + b, 1);",
  "=======",
  "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);",
  ">>>>>>> range",
  "",
].join("\n");

const mcp = () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} });

const sha = (value: string): CommitSha => value as CommitSha;

type Work = (context: ScriptContext) => Promise<"done" | string>;

const run = (world: World, args: string[]) =>
  git(nodeGitRunner, args, { cwd: world.repo, atMs: Date.now() });

const WORKER = { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" };
const EXAMINER = { harness: "fake", provider: "openai", model: "gpt-6-astra" };
const choice = (target: typeof EXAMINER): RouteChoice => ({
  target,
  eligibleOptions: [{ target, eligible: true }],
  ruleId: "R-test",
  wasOverride: false,
});

/** The services a high-risk repair is examined with: an independent examiner that finds nothing. */
const services: ExaminationServices = {
  examinerRoute: () => choice(EXAMINER),
  strongestExaminerRoute: () => choice(EXAMINER),
  arbiterRoute: () => choice(WORKER),
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

const examine = async (world: World, input: HarnessStartInput): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
  const stores = createHttpStores({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });
  const examination = ExaminationSchema.parse({
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
  });
  await stores.examinations.put(examination);
  return { kind: "completed" };
};

const rig = async (work: Work) => {
  const objectives: string[] = [];
  let world: World | undefined;
  const made = await createWorld({
    harness: createFakeHarness({
      script: async (context) => {
        const w = world as World;
        if (context.input.agent.role === "examiner") return examine(w, context.input);
        objectives.push(context.input.job.objective);
        const outbox = createEventOutbox({
          events: w.stores.events,
          scope: context.identity.scope,
          clock: w.environment.clock,
          ids: w.ids,
          writerId: context.identity.agentId,
          initialDelayMs: 1,
        });
        const environment = { stores: w.stores, clock: w.environment.clock, git: w.git, outbox };
        const said = await work(context);
        if (said === "done") await completeJob(environment, context.identity, "resolved it");
        else await failJob(environment, context.identity, said);
        await outbox.flush();
        return said === "done" ? { kind: "completed" } : { kind: "failed", exitCode: 1 };
      },
    }),
    program: {
      scope: {
        includes: ["src/**", "test/**"],
        excludes: [],
        permissions: ["fs.read", "fs.write", "shell.exec"],
        forbiddenActions: [],
      },
    },
  });
  world = made;
  const environment = { ...made.environment, examination: services };
  const queue = createMergeQueue(environment);
  const engine = createEngine({
    environment,
    session: made.session,
    mcp,
    mergeQueue: queue,
  });
  const repair = createLineRepair({
    session: made.session,
    runtime: { stores: made.stores, ids: made.ids, clock: made.clock },
    engine,
    outbox: made.outbox,
    checkout: made.repo,
    branch: PROGRAM_BRANCH,
    git: nodeGitRunner,
    pollMs: 20,
  });
  return { world: made, repair, objectives };
};

/** A commit on a side branch that carries conflict markers, parented on the line head. */
const markedCandidate = async (world: World) => {
  const lineHead = await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH);
  await run(world, ["checkout", "-b", "candidate"]);
  await writeFile(join(world.repo, MATH), MARKED, "utf8");
  await run(world, ["commit", "-am", "range merged with conflict markers"]);
  const base = await revParse(nodeGitRunner, world.repo, "candidate");
  await run(world, ["checkout", PROGRAM_BRANCH]);
  return { lineHead, base };
};

const range = (upTo: string, from?: string): LineRange => ({
  program: "prog_01M630Z55MEYV0ZDBV3JS7DN82" as LineRange["program"],
  ...(from === undefined ? {} : { from: sha(from) }),
  upTo: sha(upTo),
});

const request = (
  lineHead: CommitSha,
  base: CommitSha,
  extra: Partial<LineRepairRequest> = {},
): LineRepairRequest => ({
  cause: "line_conflict",
  range: range("b".repeat(40), "a".repeat(40)),
  base,
  lineHead,
  paths: [MATH],
  held: [range("c".repeat(40))],
  checks: [],
  landedSince: [range("d".repeat(40))],
  recentRepairs: [
    {
      range: range("e".repeat(40)),
      cause: "line_red",
      outcome: "failed",
      words: "could not make the lint step pass",
    },
  ],
  attempt: 2,
  ...extra,
});

describe("the line's repair job", () => {
  it("lands a conflict repair on the line branch above its base, with a recorded decision and a high-risk repair contract", async () => {
    const { world, repair, objectives } = await rig(async ({ worktree }) => {
      await writeFile(join(worktree, MATH), RESOLVED, "utf8");
      return "done";
    });
    const { lineHead, base } = await markedCandidate(world);

    const outcome = await repair(request(lineHead, base));

    expect(outcome.kind).toBe("repaired");
    if (outcome.kind !== "repaired") return;
    const head = await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH);
    expect(outcome.commit).toBe(head);
    expect(outcome.commit).not.toBe(base);
    await git(nodeGitRunner, ["merge-base", "--is-ancestor", base, outcome.commit], {
      cwd: world.repo,
    });
    expect(await readFile(join(world.repo, MATH), "utf8")).not.toContain("<<<<<<<");

    const jobs = (await world.stores.jobContracts.listByRun(world.scope)).items;
    const job = jobs.find((candidate) => candidate.jobContractId === outcome.repair.jobContractId);
    expect(outcome.repair.runId).toBe(world.scope.runId);
    expect(job?.risk).toBe("high");
    expect(job?.repair?.cause).toBe("line_conflict");
    expect(job?.repair?.gates).toEqual([MATH]);

    const decisions = (await world.stores.decisions.listByRun(world.scope)).items;
    const decision = decisions.find(
      (candidate) => candidate.decisionId === job?.repair?.decisionId,
    );
    expect(decision?.agentId).toBe(world.session.orchestratorAgentId);
    expect(decision?.executionNodeId).toBe(world.session.rootNodeId);

    // The brief carried the line head, held ranges, paths, what landed since and recent repairs.
    const objective = objectives[0] ?? "";
    expect(objective).toContain(lineHead);
    expect(objective).toContain(base);
    expect(objective).toContain("attempt 2 of 3");
    expect(objective).toContain(MATH);
    expect(objective).toContain("conflict markers");
    expect(objective).toContain(`${"c".repeat(12)}`);
    expect(objective).toContain(`${"d".repeat(12)}`);
    expect(objective).toContain("could not make the lint step pass");
    expect(objective).toContain("REPAIR (line_conflict)");
  });

  it("answers a failed repair with the worker's own words and leaves the line branch at the base", async () => {
    const { world, repair } = await rig(async () => "I could not reconcile the two sums");
    const { lineHead, base } = await markedCandidate(world);

    const outcome = await repair(request(lineHead, base));

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.words).toContain("I could not reconcile the two sums");
    expect(outcome.repair?.runId).toBe(world.scope.runId);
    expect(await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH)).toBe(base);
  });

  it("refuses to start in a dirty checkout", async () => {
    const { world, repair } = await rig(async () => "done");
    const { lineHead, base } = await markedCandidate(world);
    await writeFile(join(world.repo, "src/index.js"), "// dirty\n", "utf8");
    await expect(repair(request(lineHead, base))).rejects.toThrow(/not clean/);
  });
});

describe("the repair brief", () => {
  it("says what a red composition is and carries the failing checks' output", () => {
    const brief = lineRepairBrief(
      request(sha("1".repeat(40)), sha("2".repeat(40)), {
        cause: "line_red",
        checks: [
          { stepId: "test", command: "npm test", exitCode: 1, tail: "AssertionError: 3 !== 4" },
          { stepId: "lint", command: "npm run lint", exitCode: 0, tail: "all clean" },
        ],
      }),
    );
    expect(brief).toContain("red composition");
    expect(brief).toContain("without weakening a gate");
    expect(brief).toContain("npm test");
    expect(brief).toContain("AssertionError: 3 !== 4");
    expect(brief).not.toContain("all clean");
    expect(brief).toContain("1".repeat(40));
  });
});
