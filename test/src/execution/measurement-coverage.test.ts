/**
 * Cross-package measurement coverage (P20 S-04, criterion 6): the cases the
 * per-role suites leave open, driven through the real execution rigs and read
 * back through the report, its export and `nightshift report --json`.
 *
 * - an arbiter's summary, its review-overhead row and its export row;
 * - legacy records (a routing decision with only the old aggregate usage);
 * - a context-tier boundary: a tier is selected by one request's own input;
 * - a cancelled run and an interrupted attempt, whose coverage gap is printed
 *   and never turned into a zero figure.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@nightshift/cli";
import {
  type Decision,
  type Examination,
  type ExecutionNodeId,
  JobContractSchema,
  type MeasurementSummary,
  type ModelPrice,
  type ProgramContract,
  type ReportExport,
  ReportExportSchema,
  type RouteChoice,
  type RouteTarget,
  RoutingDecisionSchema,
} from "@nightshift/contracts";
import {
  createFixtures,
  exportReport,
  gatherReport,
  isSettled,
  makeAgent,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nowIso,
  renderReport,
} from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  type ExaminationServices,
  type ExecutionEnvironment,
  RULING_CONTEXT_ENV,
  type RulingContext,
} from "@nightshift/execution";
import type { HarnessExit, HarnessStartInput } from "@nightshift/harness";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, signIn } from "../cli/operator.js";
import { writeConfigFor } from "../cli/plan-scratch.js";
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

let counter = 0;
/** A harness-sourced observation, as an adapter reports it through `input.measurements`. */
const observation = (kind: "request" | "snapshot", fields: Record<string, unknown>) => {
  counter += 1;
  return {
    schemaVersion: 1 as const,
    observationId: `cov-${counter}`,
    source: "harness" as const,
    provenance: { adapter: "fake" },
    inclusion: "self" as const,
    kind: kind === "request" ? ("request" as const) : ("cumulative_snapshot" as const),
    ...fields,
  } as never;
};

const mcp = () => ({
  name: "nightshift",
  command: process.execPath,
  args: ["--version"],
  env: {},
});

const helperStores = (world: World, input: HarnessStartInput) =>
  createHttpStores({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });

const waitUntil = async (what: string, done: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const settledNode = async (
  world: World,
  engine: ReturnType<typeof createEngine>,
  nodeId: ExecutionNodeId,
): Promise<string> => {
  let status = "missing";
  await waitUntil(`node ${nodeId} to settle`, async () => {
    status = (await world.stores.executionNodes.get(world.scope, nodeId))?.status ?? "missing";
    return isSettled(status as never) && engine.idle();
  });
  return status;
};

const jobOf = (world: World, risk: "low" | "high" | "medium" = "low") =>
  JobContractSchema.parse({
    schemaVersion: 1,
    ...world.scope,
    jobContractId: world.ids.next("job"),
    objective: "covered",
    acceptance: ["It works."],
    dependencies: [],
    risk,
    ambiguity: "low",
    createdAt: nowIso(world.environment.clock),
  });

/** The report, its markdown and its export, read from the world's stores. */
const reported = async (world: World) => {
  const report = await gatherReport(world.stores, world.scope);
  return {
    report,
    markdown: renderReport(report),
    exported: exportReport(report),
  };
};

// ---------------------------------------------------------------------------
// (a) The arbiter
// ---------------------------------------------------------------------------

describe("an arbiter launch that reports usage", () => {
  const ARBITER_IN = 4_000;
  const ARBITER_OUT = 250;

  const play =
    (world: () => World) =>
    async (context: ScriptContext): Promise<HarnessExit> => {
      const { input } = context;
      const w = world();
      switch (input.agent.role) {
        case "examiner": {
          const examination = JSON.parse(
            input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}",
          ) as ExaminationContext;
          const earlier = [
            ...(await w.stores.examinations.listByNode(w.scope, input.node.executionNodeId)),
          ]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .at(-1);
          const earlierFinding = earlier?.findings.find((f) => f.severity === "material");
          await helperStores(w, input).examinations.put({
            schemaVersion: 1,
            projectId: input.node.projectId,
            programId: input.node.programId,
            runId: input.node.runId,
            examinationId: examination.examinationId,
            executionNodeId: input.node.executionNodeId,
            verificationId: examination.verificationId,
            commitSha: examination.commitSha,
            patchId: examination.patchId,
            implementerAgentId: examination.implementerAgentId,
            examinerAgentId: input.agent.agentId,
            examinerRoute: examination.examinerRoute,
            requiredByRisk: examination.requiredByRisk,
            blocking: examination.blocking,
            fixAttempt: examination.fixAttempt,
            questions: examination.questions,
            outcome: "findings_raised",
            findings: [
              {
                id: "F-01",
                severity: "material",
                summary: "the contract is not met",
                evidence: [{ kind: "contract", clause: "It works." }],
                resolution: "unresolved",
                ...(earlier === undefined || earlierFinding === undefined
                  ? {}
                  : {
                      repeats: {
                        examinationId: earlier.examinationId,
                        findingId: "F-01",
                      },
                    }),
              },
            ],
            createdAt: nowIso(w.environment.clock),
          } as Examination);
          return { kind: "completed", sessionId: "examiner-session" };
        }
        case "arbiter": {
          const ruling = JSON.parse(input.mcp?.env[RULING_CONTEXT_ENV] ?? "{}") as RulingContext;
          input.measurements?.observe(
            observation("request", {
              model: ARBITER.model,
              counters: { inputTokens: ARBITER_IN, outputTokens: ARBITER_OUT },
            }),
          );
          const decision: Decision = {
            schemaVersion: 1,
            projectId: input.node.projectId,
            programId: input.node.programId,
            runId: input.node.runId,
            decisionId: w.ids.next("dec"),
            executionNodeId: input.node.executionNodeId,
            agentId: input.agent.agentId,
            context: `ruling on ${ruling.findingId}`,
            alternatives: [{ summary: "uphold" }],
            choice: "overturn",
            rationale: "on the evidence",
            reversibility: "reversible",
            checkpointBefore: ruling.checkpointBefore,
            affectedNodes: [input.node.executionNodeId],
            authority: "agent",
            supersedesDecisionId: null,
            createdAt: nowIso(w.environment.clock),
          };
          await helperStores(w, input).decisions.put(decision);
          return { kind: "completed" };
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
          const attempt = Date.now();
          await writeFile(
            join(context.worktree, "src", "arbitrated.js"),
            `export const a = ${attempt};\n`,
          );
          await completeJob(
            {
              stores: w.stores,
              clock: w.environment.clock,
              git: w.git,
              outbox,
            },
            context.identity,
            "arbitrated: done",
          );
          await outbox.flush();
          return { kind: "completed", sessionId: "builder-session" };
        }
      }
    };

  const arbitrated = async () => {
    let world: World | undefined;
    const made = await createWorld({
      harness: createFakeHarness({ script: play(() => world as World) }),
    });
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
      mcp,
      route: () => choice(BUILDER),
    });
    const job = jobOf(made, "medium");
    const submitted = await engine.submit({
      job,
      depth: 1,
      parentNodeId: made.session.rootNodeId,
      route: choice(BUILDER),
    });
    const nodeId = submitted.nodeId as ExecutionNodeId;
    const examined = async (count: number) =>
      waitUntil(`${count} examination(s)`, async () => {
        const all = await made.stores.examinations.listByNode(made.scope, nodeId);
        const status = (await made.stores.executionNodes.get(made.scope, nodeId))?.status;
        return (
          all.length >= count && status !== undefined && isSettled(status as never) && engine.idle()
        );
      });
    // A finding repeated across two fix rounds goes to the arbiter at the third examination.
    await examined(1);
    expect(await engine.retry(job.jobContractId)).toBe(true);
    await examined(2);
    expect(await engine.retry(job.jobContractId)).toBe(true);
    await waitUntil("integration", async () => {
      const node = await made.stores.executionNodes.get(made.scope, nodeId);
      return node?.status === "integrated" && engine.idle();
    });
    return { world: made, engine, nodeId };
  };

  it("has a summary of role arbiter, a review-overhead row with its calls and tokens, and an export row", async () => {
    const { world, engine, nodeId } = await arbitrated();
    const summaries = await world.environment.stores.measurements.listByNode(world.scope, nodeId);
    const arbiters = summaries.filter((summary) => summary.role === "arbiter");
    expect(arbiters).toHaveLength(1);
    const [summary] = arbiters;
    expect(summary?.route.model).toBe(ARBITER.model);
    expect(summary?.totals).toMatchObject({
      inputTokens: 4_000,
      outputTokens: 250,
    });

    const routes = await world.stores.routingDecisions.listByNode(world.scope, nodeId);
    const arbitration = routes.find((route) => route.purpose === "arbitrate");
    expect(summary?.routingDecisionId).toBe(arbitration?.routingDecisionId);

    const { report, markdown, exported } = await reported(world);
    const overhead = report.review.overhead.arbiter;
    expect(overhead.calls).toBe(1);
    expect(overhead.resources.tokens).toMatchObject({
      input: 4_000,
      output: 250,
    });
    expect(markdown).toContain("  - arbiter: 1 call(s); input 4000, output 250 tokens");

    const row = exported.attempts.find((attempt) => attempt.purpose === "arbitrate");
    expect(row).toMatchObject({
      model: ARBITER.model,
      measurementSummaryId: summary?.measurementSummaryId,
      resources: { tokens: { input: 4_000, output: 250 } },
    });
    expect(ReportExportSchema.parse(JSON.parse(JSON.stringify(exported)))).toBeDefined();
    await engine.close("test over");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// (b) Legacy records, through `nightshift report --json`
// ---------------------------------------------------------------------------

describe("a run recorded before request-level capture", () => {
  let op: Operator;
  let repo: string;

  beforeEach(async () => {
    op = await signIn();
    repo = await mkdtemp(join(tmpdir(), "nightshift-coverage-"));
  });
  afterEach(async () => {
    await op.cleanup();
    await rm(repo, { recursive: true, force: true });
  });

  const seed = async () => {
    const stores = createHttpStores({
      transport: createFetchTransport({
        endpoint: op.plane.url,
        tokens: staticTokenProvider("unused"),
      }),
    });
    const f = createFixtures();
    await stores.projects.put(makeProject(f, { orgId: op.orgId, name: "legacy" }));
    const program: ProgramContract = makeProgramContract(f, {
      repository: {
        url: "https://example.invalid/repo.git",
        baseBranch: "main",
        programBranch: "program/legacy",
      },
    });
    await stores.programContracts.put(program);
    const at = "2026-09-15T10:00:00.000Z";
    await stores.runs.put(
      makeRun(f, {
        status: "succeeded",
        startedAt: at,
        endedAt: "2026-09-15T11:00:00.000Z",
      }),
    );
    const root = makeRootNode(f);
    const job = makeNode(f, root.executionNodeId);
    await stores.executionNodes.put(root);
    await stores.executionNodes.put(job);
    await stores.agents.put(
      makeAgent(f, job.executionNodeId, {
        harness: "claude",
        model: "m1",
      }),
    );
    // Only the old aggregate: no measurement summary, no request detail, no dollars.
    await stores.routingDecisions.put(
      RoutingDecisionSchema.parse({
        schemaVersion: 1,
        ...f.scope,
        routingDecisionId: f.ids.next("route"),
        executionNodeId: job.executionNodeId,
        attempt: 1,
        role: "implementer",
        eligibleOptions: [
          {
            target: { harness: "claude", provider: "anthropic", model: "m1" },
            eligible: true,
          },
        ],
        chosen: { harness: "claude", provider: "anthropic", model: "m1" },
        ruleId: "r",
        wasOverride: false,
        usage: { inputTokens: 1200, outputTokens: 300 },
        outcome: "verified",
        previousRouteId: null,
        createdAt: at,
      }),
    );
    await writeConfigFor(repo, program);
    await mkdir(join(repo, "docs", "programs", "legacy"), { recursive: true });
    await writeFile(
      join(repo, "docs", "programs", "legacy", "contract.json"),
      JSON.stringify(program),
    );
    await writeFile(join(repo, "docs", "programs", "legacy", "plan.md"), "# legacy\n");
  };

  it("reports legacy coverage, tokens, no invented detail and no dollars, in the report, the export and the CLI", async () => {
    await seed();
    op.out.length = 0;
    op.err.length = 0;
    expect(
      await runCli(op.environment, ["report", "legacy", "--json", "--repo", repo]),
      op.err.join("\n"),
    ).toBe(0);

    const directory = join(repo, "docs", "programs", "legacy");
    const markdown = await readFile(join(directory, "report.md"), "utf8");
    const exported: ReportExport = ReportExportSchema.parse(
      JSON.parse(await readFile(join(directory, "report.json"), "utf8")),
    );

    const [attempt, ...rest] = exported.attempts;
    expect(rest).toEqual([]);
    expect(attempt).toMatchObject({
      purpose: "work",
      coverage: "legacy",
      ledgerArtifactIds: [],
      resources: { tokens: { input: 1200, output: 300 } },
    });
    // Nothing was observed per request or per dollar, and none is invented.
    expect(attempt?.measurementSummaryId).toBeUndefined();
    expect(attempt?.valuation).toBeUndefined();
    expect(attempt?.observedModels).toEqual([]);
    // Provenance is uncertain (the input convention is unknown) and no dollar figure was carried.
    expect(attempt?.resources).toMatchObject({
      tokens: { inputConventionUnknown: 1 },
      unpriced: 1,
      reportedAttempts: 0,
      estimatedAttempts: 0,
      priceBases: [],
    });
    expect(exported.usage[0]).not.toHaveProperty("costUsd");

    expect(markdown).toContain("legacy 1");
    expect(markdown).toContain("| claude | m1 | work | 1 | 1200 | 300 | unknown | none | none |");
    expect(markdown).toContain("| 0 | none |");
    expect(markdown).not.toContain("$0.00");
    expect(markdown).toContain("reported not observed");
    expect(markdown).toContain("estimated not observed");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The launch rig: one worker, scripted
// ---------------------------------------------------------------------------

type Script = (context: ScriptContext) => Promise<HarnessExit>;

const launchRig = async (
  script: Script,
  options: { prices?: Readonly<Record<string, ModelPrice>> } = {},
) => {
  const made = await createWorld({ harness: createFakeHarness({ script }) });
  const policy = made.session.run?.policy;
  const session =
    options.prices === undefined || policy === undefined || made.session.run === undefined
      ? made.session
      : {
          ...made.session,
          run: {
            ...made.session.run,
            policy: {
              ...policy,
              routingPolicy: {
                ...policy.routingPolicy,
                prices: options.prices,
              },
            },
          },
        };
  const engine = createEngine({ environment: made.environment, session, mcp });
  const job = jobOf(made);
  const submitted = await engine.submit({
    job,
    depth: 1,
    parentNodeId: made.session.rootNodeId,
    route: choice(BUILDER),
  });
  const nodeId = submitted.nodeId as ExecutionNodeId;
  return { world: made, engine, job, nodeId };
};

const summariesOf = (
  world: World,
  nodeId: ExecutionNodeId,
): Promise<readonly MeasurementSummary[]> =>
  world.environment.stores.measurements.listByNode(world.scope, nodeId);

// ---------------------------------------------------------------------------
// (c) Context-tier boundary
// ---------------------------------------------------------------------------

describe("a context-tier boundary", () => {
  const MODEL = BUILDER.model;
  const PRICES = {
    [MODEL]: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      source: "anthropic-list",
      version: "2026-10-01",
      tiers: [{ aboveInputTokens: 200_000, inputPerMTok: 6, outputPerMTok: 22.5 }],
    },
  } as unknown as Readonly<Record<string, ModelPrice>>;

  const attemptWith = async (requests: readonly [number, number][]) => {
    const r = await launchRig(
      async (context) => {
        for (const [inputTokens, outputTokens] of requests) {
          context.input.measurements?.observe(
            observation("request", {
              model: MODEL,
              counters: {
                inputTokens,
                outputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputIncludesCache: false,
              },
            }),
          );
        }
        return { kind: "failed", exitCode: 1 };
      },
      { prices: PRICES },
    );
    expect(await settledNode(r.world, r.engine, r.nodeId)).toBe("failed");
    const { exported } = await reported(r.world);
    await r.engine.close("test over");
    const row = exported.attempts.find((attempt) => attempt.purpose === "work");
    return row;
  };

  it("prices each request at its own tier, and a single 400k aggregate would price differently", async () => {
    // 100k in the base tier, 300k above the 200k boundary: each request selects its own tier.
    //   100,000 in × $3/MTok  = 0.30      1,000 out × $15/MTok   = 0.015
    //   300,000 in × $6/MTok  = 1.80      2,000 out × $22.5/MTok = 0.045
    const two = await attemptWith([
      [100_000, 1_000],
      [300_000, 2_000],
    ]);
    const estimated = two?.resources.usd as { estimated?: number } | undefined;
    expect(estimated?.estimated).toBeCloseTo(2.16, 10);
    expect(two?.valuation?.components.map((c) => [c.category, c.tier, c.tokens, c.usd])).toEqual(
      expect.arrayContaining([
        ["input", 0, 100_000, 0.3],
        ["input", 1, 300_000, 1.8],
      ]),
    );
    expect(two?.valuation?.remainder.valued).toBe(true);

    // The same 400k in / 3k out as one request lands in the upper tier:
    //   400,000 × $6/MTok = 2.40, 3,000 × $22.5/MTok = 0.0675 → 2.4675.
    const one = await attemptWith([[400_000, 3_000]]);
    const aggregate = (one?.resources.usd as { estimated?: number } | undefined)?.estimated;
    expect(aggregate).toBeCloseTo(2.4675, 10);
    expect(aggregate).not.toBeCloseTo(estimated?.estimated ?? 0, 3);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// (d) Cancelled and interrupted attempts: a gap is printed, never a zero
// ---------------------------------------------------------------------------

describe("attempts that stopped without reporting usage", () => {
  const stopped = async (
    how: "cancelled" | "interrupted",
  ): Promise<{
    summary: MeasurementSummary | undefined;
    markdown: string;
    exported: ReportExport;
  }> => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const r = await launchRig(async (context) => {
      // The first launch ends without finishing and reports no session; the engine resumes it.
      if (context.input.resume === undefined) return { kind: "completed", sessionId: "s1" };
      context.input.measurements?.observe(
        observation("snapshot", {
          counters: { inputTokens: 150 },
          counterScope: "session",
          sessionId: "s1",
        }),
      );
      started();
      if (how === "interrupted") return { kind: "interrupted", signal: "SIGKILL" };
      await context.cancelled;
      return { kind: "cancelled" };
    });
    await running;
    if (how === "cancelled") expect(await r.engine.cancel(r.job.jobContractId)).toBe(true);
    await settledNode(r.world, r.engine, r.nodeId);
    const [summary] = await summariesOf(r.world, r.nodeId);
    const { markdown, exported } = await reported(r.world);
    await r.engine.close("test over");
    return { summary, markdown, exported };
  };

  for (const how of ["cancelled", "interrupted"] as const) {
    it(`prints the coverage gap of a ${how} attempt and no zero figure`, async () => {
      const { summary, markdown, exported } = await stopped(how);
      // The resumed session reported 150 cumulative tokens against an unknown baseline: no total is claimed.
      expect(summary?.coverage).toBe("unknown");
      expect(summary?.gaps.map((gap) => gap.reason)).toEqual(["baseline_unknown"]);
      expect(summary?.totals.inputTokens).toBeUndefined();

      const row = exported.attempts.find((attempt) => attempt.purpose === "work");
      expect(row?.coverage).toBe(summary?.coverage);
      expect(row?.resources.tokens).not.toHaveProperty("input");
      expect(row?.resources.tokens).not.toHaveProperty("output");
      // The totals' dollar fields are sums over valued attempts; this one is counted unpriced, not free.
      expect(row?.resources).toMatchObject({ unpriced: 1 });

      expect(markdown).toContain("(partial coverage: unknown 1)");
      expect(markdown).toContain("input not observed, output not observed tokens");
      expect(markdown).toContain(
        "| fake | claude-sonnet-5 | work | 1 | not observed | not observed | unknown |",
      );
      expect(markdown).not.toContain("$0.00");
      expect(markdown).not.toMatch(/input 0,|output 0 tokens|\| 0 \| 0 \|/);
    }, 120_000);
  }
});
