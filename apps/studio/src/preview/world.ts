/**
 * The small builders the preview scenarios share: a clock in minutes, the
 * records a run is made of, and the measurement summaries a recorder would have
 * folded for them. Every record parses through its contract schema, so a
 * scenario can never drift into a shape the stores would refuse.
 *
 * Nothing here is imported by production code; only the preview entry and the
 * scenario tests reach it.
 */
import {
  type Agent,
  type AgentRole,
  AgentSchema,
  type AttemptCause,
  type CoverageGap,
  type EventType,
  type ExecutionNode,
  type ExecutionNodeId,
  type ExecutionNodeKind,
  type ExecutionNodeStatus,
  type IsoTimestamp,
  type JobContract,
  type LifecycleObservation,
  LifecycleObservationSchema,
  lifecycleOperationId,
  type MeasurementCounters,
  type MeasurementSummary,
  MeasurementSummarySchema,
  type RouteOutcome,
  type RouteTarget,
  type RoutingDecision,
  RoutingDecisionSchema,
  type ValuationComponent,
  type Verification,
} from "@nightshift/contracts";
import {
  type Fixtures,
  type IdGenerator,
  makeEvent,
  makeJobContract,
  makeNode,
  makeVerification,
  type ProjectStores,
} from "@nightshift/core";

/** A stable commit-looking id for `n`: the same number always gives the same 40 hex digits. */
export const COMMIT = (n: number): string => {
  let state = (n + 1) * 2_654_435_761;
  let out = "";
  while (out.length < 40) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    out += (state % 65_536).toString(16).padStart(4, "0");
  }
  return out.slice(0, 40);
};

/** What a model costs per million tokens, by category; the "routing policy" the estimates are priced from. */
export const PRICES: Readonly<
  Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
> = {
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-5-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gpt-6-astra": { input: 5, output: 20, cacheRead: 0.5, cacheWrite: 5 },
};
export const PRICE_SOURCE = "routing-policy";
export const PRICE_VERSION = "2026-09-01";

export const target = (model: string): RouteTarget =>
  model.startsWith("gpt")
    ? { harness: "codex", provider: "openai", model }
    : { harness: "claude", provider: "anthropic", model };

export interface World {
  readonly stores: ProjectStores;
  readonly f: Fixtures;
  readonly ids: IdGenerator;
  /** Every measurement summary the world's attempts wrote. */
  readonly summaries: MeasurementSummary[];
  /** The instant `minutes` after the run started. */
  t(minutes: number): IsoTimestamp;
  /** Appends one event; the sequence is the order of the calls. */
  event(
    type: EventType,
    minutes: number,
    nodeId: ExecutionNodeId | null,
    payload?: Record<string, unknown>,
  ): Promise<void>;
}

export const makeWorld = (stores: ProjectStores, f: Fixtures, startedAt: string): World => {
  const base = Date.parse(startedAt);
  let sequence = 0;
  const summaries: MeasurementSummary[] = [];
  const t = (minutes: number): IsoTimestamp =>
    new Date(base + Math.round(minutes * 60_000)).toISOString() as IsoTimestamp;
  return {
    stores,
    f,
    ids: f.ids,
    summaries,
    t,
    event: async (type, minutes, nodeId, payload = {}) => {
      const n = sequence++;
      await stores.events.append(
        makeEvent(f, {
          sequence: n,
          idempotencyKey: `preview-${f.scope.runId}-${n}`,
          type,
          source: "control-plane",
          executionNodeId: nodeId,
          payload,
          occurredAt: t(minutes),
          recordedAt: t(minutes),
        }),
      );
    },
  };
};

/** One lifecycle operation: its start, and its end unless it is still open. */
export interface Span {
  readonly phase: string;
  readonly start: number;
  /** Absent: the operation is open. */
  readonly end?: number;
  readonly key?: string;
  readonly attempt?: number;
  readonly agentId?: Agent["agentId"];
  readonly reason?: string;
  readonly endReason?: string;
  readonly blockers?: readonly { kind: string; ref: string }[];
  readonly refs?: readonly { kind: string; ref: string }[];
}

export const observe = async (w: World, nodeId: ExecutionNodeId, span: Span): Promise<void> => {
  const operationId = lifecycleOperationId(span.phase, nodeId, span.key);
  const one = async (
    transition: "start" | "end",
    minutes: number,
    reason: string | undefined,
  ): Promise<void> => {
    const occurredAt = w.t(minutes);
    const observation: LifecycleObservation = LifecycleObservationSchema.parse({
      schemaVersion: 1,
      ...w.f.scope,
      observationId: `${operationId}:${transition}:${occurredAt}`,
      kind: "lifecycle",
      executionNodeId: nodeId,
      ...(span.agentId === undefined ? {} : { agentId: span.agentId }),
      source: "engine",
      provenance: { adapter: "execution" },
      occurredAt,
      receivedAt: occurredAt,
      inclusion: "self",
      operationId,
      ...(span.attempt === undefined ? {} : { attempt: span.attempt }),
      phase: span.phase,
      transition,
      ...(reason === undefined ? {} : { reason }),
      blockers: transition === "start" ? [...(span.blockers ?? [])] : [],
      ...(span.refs === undefined || span.refs.length === 0 ? {} : { refs: [...span.refs] }),
    });
    await w.event("lifecycle.observed", minutes, nodeId, observation as never);
  };
  await one("start", span.start, span.reason);
  if (span.end !== undefined) await one("end", span.end, span.endReason ?? span.reason);
};

export const sub = async (
  w: World,
  parent: ExecutionNodeId,
  kind: ExecutionNodeKind,
  depth: number,
  status: ExecutionNodeStatus,
  minutes: number,
  job: JobContract,
  extra: Partial<Pick<ExecutionNode, "commitSha" | "outcomeReason">> = {},
): Promise<ExecutionNode> => {
  const node = makeNode(w.f, parent, {
    kind,
    depth,
    status,
    jobContractId: job.jobContractId,
    commitSha: extra.commitSha ?? null,
    ...(extra.outcomeReason === undefined ? {} : { outcomeReason: extra.outcomeReason }),
    createdAt: w.t(minutes),
    updatedAt: w.t(minutes),
  });
  await w.stores.jobContracts.put(job);
  await w.stores.executionNodes.put(node);
  return node;
};

export const job = (
  w: World,
  objective: string,
  minutes: number,
  extra: Record<string, unknown> = {},
): JobContract => makeJobContract(w.f, { objective, createdAt: w.t(minutes), ...extra });

export const agentOf = async (
  w: World,
  nodeId: ExecutionNodeId,
  role: AgentRole,
  model: string,
  start: number,
  end: number | undefined,
  status: Agent["status"] = "completed",
): Promise<Agent> => {
  const route = target(model);
  const agent = AgentSchema.parse({
    schemaVersion: 1,
    ...w.f.scope,
    agentId: w.ids.next("agent"),
    executionNodeId: nodeId,
    role,
    harness: route.harness,
    provider: route.provider,
    model,
    status,
    startedAt: w.t(start),
    ...(end === undefined ? {} : { endedAt: w.t(end), exitCode: status === "completed" ? 0 : 1 }),
    createdAt: w.t(start),
  });
  await w.stores.agents.put(agent);
  return agent;
};

export interface Tokens {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

const usdOf = (tokens: number, perMTok: number): number => (tokens / 1_000_000) * perMTok;

/** The priced components of one model's tokens; cache counters are subsets of input. */
export const componentsOf = (model: string, tokens: Tokens): ValuationComponent[] => {
  const price = PRICES[model];
  if (price === undefined) return [];
  const net = Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite);
  const rows: [ValuationComponent["category"], number, number][] = [
    ["input", net, price.input],
    ["output", tokens.output, price.output],
    ["cacheRead", tokens.cacheRead, price.cacheRead],
    ["cacheWrite", tokens.cacheWrite, price.cacheWrite],
  ];
  return rows
    .filter(([, count]) => count > 0)
    .map(([category, count, perMTok]) => ({
      model,
      tier: 0,
      category,
      tokens: count,
      usd: usdOf(count, perMTok),
      perMTok,
    }));
};

export const estimateOf = (model: string, tokens: Tokens): number =>
  componentsOf(model, tokens).reduce((sum, c) => sum + c.usd, 0);

export interface AttemptSpec {
  readonly node: ExecutionNode;
  readonly agent: Agent;
  readonly model: string;
  readonly attempt: number;
  readonly outcome: RouteOutcome;
  readonly tokens: Tokens;
  /** Provider-reported dollars, when the harness reports them. */
  readonly reportedUsd?: number;
  readonly start: number;
  readonly end: number | undefined;
  readonly previous?: RoutingDecision;
  readonly causes?: AttemptCause[];
  readonly purpose?: RoutingDecision["purpose"];
  readonly concerning?: RoutingDecision["concerning"];
  /** Omit the summary: a legacy attempt has only the route's own usage. */
  readonly legacy?: boolean;
  /** A summary that is still open, or that lost evidence. */
  readonly coverage?: MeasurementSummary["coverage"];
  readonly gaps?: CoverageGap[];
  readonly open?: boolean;
  readonly exitKind?: "completed" | "failed";
}

export interface Attempt {
  readonly route: RoutingDecision;
  readonly summary: MeasurementSummary | undefined;
}

/** A routing decision for one attempt, and unless it is legacy the measurement summary behind it. */
export const attemptOf = async (w: World, spec: AttemptSpec): Promise<Attempt> => {
  const chosen = target(spec.model);
  const estimated = estimateOf(spec.model, spec.tokens);
  const wallClockMs =
    spec.end === undefined ? undefined : Math.round((spec.end - spec.start) * 60_000);
  const route = RoutingDecisionSchema.parse({
    schemaVersion: 1,
    ...w.f.scope,
    routingDecisionId: w.ids.next("route"),
    executionNodeId: spec.node.executionNodeId,
    attempt: spec.attempt,
    eligibleOptions: [{ target: chosen, eligible: true }],
    chosen,
    ruleId: "R-default",
    wasOverride: false,
    usage: {
      inputTokens: spec.tokens.input,
      outputTokens: spec.tokens.output,
      cacheReadTokens: spec.tokens.cacheRead,
      cacheWriteTokens: spec.tokens.cacheWrite,
      inputIncludesCache: true,
      costSource: spec.reportedUsd === undefined ? "estimated" : "reported",
      ...(spec.reportedUsd === undefined
        ? { estimatedCostUsd: estimated }
        : { actualCostUsd: spec.reportedUsd }),
      ...(wallClockMs === undefined ? {} : { wallClockMs }),
    },
    outcome: spec.outcome,
    previousRouteId: spec.previous?.routingDecisionId ?? null,
    ...(spec.causes === undefined ? {} : { causes: spec.causes }),
    ...(spec.purpose === undefined ? {} : { purpose: spec.purpose }),
    ...(spec.concerning === undefined ? {} : { concerning: spec.concerning }),
    createdAt: w.t(spec.start),
  });
  await w.stores.routingDecisions.put(route);
  if (spec.legacy === true) return { route, summary: undefined };

  const counters: MeasurementCounters = {
    inputTokens: spec.tokens.input,
    cacheReadTokens: spec.tokens.cacheRead,
    cacheWriteTokens: spec.tokens.cacheWrite,
    outputTokens: spec.tokens.output,
    inputIncludesCache: true,
    ...(spec.reportedUsd === undefined ? {} : { reportedUsd: spec.reportedUsd }),
  };
  const coverage = spec.coverage ?? "complete";
  const open = spec.open === true;
  const requests = Math.max(1, Math.round(spec.tokens.output / 6_000));
  const gaps = spec.gaps ?? [];
  const lost = gaps.length > 0;
  const components = componentsOf(spec.model, spec.tokens);
  const summary = MeasurementSummarySchema.parse({
    schemaVersion: 1,
    measurementVersion: 1,
    ...w.f.scope,
    measurementSummaryId: w.ids.next("meas"),
    executionNodeId: spec.node.executionNodeId,
    agentId: spec.agent.agentId,
    role: spec.agent.role,
    routingDecisionId: route.routingDecisionId,
    route: chosen,
    observedModels: [spec.model],
    segments: [
      {
        launchId: `launch-${spec.agent.agentId.slice(-4)}`,
        segment: 0,
        sessionId: `session-${spec.agent.agentId.slice(-4)}`,
        resumedSession: false,
        open,
        ...(open ? {} : { exitKind: spec.exitKind ?? "completed" }),
        counters,
        coverage,
        sources: {
          requests: counters,
          requestCount: requests,
          ...(open ? {} : { terminal: counters, terminalCoverage: lost ? "partial" : "complete" }),
          aggregateInclusion: "self",
        },
        receivedSequence: requests + 1,
        publishedSequence: open ? requests : requests + 1,
        observed: { requests, snapshots: 0, terminal: !open },
      },
    ],
    totals: counters,
    coverage,
    gaps,
    ledger: {
      chunks: 0,
      artifactIds: [],
      observationCount: requests + 1,
      publishedCount: open ? requests : requests + 1,
    },
    valuation: {
      source: spec.reportedUsd === undefined ? "estimated" : "reported",
      usd: spec.reportedUsd ?? estimated,
      ...(spec.reportedUsd === undefined ? {} : { reportedUsd: spec.reportedUsd }),
      estimatedUsd: estimated,
      basis:
        spec.reportedUsd === undefined
          ? "priced from tokens at the routing policy's rates"
          : "reported by the harness; the estimate is the same tokens at the routing policy's rates",
      priceSource: PRICE_SOURCE,
      priceVersion: PRICE_VERSION,
      components,
      completeness: {
        valuedRequests: lost ? requests - 1 : requests,
        unvaluedRequests: lost ? 1 : 0,
        remainderTokens: 0,
        remainderValued: !lost,
        reasons: lost ? ["one request's usage was lost before it was flushed"] : [],
      },
    },
    createdAt: w.t(spec.start),
    updatedAt: w.t(spec.end ?? spec.start + 1),
  });
  await w.stores.measurements.put(summary);
  w.summaries.push(summary);
  return { route, summary };
};

export const passingVerification = (
  w: World,
  node: ExecutionNode,
  agent: Agent,
  minutes: [number, number],
  commit: string,
  flaky = false,
): Verification =>
  makeVerification(w.f, node, {
    agentId: agent.agentId,
    phase: "candidate",
    commitSha: commit,
    commands: [
      { stepId: "build", command: "npm run build", exitCode: 0, durationMs: 41_000 },
      flaky
        ? {
            stepId: "test",
            command: "npm test",
            exitCode: 0,
            durationMs: 96_000,
            flaky: { firstExitCode: 1, firstDurationMs: 88_000 },
          }
        : { stepId: "test", command: "npm test", exitCode: 0, durationMs: 93_000 },
    ],
    outcome: "passed",
    startedAt: w.t(minutes[0]),
    endedAt: w.t(minutes[1]),
  });

export const failingVerification = (
  w: World,
  node: ExecutionNode,
  agent: Agent,
  minutes: [number, number],
  commit: string,
): Verification =>
  makeVerification(w.f, node, {
    agentId: agent.agentId,
    phase: "candidate",
    commitSha: commit,
    commands: [
      { stepId: "build", command: "npm run build", exitCode: 0, durationMs: 40_000 },
      { stepId: "test", command: "npm test", exitCode: 1, durationMs: 77_000 },
    ],
    outcome: "failed",
    startedAt: w.t(minutes[0]),
    endedAt: w.t(minutes[1]),
  });
