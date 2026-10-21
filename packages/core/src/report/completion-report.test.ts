/**
 * The Completion section's model and machine figures (D-05), gathered from
 * in-memory stores: every member run is read once, charged once per history,
 * and a refused read leaves that member's figure absent.
 */
import type {
  CompletionHistory,
  CompletionMemberRef,
  IsoTimestamp,
  MeasurementSummary,
  RoutingDecision,
  Run,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import type { ProjectStores } from "../ports/stores.js";
import { buildCompletionHistory } from "../rules/completion.js";
import type { RunScope } from "../rules/ownership.js";
import {
  createFixtures,
  makeDispatch,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "../testing/factories.js";
import { gatherMemberFigures, gatherReport, renderReport } from "./report.js";

const at = (s: number): IsoTimestamp =>
  new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString() as IsoTimestamp;
const page = <T>(items: readonly T[]) => Promise.resolve({ items });
const actor = { kind: "user", userId: "ann", orgId: "org_01HF7YAT00GGGGGGGGGGGGGGGG" } as never;

const world = () => {
  const f = createFixtures();
  const other = f.ids.next("prog");
  const scopes = {
    a: f.scope,
    b: { ...f.scope, runId: f.ids.next("run") },
    c: { projectId: f.scope.projectId, programId: other, runId: f.ids.next("run") },
  };
  const build = (key: keyof typeof scopes, start: number, patch: Partial<RoutingDecision>) => {
    const scope = scopes[key];
    const root = makeRootNode(f, {
      ...scope,
      executionNodeId: key === "a" ? f.rootNodeId : f.ids.next("node"),
    });
    const node = makeNode(f, root.executionNodeId, scope);
    const run: Run = makeRun(f, {
      ...scope,
      rootNodeId: root.executionNodeId,
      status: "succeeded",
      startedAt: at(start),
      endedAt: at(start + 100),
    });
    const route = {
      schemaVersion: 1,
      ...scope,
      routingDecisionId: f.ids.next("route"),
      executionNodeId: node.executionNodeId,
      attempt: 1,
      eligibleOptions: [
        { target: { harness: "claude", provider: "anthropic", model: "m" }, eligible: true },
      ],
      chosen: { harness: "claude", provider: "anthropic", model: "m" },
      ruleId: "r",
      wasOverride: false,
      outcome: "verified",
      previousRouteId: null,
      createdAt: at(start),
      ...patch,
    } as RoutingDecision;
    return { scope, run, nodes: [root, node], route };
  };
  const a = build("a", 0, {
    usage: { inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.5 },
  });
  const b = build("b", 200, {
    usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: 2 },
  });
  const c = build("c", 400, {
    usage: { inputTokens: 300, outputTokens: 30, estimatedCostUsd: 0.25, actualCostUsd: 1 },
  });
  const summary = {
    measurementVersion: 1,
    ...b.scope,
    measurementSummaryId: f.ids.next("meas"),
    executionNodeId: b.route.executionNodeId,
    agentId: f.ids.next("agent"),
    role: "worker",
    routingDecisionId: b.route.routingDecisionId,
    route: b.route.chosen,
    observedModels: [],
    segments: [],
    totals: { inputTokens: 200, outputTokens: 20, inputIncludesCache: true },
    coverage: "complete",
    gaps: [],
    ledger: { chunks: 0, artifactIds: [], observationCount: 0, publishedCount: 0 },
    valuation: { source: "unknown" },
    createdAt: at(200),
    updatedAt: at(300),
  } as unknown as MeasurementSummary;
  const dispatch = makeDispatch(f, {
    ...b.scope,
    requestedAt: at(200),
    usdPerHour: 3.6,
    priceBasis: {
      usdPerHour: 3.6,
      volumeUsdPerHour: 0.36,
      source: "aws-price-list",
      asOf: "2026-01-01",
      region: "us-west-2",
    },
    attempts: [
      {
        generation: 1,
        reason: "dispatch",
        startedAt: at(200),
        endedAt: at(1200),
        endReason: "stopped",
        terminatedAt: at(1200),
        meteredSeconds: 1000,
      },
    ],
    cleanup: { volumeDeleted: true, volumeDeletedAt: at(1800), failures: [] },
  });
  const members = (...runs: { scope: Pick<RunScope, "programId" | "runId"> }[]) =>
    runs.map(
      (r, i): CompletionMemberRef => ({
        programId: r.scope.programId,
        runId: r.scope.runId,
        role: i === 0 ? "anchor" : "correction",
      }),
    );
  const history = (title: string, ...runs: { scope: Pick<RunScope, "programId" | "runId"> }[]) =>
    buildCompletionHistory({
      scope: f.scope,
      completionHistoryId: f.ids.next("comp"),
      title,
      members: members(...runs),
      actor,
      at: at(1),
    });
  return { f, a, b, c, summary, dispatch, history };
};

/** Stores over the three runs; every method call is counted by `method:runId`. */
const storesFor = (
  w: ReturnType<typeof world>,
  refuse: readonly string[] = [],
  histories?: () => CompletionHistory[],
  rootSummaries: readonly MeasurementSummary[] = [],
) => {
  const calls = new Map<string, number>();
  const runs = [w.a, w.b, w.c];
  const byRun =
    <T>(
      method: string,
      pick: (r: (typeof runs)[number]) => T,
      fallback: T,
    ): ((scope: { runId: string }) => Promise<T>) =>
    (scope) => {
      calls.set(`${method}:${scope.runId}`, (calls.get(`${method}:${scope.runId}`) ?? 0) + 1);
      if (refuse.includes(`${method}:${scope.runId}`)) return Promise.reject(new Error("refused"));
      const found = runs.find((r) => r.scope.runId === scope.runId);
      return Promise.resolve(found === undefined ? fallback : pick(found));
    };
  const list = <T>(method: string, pick: (r: (typeof runs)[number]) => T[]) => {
    const read = byRun(method, pick, [] as T[]);
    return (scope: { runId: string }) => read(scope).then((items) => ({ items }));
  };
  const stores = {
    programContracts: {
      get: () => Promise.resolve(makeProgramContract(w.f, { strands: [] })),
      listByProject: () => page([]),
    },
    runs: {
      get: (scope: { runId: string }, runId: string) =>
        Promise.resolve(runs.find((r) => r.scope.runId === runId)?.run ?? undefined).then(
          (found) => (scope ? found : undefined),
        ),
      listByProgram: () => page([w.a.run]),
    },
    executionNodes: { listByRun: list("nodes", (r) => r.nodes) },
    jobContracts: { listByRun: () => page([]) },
    decisions: { listByRun: () => page([]), get: () => Promise.resolve(undefined) },
    events: { listByRun: () => page([]) },
    measurements: {
      listByRun: list("measurements", (r) => [
        ...(r === w.b ? [w.summary] : []),
        ...rootSummaries.filter((summary) => summary.runId === r.scope.runId),
      ]),
    },
    dispatches: { get: byRun("dispatch", (r) => (r === w.b ? w.dispatch : undefined), undefined) },
    computeUtilizations: { get: () => Promise.resolve(undefined) },
    agents: { listByNode: () => Promise.resolve([]) },
    routingDecisions: {
      listByNode: (scope: { runId: string }, nodeId: string) => {
        const found = runs.find((r) => r.scope.runId === scope.runId);
        return byRun(
          "routes",
          () => (found?.route.executionNodeId === nodeId ? [found.route] : []),
          [] as RoutingDecision[],
        )(scope);
      },
    },
    examinations: { listByNode: () => Promise.resolve([]) },
    verifications: { listByNode: () => Promise.resolve([]) },
    gateHealth: { get: () => Promise.resolve(undefined) },
    feedback: {
      get: () => Promise.resolve(undefined),
      listByProgram: () => page([]),
    },
    completionHistories: {
      listByProject: () =>
        page(histories?.() ?? [w.history("First", w.a, w.b), w.history("Second", w.a, w.c)]),
    },
  } as unknown as ProjectStores;
  return { stores, calls };
};

describe("the Completion section's model and machine figures", () => {
  it("sums tokens, keeps estimated and reported dollars apart, and charges each run once per history", async () => {
    const w = world();
    const { stores, calls } = storesFor(w);
    const gathered = await gatherReport(stores, w.f.scope);
    const [first, second] = gathered.completions;
    expect(first?.title).toBe("First");
    expect(first?.current.resources?.tokens).toMatchObject({ input: 300, output: 30 });
    expect(first?.current.resources?.usd).toEqual({ estimated: 0.5, reported: 2 });
    expect(first?.current.infrastructure).toEqual({ usd: 1.16, members: 1, withoutMachine: 1 });
    expect(second?.current.resources?.tokens).toMatchObject({ input: 400, output: 40 });
    expect(second?.current.resources?.usd).toEqual({ estimated: 0.75, reported: 1 });
    expect(second?.current.infrastructure).toBeUndefined();

    // The current run is in both histories and is not read again; the others once.
    for (const r of [w.a, w.b, w.c]) {
      expect(calls.get(`measurements:${r.scope.runId}`)).toBe(1);
      expect(calls.get(`nodes:${r.scope.runId}`)).toBe(1);
    }
    expect(calls.get(`dispatch:${w.b.scope.runId}`)).toBe(1);

    const text = renderReport(gathered);
    expect(text).toContain("tokens in 300, out 30");
    expect(text).toContain(
      "estimated: $0.50 for 1 of 2 attempts, reported: $2.00 for 1 of 2 attempts (separate figures)",
    );
    expect(text).toContain("infrastructure $1.16 over 1 member run(s)");
    expect(text).toContain("tokens in 400, out 40");
    expect(text).toContain(
      "estimated: $0.75 for 2 of 2 attempts, reported: $1.00 for 1 of 2 attempts (separate figures)",
    );
    expect(text).toContain("machine dollars not observed");
    expect(text).toContain("machines 1 of 2 members");
    expect(text).toContain("token coverage complete 1, partial 0, unknown 0, legacy 1, missing 0");
  });

  // A root launch's summary has no routing decision (S-01). D-02: it is part of every aggregate.
  const rootSummaryOf = (
    w: ReturnType<typeof world>,
    run: (typeof w)["a"],
    patch: Partial<MeasurementSummary> = {},
  ): MeasurementSummary =>
    ({
      ...w.summary,
      ...run.scope,
      measurementSummaryId: w.f.ids.next("meas"),
      executionNodeId: run.nodes[0]?.executionNodeId,
      role: "orchestrator",
      routingDecisionId: null,
      route: { harness: "claude", provider: "anthropic", model: "root-model" },
      totals: { inputTokens: 50, outputTokens: 5, inputIncludesCache: true },
      valuation: { source: "reported", usd: 0.75, reportedUsd: 0.75 },
      ...patch,
    }) as MeasurementSummary;

  it("includes a member run's root launch in its figures", async () => {
    const w = world();
    const root = rootSummaryOf(w, w.b);
    const { stores } = storesFor(w, [], undefined, [root]);
    const [first] = (await gatherReport(stores, w.f.scope)).completions;
    // A: 100/10 and $0.50 estimated. B: its worker summary 200/20 with the route's $2 reported,
    // plus B's root launch 50/5 and $0.75 reported.
    expect(first?.current.resources?.tokens).toMatchObject({ input: 350, output: 35 });
    expect(first?.current.resources?.usd.reported).toBeCloseTo(2.75);
    expect(first?.current.resources?.usd.estimated).toBeCloseTo(0.5);
  });

  it("shows the current run's root launch as a labelled usage row, or as unmeasured without a summary", async () => {
    const w = world();
    const withRoot = await gatherReport(
      storesFor(w, [], undefined, [rootSummaryOf(w, w.a)]).stores,
      w.f.scope,
    );
    const row = withRoot.usage.find((candidate) => candidate.purpose === "root");
    expect(row).toMatchObject({
      model: "root-model",
      attempts: 1,
      inputTokens: 50,
      outputTokens: 5,
      reportedUsd: 0.75,
      unpriced: 0,
    });
    expect(withRoot.budget?.tokens).toBe(110 + 55);
    const total = withRoot.usage.reduce(
      (sum, usage) => sum + usage.inputTokens + usage.outputTokens,
      0,
    );
    expect(total).toBe(withRoot.budget?.tokens);
    expect(renderReport(withRoot)).toContain("root-model");

    const without = await gatherReport(storesFor(w).stores, w.f.scope);
    const missing = without.usage.find((candidate) => candidate.purpose === "root");
    expect(missing).toMatchObject({ attempts: 1, unpriced: 1, inputTokens: 0, tokensObserved: 0 });
    expect(without.budget?.tokens).toBe(110);
  });

  it("leaves a refused member's resources absent and still renders", async () => {
    const w = world();
    const { stores } = storesFor(w, [`measurements:${w.b.scope.runId}`]);
    const gathered = await gatherReport(stores, w.f.scope);
    const [first, second] = gathered.completions;
    // Only A contributes to the first history; B's figure is absent, not zero.
    expect(first?.current.resources?.tokens).toMatchObject({ input: 100, output: 10 });
    expect(first?.current.resources?.usd).toEqual({ estimated: 0.5, reported: 0 });
    expect(first?.current.infrastructure).toEqual({ usd: 1.16, members: 1, withoutMachine: 1 });
    expect(second?.current.resources?.tokens).toMatchObject({ input: 400, output: 40 });
    expect(renderReport(gathered)).toContain("## Completion");
  });

  it("keeps a checkpoint's figures when a member of its snapshot is later removed", async () => {
    const w = world();
    const id = w.f.ids.next("comp");
    const base = {
      scope: w.f.scope,
      completionHistoryId: id,
      title: "H",
      actor,
    } as const;
    const both = [w.a, w.b].map(
      (r, i): CompletionMemberRef => ({
        programId: r.scope.programId,
        runId: r.scope.runId,
        role: i === 0 ? "anchor" : "correction",
      }),
    );
    const proposed = buildCompletionHistory({
      ...base,
      members: both,
      at: at(1),
      checkpoint: { name: "cp", programId: w.a.scope.programId, runId: w.a.scope.runId },
    });
    // The server replaces the placeholder with the figures it measured.
    const checkpointed: CompletionHistory = {
      ...proposed,
      checkpoints: proposed.checkpoints.map((c) => ({
        ...c,
        measured: {
          ...c.measured,
          tokens: { input: 300, output: 30, inputConventionUnknown: 0 },
          usd: { estimated: 0.5, reported: 2 },
          coverage: { complete: 2, partial: 0, unknown: 0, legacy: 0, missing: 0 },
        },
      })),
    };
    const trimmed = buildCompletionHistory({
      ...base,
      stored: checkpointed,
      members: [both[0] as CompletionMemberRef],
      at: at(2),
    });
    const before = (await gatherReport(storesFor(w, [], () => [checkpointed]).stores, w.f.scope))
      .completions[0];
    const after = (await gatherReport(storesFor(w, [], () => [trimmed]).stores, w.f.scope))
      .completions[0];
    expect(after?.checkpoints[0]).toEqual(before?.checkpoints[0]);
    expect(after?.checkpoints[0]?.resources?.tokens).toMatchObject({ input: 300, output: 30 });
    expect(after?.checkpoints[0]?.resources?.usd).toEqual({ estimated: 0.5, reported: 2 });
    expect(before?.current.resources?.tokens).toMatchObject({ input: 300 });
    expect(after?.current.resources?.tokens).toMatchObject({ input: 100, output: 10 });
    expect(after?.current.resources?.usd).toEqual({ estimated: 0.5, reported: 0 });
  });

  it("gathers each member's figures once for the API and CLI", async () => {
    const w = world();
    const { stores, calls } = storesFor(w);
    const runs = new Map([w.a, w.b].map((r) => [`${r.scope.programId}/${r.scope.runId}`, r.run]));
    const refs = [w.a, w.b, w.a].map((r) => ({
      programId: r.scope.programId,
      runId: r.scope.runId,
    }));
    const figures = await gatherMemberFigures(
      stores as unknown as ProjectStores,
      w.f.scope.projectId,
      refs,
      runs,
      at(2000),
    );
    expect(figures.resources.get(`${w.a.scope.programId}/${w.a.scope.runId}`)?.tokens.input).toBe(
      100,
    );
    expect(figures.resources.size).toBe(2);
    expect(calls.get(`measurements:${w.a.scope.runId}`)).toBe(1);
  });

  it("reports a failed measurement read as unavailable and keeps a member without summaries present", async () => {
    const w = world();
    const { stores } = storesFor(w, ["measurements:" + w.b.scope.runId]);
    const runs = new Map([w.a, w.b].map((r) => [`${r.scope.programId}/${r.scope.runId}`, r.run]));
    const refs = [w.a, w.b].map((r) => ({ programId: r.scope.programId, runId: r.scope.runId }));
    const figures = await gatherMemberFigures(
      stores as unknown as ProjectStores,
      w.f.scope.projectId,
      refs,
      runs,
      at(2000),
    );
    const keyA = `${w.a.scope.programId}/${w.a.scope.runId}`;
    const keyB = `${w.b.scope.programId}/${w.b.scope.runId}`;
    expect([...figures.unavailable.keys()]).toEqual([keyB]);
    expect(figures.unavailable.get(keyB)).toContain("refused");
    expect(figures.resources.has(keyB)).toBe(false);
    expect(figures.resources.has(keyA)).toBe(true);
    expect(figures.unavailable.has(keyA)).toBe(false);
  });

  const figuresWith = async (
    w: ReturnType<typeof world>,
    patch: (stores: Record<string, unknown>) => void,
  ) => {
    const { stores } = storesFor(w);
    patch(stores as unknown as Record<string, unknown>);
    const all = [w.a, w.b];
    return gatherMemberFigures(
      stores as unknown as ProjectStores,
      w.f.scope.projectId,
      all.map((r) => ({ programId: r.scope.programId, runId: r.scope.runId })),
      new Map(all.map((r) => [`${r.scope.programId}/${r.scope.runId}`, r.run])),
      at(2000),
    );
  };

  it("reports a throwing dispatch read as unavailable and absent from infrastructure", async () => {
    const w = world();
    const figures = await figuresWith(w, (s) => {
      s.dispatches = { get: () => Promise.reject(new Error("dispatch store down")) };
    });
    const keyB = `${w.b.scope.programId}/${w.b.scope.runId}`;
    const keyA = `${w.a.scope.programId}/${w.a.scope.runId}`;
    expect(figures.unavailable.get(keyB)).toContain("dispatch: dispatch store down");
    expect(figures.unavailable.get(keyA)).toContain("dispatch");
    expect(figures.infrastructure.size).toBe(0);
  });

  it("reports a throwing utilization read as unavailable and absent from infrastructure", async () => {
    const w = world();
    const figures = await figuresWith(w, (s) => {
      s.computeUtilizations = { get: () => Promise.reject(new Error("utilization down")) };
    });
    const keyB = `${w.b.scope.programId}/${w.b.scope.runId}`;
    expect(figures.unavailable.get(keyB)).toContain("utilization: utilization down");
    expect(figures.infrastructure.has(keyB)).toBe(false);
  });

  it("does not mark a member unavailable when the dispatch read finds nothing", async () => {
    const w = world();
    const figures = await figuresWith(w, () => undefined);
    const keyA = `${w.a.scope.programId}/${w.a.scope.runId}`;
    const keyB = `${w.b.scope.programId}/${w.b.scope.runId}`;
    expect(figures.unavailable.size).toBe(0);
    expect(figures.infrastructure.has(keyA)).toBe(false);
    expect(figures.infrastructure.has(keyB)).toBe(true);
  });

  it("keeps a member with no routing decisions or summaries as an empty present entry", async () => {
    const w = world();
    w.a.route.executionNodeId = "node_none" as never;
    const { stores } = storesFor(w);
    const runs = new Map([[`${w.a.scope.programId}/${w.a.scope.runId}`, w.a.run]]);
    const figures = await gatherMemberFigures(
      stores as unknown as ProjectStores,
      w.f.scope.projectId,
      [{ programId: w.a.scope.programId, runId: w.a.scope.runId }],
      runs,
      at(2000),
    );
    const entry = figures.resources.get(`${w.a.scope.programId}/${w.a.scope.runId}`);
    expect(entry?.coverage).toEqual({ complete: 0, partial: 0, unknown: 0, legacy: 0, missing: 0 });
    expect(figures.unavailable.size).toBe(0);
  });

  it("renders missing dollar evidence as not observed with member counts, never $0.00", async () => {
    const w = world();
    w.a.route.executionNodeId = "node_none" as never;
    const { stores } = storesFor(w, ["measurements:" + w.b.scope.runId], () => [
      w.history("U", w.a, w.b),
    ]);
    const text = renderReport(await gatherReport(stores, w.f.scope));
    expect(text).toContain("dollars not observed");
    const section = text.slice(text.indexOf("## Completion")).split("\n## Review")[0] ?? "";
    expect(section).not.toContain("estimated $0.00");
    expect(text).toContain("measured 0 of 2 members");
    expect(text).toContain(`measurement unavailable for ${w.b.scope.programId}/${w.b.scope.runId}`);
  });

  it("prints a present zero dollar total as $0.00 rather than not observed", async () => {
    const w = world();
    w.a.route.usage = { inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0 };
    const { stores } = storesFor(w, [], () => [w.history("Z", w.a)]);
    const text = renderReport(await gatherReport(stores, w.f.scope));
    expect(text).toContain(
      "estimated: $0.00 for 1 of 1 attempts, reported: none (separate figures)",
    );
  });

  it("prints reported: none and estimated: none when no attempt carried the figure, and a positive figure with its count", async () => {
    const w = world();
    w.a.route.usage = { inputTokens: 100, outputTokens: 10, actualCostUsd: 0 };
    const { stores } = storesFor(w, [], () => [w.history("R", w.a)]);
    const text = renderReport(await gatherReport(stores, w.f.scope));
    expect(text).toContain(
      "estimated: none, reported: $0.00 for 1 of 1 attempts (separate figures)",
    );

    w.a.route.usage = { inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.5 };
    const positive = storesFor(w, [], () => [w.history("P", w.a)]);
    const positiveText = renderReport(await gatherReport(positive.stores, w.f.scope));
    expect(positiveText).toContain(
      "estimated: $0.50 for 1 of 1 attempts, reported: none (separate figures)",
    );
    expect(positiveText).not.toContain("reported $0.00");
  });

  it("prints the as-of time, membership version, each member's carried strands and own figures, and the price bases", async () => {
    const w = world();
    const { stores } = storesFor(w, [], () => [w.history("S", w.a, w.b)]);
    const gathered = await gatherReport(stores, w.f.scope);
    const history = gathered.completions[0];
    expect(history?.asOf).toBe(gathered.asOf);
    const text = renderReport(gathered);
    const section = text.slice(text.indexOf("### S ("));
    expect(section).toContain(`As of ${gathered.asOf}; membership version ${history?.version}.`);
    expect(section).toContain("carried strands 0; tokens in 100, out 10; estimate $0.50");
    expect(section).toContain("tokens in 200, out 20; estimate not observed");
    expect(section).toContain("Price basis: none recorded.");

    const first = gathered.completions[0];
    if (first === undefined) throw new Error("no completion");
    const withBasis = renderReport({
      ...gathered,
      completions: [
        {
          ...first,
          current: {
            ...first.current,
            combined: {
              usd: 0.5,
              model: 0.5,
              coverage: {
                measuredMembers: 1,
                unmeasuredMembers: 0,
                estimateIncomplete: 0,
                membersWithoutMachine: 0,
              },
              lowerBound: false,
              priceBases: [{ model: "m", source: "list", version: "v1", incomplete: true }],
            },
          },
        },
      ],
    });
    expect(withBasis).toContain("- m: source list, version v1, incomplete yes");
  });
});
