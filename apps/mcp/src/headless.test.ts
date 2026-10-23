import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXAMINATION_POLICY, DEFAULT_ROUTING_POLICY } from "@nightshift/contracts";
import {
  createFixtures,
  createUlidIdGenerator,
  type Fixtures,
  makeAgent,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
  systemClock,
} from "@nightshift/core";
import { nodeGitRunner } from "@nightshift/execution";
import type { Harness, HarnessExit, HarnessStartInput } from "@nightshift/harness";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "./compose.js";
import {
  type HeadlessInput,
  interruptOrphans,
  launchRoot,
  type RootLaunch,
  recoveryNote,
  remoteEnvironmentNote,
  replacingLimitedRoots,
  rootLaunch,
} from "./headless.js";

describe("resuming a run on a replacement machine (P10, T6)", () => {
  it("interrupts what the lost machine had in flight, its agents and the old root's, and leaves settled work alone", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores();
    await stores.runs.put(makeRun(f, { status: "running" }));
    const root = makeRootNode(f, { status: "running" });
    await stores.executionNodes.put(root);
    const running = makeNode(f, root.executionNodeId, { status: "running" });
    const verifying = makeNode(f, root.executionNodeId, { status: "verifying" });
    const queued = makeNode(f, root.executionNodeId, { status: "queued" });
    const integrated = makeNode(f, root.executionNodeId, { status: "integrated" });
    const implemented = makeNode(f, root.executionNodeId, { status: "implemented" });
    const verified = makeNode(f, root.executionNodeId, { status: "verified" });
    const examining = makeNode(f, root.executionNodeId, { status: "examining" });
    const sealed = makeNode(f, root.executionNodeId, { status: "sealed" });
    const subprogram = makeNode(f, root.executionNodeId, {
      kind: "sub-program",
      status: "running",
    });
    const preserved = [verifying, queued, implemented, verified, examining, sealed];
    for (const node of [running, integrated, subprogram, ...preserved])
      await stores.executionNodes.put(node);
    const worker = makeAgent(f, running.executionNodeId, { status: "started" });
    const done = makeAgent(f, integrated.executionNodeId, { status: "completed" });
    const oldRoot = makeAgent(f, root.executionNodeId, { role: "orchestrator", status: "started" });
    const examiner = makeAgent(f, examining.executionNodeId, {
      role: "examiner",
      status: "started",
    });
    for (const agent of [worker, done, oldRoot, examiner]) await stores.agents.put(agent);

    const orphans = await interruptOrphans(stores, f.scope, "2026-10-04T03:00:00.000Z", 2);

    expect([...orphans.interrupted].sort()).toEqual(
      [running.executionNodeId, subprogram.executionNodeId].sort(),
    );
    expect([...orphans.preserved].sort()).toEqual(
      preserved.map((node) => node.executionNodeId).sort(),
    );
    for (const node of preserved) {
      expect(await stores.executionNodes.get(f.scope, node.executionNodeId)).toEqual(node);
    }
    expect((await stores.executionNodes.get(f.scope, running.executionNodeId))?.status).toBe(
      "interrupted",
    );
    expect((await stores.executionNodes.get(f.scope, integrated.executionNodeId))?.status).toBe(
      "integrated",
    );
    expect((await stores.executionNodes.get(f.scope, root.executionNodeId))?.status).toBe(
      "running",
    );
    expect((await stores.agents.get(f.scope, worker.agentId))?.status).toBe("interrupted");
    expect((await stores.agents.get(f.scope, oldRoot.agentId))?.status).toBe("interrupted");
    expect((await stores.agents.get(f.scope, done.agentId))?.status).toBe("completed");
    expect((await stores.agents.get(f.scope, examiner.agentId))?.status).toBe("interrupted");
    expect(
      (await stores.executionNodes.get(f.scope, running.executionNodeId))?.outcomeReason,
    ).toContain("generation 2");
  });

  it("sweeps every page, including running work beyond the first 500 records", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores();
    for (let index = 0; index < 501; index += 1) {
      await stores.executionNodes.put(makeNode(f, f.rootNodeId, { status: "queued" }));
    }
    const last = makeNode(f, f.rootNodeId, { status: "running" });
    await stores.executionNodes.put(last);
    const orphans = await interruptOrphans(stores, f.scope, "2026-10-04T03:00:00.000Z", 2);
    expect(orphans.preserved).toHaveLength(501);
    expect(orphans.interrupted).toEqual([last.executionNodeId]);
    expect((await stores.executionNodes.get(f.scope, last.executionNodeId))?.status).toBe(
      "interrupted",
    );
  });

  it("tells the root what happened and what to retry", () => {
    const note = recoveryNote(3, {
      interrupted: ["node_a", "node_b"],
      preserved: ["node_c"],
    });
    expect(note).toContain("generation 3");
    expect(note).toContain("2 running node(s)");
    expect(note).toContain("1 accepted job(s)");
    expect(note).toContain("job.retry");
    expect(note).toContain("sub-program parents before their children");
    expect(recoveryNote(2, { interrupted: [], preserved: [] })).toContain("No job was in flight");
    expect(note).not.toContain("Delegate their strands again");
  });
});

describe("the remote root owns retryable project setup", () => {
  it("forwards the remote workspace to its MCP engine", () => {
    expect(
      rootLaunch(
        { NIGHTSHIFT_REMOTE_WORKSPACE: "/workspace" },
        { repoPath: "/workspace/checkout", agentId: "agent-root" },
      ).env.NIGHTSHIFT_REMOTE_WORKSPACE,
    ).toBe("/workspace");
  });

  it("briefs status, preparation, diagnosis and retry without a readiness gate", () => {
    expect(remoteEnvironmentNote).toContain("run.attach");
    expect(remoteEnvironmentNote).toContain("environment.status");
    expect(remoteEnvironmentNote).toContain("environment.prepare again");
    expect(remoteEnvironmentNote).toContain("project user, not as the engine");
    expect(remoteEnvironmentNote).toContain("not a delegation certificate");
  });
});

describe("a root stopped by a usage limit (D-P8-06, as amended 2026-10-12)", () => {
  const scope = {
    projectId: "proj_01",
    programId: "prog_01",
    runId: "run_01",
  } as unknown as HeadlessInput["scope"];
  const clock = { now: () => Date.parse("2026-10-12T10:00:00.000Z") };
  const limited = {
    kind: "failed" as const,
    exitCode: 1,
    unavailable: "the provider answered 429 after work began: You've hit your session limit",
    availableAgainAt: "2026-10-12T15:00:00.000Z",
    workBegan: true,
  };
  const run = (status: string) => ({ runId: "run_01", rootNodeId: "node_root", status }) as never;
  const route = (model: string) => ({ harness: "h", provider: "p", model });

  it("is replaced on the next route, told why, unpinned, with every transcript kept", async () => {
    const launches: Parameters<RootLaunch>[] = [];
    const launch: RootLaunch = async (...args) => {
      launches.push(args);
      const first = launches.length === 1;
      return {
        exit: first ? limited : { kind: "completed" },
        run: run(first ? "running" : "succeeded"),
        agentId: `agent_${launches.length}` as never,
        transcript: `t${launches.length}`,
        route: route(first ? "opus" : "astra"),
        measurementSummaryId: `meas_${launches.length}`,
      };
    };
    const result = await replacingLimitedRoots(
      clock,
      { scope, repoPath: "/repo", harness: "h", model: "opus" },
      launch,
    );
    expect(result.exit.kind).toBe("completed");
    expect(result.transcripts.map((t) => t.path)).toEqual(["t1", "t2"]);
    expect(result.measurements).toEqual([
      { agentId: "agent_1", measurementSummaryId: "meas_1" },
      { agentId: "agent_2", measurementSummaryId: "meas_2" },
    ]);
    const [, second] = launches;
    expect(second?.[0]).toEqual({ scope, repoPath: "/repo", recovering: { generation: 0 } });
    expect(second?.[1]).toEqual([{ harness: "h", model: "opus" }]);
    expect(second?.[2]).toMatch(/stopped by a usage limit[\s\S]*It ran on opus/);
  });

  it("replaces a root refused before it attached, on a run still pending (2026-10-23)", async () => {
    const launches: Parameters<RootLaunch>[] = [];
    const result = await replacingLimitedRoots(
      clock,
      { scope, repoPath: "/repo" },
      async (...args) => {
        launches.push(args);
        const first = launches.length === 1;
        return {
          exit: first ? limited : { kind: "completed" },
          run: run(first ? "pending" : "succeeded"),
          agentId: `agent_${launches.length}` as never,
          transcript: `t${launches.length}`,
          route: route(first ? "fable" : "opus"),
          measurementSummaryId: `meas_${launches.length}`,
        };
      },
    );
    expect(launches).toHaveLength(2);
    expect(launches[1]?.[1]).toEqual([{ harness: "h", model: "fable" }]);
    expect(result.exit.kind).toBe("completed");
  });

  it("leaves every other ending to the run: a failure, or a run no longer running", async () => {
    for (const [exit, status] of [
      [{ kind: "failed" as const, exitCode: 1 }, "running"],
      [{ kind: "failed" as const, exitCode: 1 }, "pending"],
      [limited, "interrupted"],
      [limited, "succeeded"],
    ] as const) {
      let launched = 0;
      await replacingLimitedRoots(clock, { scope, repoPath: "/repo" }, async () => {
        launched += 1;
        return {
          exit,
          run: run(status),
          agentId: "agent_1" as never,
          transcript: "t",
          route: route("opus"),
          measurementSummaryId: "meas_1",
        };
      });
      expect(launched).toBe(1);
    }
  });
});

describe("the root's measurements", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
      cwd,
      stdio: "pipe",
    });

  /** A runtime over in-memory stores and a real repository, whose roots follow `exits`. */
  const rig = (
    exits: readonly HarnessExit[],
    options: {
      prices?: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
      requestModels?: readonly string[];
      /** A root refused before it attached leaves the run pending (2026-10-23). */
      attaches?: boolean;
    } = {},
  ) => {
    const f: Fixtures = createFixtures();
    const dir = mkdtempSync(join(tmpdir(), "headless-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "program/fixture");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const stores = createInMemoryStores();
    const sha256 = "a".repeat(64);
    const program = makeProgramContract(f, {
      status: "ratified",
      modelPolicy: {
        allowedProviders: ["anthropic", "openai"],
        allowedModels: [],
        forbiddenModels: [],
      },
      planHash: sha256,
      planDocument: { uri: "memory://plan", sha256, sizeBytes: 1 },
      strands: [
        {
          id: "S-01",
          name: "The one strand",
          scope: { summary: "a", includes: ["a.txt"], excludes: [] },
          acceptance: ["a exists"],
          successCriteria: ["SC-01"],
          dependsOn: [],
          prerequisites: [],
        },
      ],
    });
    const root = makeRootNode(f, {
      status: "running",
      plan: {
        planHash: sha256,
        planDocument: { uri: "memory://plan", sha256, sizeBytes: 1 },
      },
    } as never);
    const launches: { agentId: string; model: string }[] = [];
    const harness: Harness = {
      id: "fake",
      capabilities: { usage: true, observations: true },
      start: async (input: HarnessStartInput) => {
        const index = launches.length;
        launches.push({ agentId: input.agent.agentId, model: input.model.model });
        for (const model of options.requestModels ?? []) {
          input.measurements?.observe({
            schemaVersion: 1,
            observationId: `obs-${launches.length}-${model}`,
            source: "harness",
            provenance: { adapter: "fake" },
            inclusion: "self",
            kind: "request",
            model,
            counters: { inputTokens: 1000, outputTokens: 100 },
          } as never);
        }
        // The first root brings the run to running, as its attached server would.
        const run = await stores.runs.get(f.scope, f.scope.runId);
        if (run !== undefined && options.attaches !== false) {
          await stores.runs.put({ ...run, status: "running" });
        }
        return {
          agentId: input.agent.agentId,
          exit: Promise.resolve(exits[index] ?? { kind: "completed" }),
        };
      },
      cancel: async () => {},
      status: async () => "started",
    } as unknown as Harness;
    const runtime = {
      stores,
      bodies: {
        put: async (_scope: unknown, artifactId: string, body: Uint8Array | string) => ({
          uri: `s3://bucket/${artifactId}`,
          key: artifactId,
          sizeBytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        }),
        get: async () => undefined,
      },
      harness,
      paths: {
        worktree: (runId: string, nodeId: string) => join(dir, "wt", runId, nodeId),
        runDir: (runId: string) => join(dir, "runs", runId),
        spool: (runId: string) => join(dir, "runs", runId, "spool.ndjson"),
        transcript: (runId: string, agentId: string) =>
          join(dir, "runs", runId, "agents", agentId, "transcript.jsonl"),
        measurementsDir: (runId: string) => join(dir, "runs", runId, "measurements"),
        measurementJournal: (runId: string, agentId: string, launchId: string) =>
          join(dir, "runs", runId, "measurements", `${agentId}__${launchId}.ndjson`),
        scratch: (checkout: string) => join(dir, "t", checkout.slice(-8)),
      },
      git: nodeGitRunner,
      ids: createUlidIdGenerator(),
      clock: systemClock,
      planText: async () => "# The plan",
    } as unknown as Runtime;
    const seed = async () => {
      await stores.programContracts.put(program);
      const base = makeRun(f, { status: "pending" });
      await stores.runs.put(
        options.prices === undefined
          ? base
          : ({
              ...base,
              policy: {
                routingPolicy: { ...DEFAULT_ROUTING_POLICY, prices: options.prices },
                examinationPolicy: DEFAULT_EXAMINATION_POLICY,
                orgConfigVersion: 1,
              },
            } as never),
      );
      await stores.executionNodes.put(root);
    };
    return { f, stores, runtime, repo, seed, launches, root };
  };

  const input = (f: Fixtures, repo: string): HeadlessInput => ({ scope: f.scope, repoPath: repo });

  it("leaves a summary with the usage of a root that fell back, and a separate one for its replacement", async () => {
    const limited: HarnessExit = {
      kind: "failed",
      exitCode: 1,
      unavailable: "the provider answered 429 after work began",
      availableAgainAt: "2099-01-01T00:00:00.000Z",
      workBegan: true,
      usage: { inputTokens: 300, outputTokens: 40 },
    };
    const r = rig([limited, { kind: "completed", usage: { inputTokens: 7, outputTokens: 1 } }]);
    await r.seed();
    const result = await replacingLimitedRoots(
      systemClock,
      input(r.f, r.repo),
      (launch, unavailable, note) => launchRoot(r.runtime, {}, launch, unavailable, note),
    );
    expect(r.launches).toHaveLength(2);
    expect(result.measurements.map((m) => m.agentId)).toEqual(r.launches.map((l) => l.agentId));
    const summaries = await r.stores.measurements.listByNode(r.f.scope, r.root.executionNodeId);
    expect(summaries).toHaveLength(2);
    const [first, second] = result.measurements.map((m) =>
      summaries.find((s) => s.measurementSummaryId === m.measurementSummaryId),
    );
    expect(first?.measurementSummaryId).not.toBe(second?.measurementSummaryId);
    expect(first?.agentId).toBe(r.launches[0]?.agentId);
    expect(second?.agentId).toBe(r.launches[1]?.agentId);
    expect(first).toMatchObject({
      role: "orchestrator",
      routingDecisionId: null,
      totals: { inputTokens: 300, outputTokens: 40 },
    });
    expect(first?.segments[0]).toMatchObject({ exitKind: "failed", resumedSession: false });
    expect(second).toMatchObject({ routingDecisionId: null, totals: { inputTokens: 7 } });
    expect(first?.route.model).toBe(r.launches[0]?.model);
    expect(await r.stores.routingDecisions.listByNode(r.f.scope, r.root.executionNodeId)).toEqual(
      [],
    );
  });

  it("values a root's request naming a model other than its route's from the run's price table", async () => {
    // Neither model is the route's, so only the run's table can value them.
    const price = { inputPerMTok: 3, outputPerMTok: 15 };
    const r = rig([{ kind: "completed" }], {
      prices: { "m-other": price, "m-third": price },
      requestModels: ["m-other", "m-third"],
    });
    await r.seed();
    await launchRoot(r.runtime, {}, input(r.f, r.repo), [], undefined);
    const [summary] = await r.stores.measurements.listByNode(r.f.scope, r.root.executionNodeId);
    const models = new Set(summary?.valuation.components?.map((c) => c.model));
    expect(models).toEqual(new Set(["m-other", "m-third"]));
    expect(summary?.valuation.completeness?.unvaluedRequests).toBe(0);
  });

  it.each([
    ["cancelled", { kind: "cancelled", usage: { inputTokens: 55, outputTokens: 5 } }],
    [
      "interrupted",
      { kind: "interrupted", signal: "SIGKILL", usage: { inputTokens: 55, outputTokens: 5 } },
    ],
  ] as const)("retains the usage of a root that was %s", async (kind, exit) => {
    const r = rig([exit as HarnessExit]);
    await r.seed();
    const ended = await launchRoot(r.runtime, {}, input(r.f, r.repo), [], undefined);
    const [summary] = await r.stores.measurements.listByNode(r.f.scope, r.root.executionNodeId);
    expect(summary?.measurementSummaryId).toBe(ended.measurementSummaryId);
    expect(summary?.segments[0]?.exitKind).toBe(kind);
    expect(summary?.totals).toMatchObject({ inputTokens: 55, outputTokens: 5 });
    expect(summary?.routingDecisionId).toBeNull();
  });

  it("launches again on a pending run whose earlier root left its worktree (2026-10-23)", async () => {
    // The first root was refused before it attached, so the run is still
    // pending; the restart's root must not trip over the worktree it left.
    const r = rig(
      [{ kind: "failed", exitCode: 1 } as HarnessExit, { kind: "completed" } as HarnessExit],
      { attaches: false },
    );
    await r.seed();
    await launchRoot(r.runtime, {}, input(r.f, r.repo), [], undefined);
    const again = await launchRoot(r.runtime, {}, input(r.f, r.repo), [], undefined);
    expect(again.exit.kind).toBe("completed");
  });
});
