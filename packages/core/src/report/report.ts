/**
 * `docs/programs/{id}/report.md` (P7, T4; D-P7-09, SC-P7-11).
 *
 * Written **from the control plane alone**: every fact below is a record, so the
 * same report can be produced on a machine that never saw the repository (A-06),
 * and the next `plan-program` reads it when re-planning.
 *
 * It reports against the plan, in the order a human wants in the morning: what
 * happened to each strand, leading with any departure from the approach they
 * approved; the gates' health, and what the run repaired (P15, D-P15-09);
 * whether each success criterion was met, and by what; what was parked
 * and what that blocked; what is still theirs to do; and the decisions the run
 * took without them.
 *
 * Gathering reads; rendering is pure. A departure is a decision whose context
 * begins with {@link DEPARTURE_PREFIX}: a convention the strand's brief states,
 * because whether an approach was departed from is a judgement only the agent
 * that made it can record.
 */
import {
  type Agent,
  type CarriedStrand,
  type CompletionHistory,
  type ComputeUtilization,
  type Decision,
  type Dispatch,
  type EnvironmentFaultPayload,
  type Event,
  type Examination,
  type ExecutionNode,
  type ExecutionNodeId,
  type GateHealth,
  type GateHealthVerdict,
  type IsoTimestamp,
  type JobContract,
  lifecycleObservationsOf,
  type MeasurementSummary,
  type Prerequisite,
  type ProgramContract,
  type ProgramId,
  type RepairCause,
  type RoutingDecision,
  type Run,
  type RunFeedback,
  type RunId,
  type SetupStep,
  SetupStepSchema,
  type StrandPublication,
  type Verification,
  type VerificationStep,
  VerificationStepSchema,
} from "@nightshift/contracts";
import { humanDuration } from "../forecast/model.js";
import type { ProjectStores } from "../ports/stores.js";
import { type PublicationState, publicationStateOf } from "../rules/dispatch.js";
import { buildTree, descendantsOf, type ExecutionTree } from "../rules/execution-tree.js";
import type { RunScope } from "../rules/ownership.js";
import {
  blockedBy,
  prerequisitesOf,
  type StrandOutcome,
  type StrandOutcomes,
  strandAttempts,
  strandOutcomes,
  strandsOf,
} from "../rules/plan.js";
import {
  adjustmentDecisionsOf,
  type StepAdjustments,
  stepAdjustmentsOf,
} from "../rules/step-adjustments.js";
import { type CompletionReport, completionOf } from "./completion.js";
import {
  type CorrectionReport,
  type DecisionReport,
  gatherCorrections,
  gatherDecisionGraph,
  renderCorrections,
  renderDecisionGraph,
} from "./decision-graph.js";
import { type DeliveryReport, deliveryOf, type FirstAttemptFigures } from "./delivery.js";
import { environmentFaultOf, renderEnvironmentFault } from "./environment-fault.js";
import {
  type FeedbackCoverage,
  feedbackCoverageOf,
  type RunFeedbackReport,
  runFeedbackOf,
} from "./feedback.js";
import {
  type InfrastructureReport,
  infrastructureOf,
  infrastructureUnavailable,
  occupancyOf,
} from "./infrastructure.js";
import { type OperationsReport, operationsOf } from "./operations.js";
import { type ResourceTotals, resourcesOf, sumResources } from "./resources.js";
import { type OverheadRow, type ReviewReport, reviewOf } from "./review.js";
import { storyStatuses } from "./stories.js";
import { type VerificationTimeReport, verificationTimeOf } from "./verification-time.js";

export const DEPARTURE_PREFIX = "DEPARTURE:";

export interface JobReport {
  readonly nodeId: string;
  readonly objective: string;
  readonly status: string;
  readonly commitSha: string | null;
  readonly attempts: number;
  readonly reason: string | undefined;
  /** P8: every route the job's work ran on, in order, and why (D-P8-04 … D-P8-07). */
  readonly routes: readonly RoutingDecision[];
  /** P8: every examination of it, with its questions and findings (D-P8-09 … D-P8-15). */
  readonly examinations: readonly Examination[];
}

/** An arbiter's ruling (D-P8-13), and the owner's reversal of it when there is one. */
export interface RulingReport {
  readonly ruling: Decision;
  readonly nodeId: string;
  readonly finding: string;
  readonly reversedBy?: Decision;
  /** The model the arbiter ran, when its agent is on the record. */
  readonly arbiterModel?: string;
  /**
   * The side whose model the arbiter shared, as a fresh invocation, when the
   * highest tier had nothing else (D-P8-13, as amended 2026-09-26).
   */
  readonly sharesModelWith?: "examiner" | "implementer";
}

export interface StrandReport {
  readonly id: string;
  readonly name: string;
  /** `not delegated` when the run ended before anybody handed it over. */
  readonly outcome: StrandOutcome | "not delegated";
  readonly acceptance: readonly string[];
  readonly reason: string | undefined;
  readonly blockedBy: readonly string[];
  readonly jobs: readonly JobReport[];
  readonly departures: readonly Decision[];
  /**
   * P14: every node of the strand, in every attempt, its own and those under
   * it. How a node is traced to the strand, and so to its stories.
   */
  readonly nodeIds: readonly string[];
  /** How many times the strand itself was attempted. */
  readonly attempts: number;
  /** The human prerequisites its deferred work waits on (D-P7-10). Empty unless provisional. */
  readonly waitingOn: readonly string[];
  /**
   * When an earlier run of the same plan built it and this run carried it over
   * rather than build it again (`Run.carriedStrands`): which run, and what it
   * landed, all of it on the branch this run started from.
   */
  readonly carriedFrom?: { readonly runId: string; readonly landed: readonly string[] };
}

export interface UsageRow {
  readonly harness: string;
  readonly model: string;
  /** What the routes were for: the work, or an examiner, answerer or arbiter (P8). */
  readonly purpose: string;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** True when any of `costUsd` is an estimate from the price table (D-P8-08). */
  readonly estimated: boolean;
  /**
   * Routes with no dollar figure at all: the harness reported none and the
   * price table has no price for the model. Not counted in `costUsd`, so a cost
   * of 0 with routes unpriced is unknown, not free.
   */
  readonly unpriced: number;
}

export interface RunReport {
  readonly program: ProgramContract;
  readonly run: Run;
  readonly strands: readonly StrandReport[];
  readonly criteria: readonly {
    readonly id: string;
    readonly outcome: string;
    readonly met: boolean;
    readonly by: readonly string[];
  }[];
  readonly pendingPrerequisites: readonly Prerequisite[];
  /** P9: every decision the run recorded, placed, with its reversal and corrections (D-P9-08). */
  readonly graph: readonly DecisionReport[];
  /** P9: what this program corrects, when it is a correction (D-P9-06). */
  readonly corrections: readonly CorrectionReport[];
  readonly usage: readonly UsageRow[];
  /** P8: the arbiter's rulings, which lead the report (D-P8-13). */
  readonly rulings: readonly RulingReport[];
  /** Work that went on unreviewed because no examiner could review it, for a human (2026-10-13). */
  readonly unreviewed?: readonly UnreviewedReport[];
  /** P15: the gates' audit, the red base, every repair and every flake (D-P15-09). */
  readonly gateHealth: GateHealthReport;
  /** P19: the steps the run skipped or whose time it raised, which lead the report (D-05). */
  readonly stepAdjustments: StepAdjustments;
  /**
   * A remote run's landings as GitHub has them (2026-10-14): the machine lands
   * on its own clone, and only the publisher moves GitHub's copy. Absent for a
   * local run, which publishes nothing.
   */
  readonly publication?: PublicationReport;
  /** P20 S-05: where the run's time went, from lifecycle observations. */
  readonly operations: OperationsReport;
  /** P20 S-05: work items, first-attempt success, outcomes and rework. */
  readonly delivery: DeliveryReport;
  /** P20 S-05: examination coverage, dispositions and review overhead. */
  readonly review: ReviewReport;
  /** P20 S-05: the machine's lifetime and expense; absent when no dispatch or no basis. */
  readonly infrastructure?: InfrastructureReport;
  /** D-04: the human verdict on this run. */
  readonly feedback: RunFeedbackReport;
  /** D-04: how many of this program's ended runs carry a verdict. */
  readonly feedbackCoverage: FeedbackCoverage;
  /** D-05: the completion histories this run is a member of. */
  readonly completions: readonly CompletionReport[];
  /** The moment the report was gathered, to which open intervals were observed. */
  readonly asOf: IsoTimestamp;
}

export interface PublicationReport {
  readonly branch: string;
  readonly state: PublicationState;
  /**
   * A-60: each strand branch at GitHub whose work did not land on the program
   * branch: kept there, and continued by the next run of the plan.
   */
  readonly unlanded: readonly StrandPublication[];
}

/** One repair job (D-P15-03, D-P15-04): what it repaired, under which decision, and how it ended. */
export interface RepairReport {
  readonly jobContractId: string;
  readonly cause: RepairCause;
  readonly gates: readonly string[];
  readonly objective: string;
  /** Its node's status; `not delegated` when no node ever took the contract. */
  readonly status: string;
  /** The decision `repair.decisionId` names, when it is on the record. */
  readonly decision: Decision | undefined;
  /** From its `gate.repaired` event; false until it landed. */
  readonly definitionsChanged: boolean;
  /** The new setup steps, when the landing changed them. */
  readonly setup?: readonly SetupStep[];
  /** The new verification steps, when the landing changed them. */
  readonly verification?: readonly VerificationStep[];
}

/** One check that failed and then passed on a rerun on the same commit (D-P15-06). */
export interface FlakeReport {
  readonly stepId: string;
  /** `null` when the flake was in the run's end gates, which verify no job (A-57). */
  readonly jobContractId: string | null;
  readonly executionNodeId: string;
  readonly commitSha: string;
  readonly verificationId: string;
  readonly firstExitCode: number;
}

/** The run's gate health, as the report and the Studio's Status tab show it (D-P15-09). */
export interface GateHealthReport {
  /** The project's gate-health record, as planning's audit (or a later repair) left it. */
  readonly audit:
    | {
        readonly verdict: GateHealthVerdict;
        readonly commit: string;
        readonly auditedAt: string;
        readonly findings: readonly {
          readonly id: string;
          readonly rule: number;
          readonly found: string;
          readonly decisionId: string;
        }[];
      }
    | undefined;
  /** The run's `gate.red` event: the gates red on the commit it started from. */
  readonly red: { readonly baseCommit: string; readonly failing: readonly string[] } | undefined;
  /**
   * The run's `environment.fault` (P16 D-07): gates green in the laptop's
   * reference audit and red on the machine, every part's gates together.
   */
  readonly environmentFault?: EnvironmentFaultPayload | undefined;
  readonly repairs: readonly RepairReport[];
  readonly flakes: readonly FlakeReport[];
  /** Where the run's verification time went, the forecast beside it, and what would save time (P17). */
  readonly verificationTime: VerificationTimeReport;
}

interface PageOf<T> {
  readonly items: readonly T[];
  readonly cursor?: string | undefined;
}

const readAll = async <T>(
  read: (page: { cursor?: string }) => Promise<PageOf<T>>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

const firstLine = (text: string): string => {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.replace(/^#+\s*/, "").slice(0, 120);
};

/** Everything the run's records say, indexed the ways the report asks of them. */
interface Records {
  readonly program: ProgramContract;
  readonly tree: ExecutionTree;
  readonly jobOf: ReadonlyMap<string, JobContract>;
  readonly decisions: readonly Decision[];
  readonly routesOf: ReadonlyMap<string, readonly RoutingDecision[]>;
  readonly examinationsOf: ReadonlyMap<string, readonly Examination[]>;
  /** Agent id → agent, for the nodes an examination touched: who built, and who ruled. */
  readonly agentOf: ReadonlyMap<string, Agent>;
  /** Node id → the prerequisites its deferred checks wait on. */
  readonly waitingOf: ReadonlyMap<string, readonly string[]>;
  /** Every attempt at every strand, oldest first. */
  readonly strandNodes: readonly { readonly strandId: string; readonly node: ExecutionNode }[];
  readonly outcomes: StrandOutcomes;
  /** What the run carried over from an earlier run of the same plan. */
  readonly carried: readonly CarriedStrand[];
  /** P20 S-05: every agent of every node, every event and measurement summary, read once. */
  readonly agents: readonly Agent[];
  readonly events: readonly Event[];
  readonly measurements: readonly MeasurementSummary[];
  readonly dispatch: Dispatch | undefined;
  readonly utilization: ComputeUtilization | undefined;
}

const jobReportOf = (records: Records, node: ExecutionNode): JobReport => ({
  nodeId: node.executionNodeId,
  objective: firstLine(
    (node.jobContractId === null ? undefined : records.jobOf.get(node.jobContractId))?.objective ??
      "",
  ),
  status: node.status,
  commitSha: node.commitSha,
  attempts: Math.max(1, workRoutes(records.routesOf.get(node.executionNodeId) ?? []).length),
  reason: node.outcomeReason,
  routes: workRoutes(records.routesOf.get(node.executionNodeId) ?? []),
  examinations: records.examinationsOf.get(node.executionNodeId) ?? [],
});

/** A node's own attempts, in order: not its examiner's, answerer's or arbiter's routes. */
const workRoutes = (routes: readonly RoutingDecision[]): RoutingDecision[] =>
  routes.filter((route) => route.purpose === undefined).sort((a, b) => a.attempt - b.attempt);

const carriedFromOf = (records: Records, strandId: string): Pick<StrandReport, "carriedFrom"> => {
  const carried = records.carried.find((candidate) => candidate.strandId === strandId);
  return carried === undefined
    ? {}
    : { carriedFrom: { runId: carried.fromRunId, landed: carried.landed } };
};

const strandReportOf = (
  records: Records,
  strand: NonNullable<ProgramContract["strands"]>[number],
  blocked: ReadonlyMap<string, readonly string[]>,
): StrandReport => {
  const attempts = records.strandNodes.filter((entry) => entry.strandId === strand.id);
  const latest = attempts.at(-1)?.node;
  const under = latest === undefined ? [] : descendantsOf(records.tree, latest.executionNodeId);
  const inStrand = new Set([...(latest === undefined ? [] : [latest.executionNodeId]), ...under]);
  return {
    id: strand.id,
    name: strand.name,
    outcome: records.outcomes[strand.id] ?? "not delegated",
    acceptance: strand.acceptance,
    reason: latest?.outcomeReason,
    blockedBy: blocked.get(strand.id) ?? [],
    attempts: attempts.length,
    waitingOn: [...new Set([...inStrand].flatMap((id) => records.waitingOf.get(id) ?? []))].sort(),
    ...carriedFromOf(records, strand.id),
    jobs: under
      .map((id) => records.tree.nodes.get(id))
      .filter((node): node is ExecutionNode => node !== undefined && node.kind === "job")
      .map((node) => jobReportOf(records, node)),
    departures: records.decisions.filter(
      (decision) =>
        inStrand.has(decision.executionNodeId) &&
        decision.context.trimStart().startsWith(DEPARTURE_PREFIX),
    ),
    nodeIds: [
      ...new Set(
        attempts.flatMap((attempt) => [
          attempt.node.executionNodeId,
          ...descendantsOf(records.tree, attempt.node.executionNodeId),
        ]),
      ),
    ],
  };
};

const usageOf = (routes: readonly RoutingDecision[]): UsageRow[] => {
  const rows = new Map<string, UsageRow>();
  for (const route of routes) {
    const purpose = route.purpose ?? "work";
    const key = `${route.chosen.harness} / ${route.chosen.model} / ${purpose}`;
    const so = rows.get(key) ?? {
      harness: route.chosen.harness,
      model: route.chosen.model,
      purpose,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      estimated: false,
      unpriced: 0,
    };
    rows.set(key, {
      ...so,
      attempts: so.attempts + 1,
      inputTokens: so.inputTokens + (route.usage.inputTokens ?? 0),
      outputTokens: so.outputTokens + (route.usage.outputTokens ?? 0),
      costUsd: so.costUsd + (route.usage.actualCostUsd ?? route.usage.estimatedCostUsd ?? 0),
      estimated:
        so.estimated ||
        (route.usage.actualCostUsd === undefined && route.usage.estimatedCostUsd !== undefined),
      unpriced:
        so.unpriced +
        (route.usage.actualCostUsd === undefined && route.usage.estimatedCostUsd === undefined
          ? 1
          : 0),
    });
  }
  return [...rows.values()];
};

/** The model an arbiter ran, and which side's it was, when either is on the record. */
const whoRuled = (
  records: Records,
  ruling: Decision,
  examination: Examination,
): Pick<RulingReport, "arbiterModel" | "sharesModelWith"> => {
  const arbiterModel =
    ruling.agentId === null ? undefined : records.agentOf.get(ruling.agentId)?.model;
  if (arbiterModel === undefined) return {};
  if (arbiterModel === examination.examinerRoute.model) {
    return { arbiterModel, sharesModelWith: "examiner" };
  }
  const implementerModel = records.agentOf.get(examination.implementerAgentId)?.model;
  return arbiterModel === implementerModel
    ? { arbiterModel, sharesModelWith: "implementer" }
    : { arbiterModel };
};

/** One change no examiner could review: where it is, and why nobody did. */
export interface UnreviewedReport {
  readonly nodeId: string;
  readonly objective?: string;
  readonly commitSha?: string;
  readonly risk?: string;
  readonly reason: string;
}

/** The run's skipped reviews, the latest per node: what a human still has to review. */
const unreviewedOf = (records: Records): UnreviewedReport[] => {
  const { events } = records;
  const latest = new Map<string, Event>();
  for (const event of events) {
    if (event.type === "examination.skipped" && event.executionNodeId !== null) {
      latest.set(event.executionNodeId, event);
    }
  }
  return [...latest.values()].map((event) => {
    const node = records.tree.nodes.get(event.executionNodeId as never);
    const job =
      node?.jobContractId === null || node === undefined
        ? undefined
        : records.jobOf.get(node.jobContractId);
    const commitSha =
      typeof event.payload.commitSha === "string" ? event.payload.commitSha : undefined;
    const risk = typeof event.payload.risk === "string" ? event.payload.risk : undefined;
    return {
      nodeId: String(event.executionNodeId),
      ...(job === undefined ? {} : { objective: firstLine(job.objective) }),
      ...(commitSha === undefined ? {} : { commitSha }),
      ...(risk === undefined ? {} : { risk }),
      reason: String(event.payload.reason ?? "no examiner could review it"),
    };
  });
};

/** Unreviewed work, second only to the arbiter's rulings: it is the human's to review. */
const renderUnreviewed = (unreviewed: readonly UnreviewedReport[] | undefined): string[] =>
  unreviewed === undefined || unreviewed.length === 0
    ? []
    : [
        "## Not reviewed — review these",
        "",
        "No examiner could review this work, so it went on with its checks passed and nobody's review. Review it yourself:",
        "",
        ...unreviewed.map(
          (item) =>
            `- \`${item.nodeId}\`${item.objective === undefined ? "" : ` ${item.objective}`}${
              item.commitSha === undefined ? "" : ` at \`${item.commitSha.slice(0, 12)}\``
            }${item.risk === undefined ? "" : ` (${item.risk} risk)`}: ${item.reason}`,
        ),
        "",
      ];

/** The arbiter's rulings, from the examinations that cite them, with any human reversal (D-P8-13). */
const rulingsOf = (records: Records): RulingReport[] => {
  const byId = new Map(
    records.decisions.map((decision) => [decision.decisionId as string, decision]),
  );
  const cited = [...records.examinationsOf].flatMap(([nodeId, examinations]) =>
    examinations.flatMap((examination) =>
      examination.findings.map((finding) => ({ nodeId, finding, examination })),
    ),
  );
  return cited.flatMap(({ nodeId, finding, examination }) => {
    const decisionId = finding.resolvedBy?.decisionId;
    const ruling = decisionId === undefined ? undefined : byId.get(decisionId);
    if (ruling === undefined || ruling.authority !== "agent") return [];
    const reversedBy = records.decisions.find(
      (decision) => decision.supersedesDecisionId === ruling.decisionId,
    );
    return [
      {
        ruling,
        nodeId,
        finding: `${finding.id} ${finding.summary}`,
        ...(reversedBy === undefined ? {} : { reversedBy }),
        ...whoRuled(records, ruling, examination),
      } satisfies RulingReport,
    ];
  });
};

const readRecords = async (
  stores: ProjectStores,
  scope: RunScope,
  program: ProgramContract,
  carried: readonly CarriedStrand[],
): Promise<Records> => {
  const nodes = await readAll<ExecutionNode>((page) =>
    stores.executionNodes.listByRun(scope, page),
  );
  const jobs = await readAll<JobContract>((page) => stores.jobContracts.listByRun(scope, page));
  const decisions = await readAll<Decision>((page) => stores.decisions.listByRun(scope, page));
  const jobOf = new Map(jobs.map((job) => [job.jobContractId as string, job]));
  const events = await readAll<Event>((page) => stores.events.listByRun(scope, page));
  const measurements = await readAll<MeasurementSummary>((page) =>
    stores.measurements.listByRun(scope, page),
  );
  const dispatch = await stores.dispatches.get(scope).catch(() => undefined);
  const utilization = await stores.computeUtilizations.get(scope).catch(() => undefined);
  const agents: Agent[] = [];

  const routesOf = new Map<string, readonly RoutingDecision[]>();
  const examinationsOf = new Map<string, readonly Examination[]>();
  const agentOf = new Map<string, Agent>();
  for (const node of nodes) {
    const nodeAgents = await stores.agents.listByNode(scope, node.executionNodeId);
    agents.push(...nodeAgents);
    if (node.parentNodeId === null) continue;
    routesOf.set(
      node.executionNodeId,
      await stores.routingDecisions.listByNode(scope, node.executionNodeId),
    );
    if (node.kind !== "job") continue;
    const examinations = await stores.examinations.listByNode(scope, node.executionNodeId);
    if (examinations.length > 0) {
      for (const agent of nodeAgents) {
        agentOf.set(agent.agentId, agent);
      }
      examinationsOf.set(
        node.executionNodeId,
        [...examinations].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    }
  }

  // Why a deferred node waits is in its Verification, not on the node: a
  // deferral is not an outcome.
  const waitingOf = new Map<string, readonly string[]>();
  for (const node of nodes.filter((candidate) => candidate.status === "deferred")) {
    const latest = (await stores.verifications.listByNode(scope, node.executionNodeId)).at(-1);
    waitingOf.set(
      node.executionNodeId,
      (latest?.commands ?? []).flatMap((command) =>
        command.deferred === undefined ? [] : [command.deferred.prerequisiteId],
      ),
    );
  }

  const strandNodes = nodes
    .flatMap((node) => {
      const strandId =
        node.jobContractId === null ? undefined : jobOf.get(node.jobContractId)?.strandId;
      return strandId === undefined ? [] : [{ strandId, node }];
    })
    .sort((a, b) => a.node.createdAt.localeCompare(b.node.createdAt));
  const outcomes = strandOutcomes(
    strandAttempts(
      nodes,
      new Map(
        jobs.flatMap((job) =>
          job.strandId === undefined ? [] : [[job.jobContractId, job.strandId]],
        ),
      ),
    ),
    carried,
  );
  return {
    program,
    tree: buildTree(nodes),
    jobOf,
    decisions,
    routesOf,
    examinationsOf,
    agentOf,
    waitingOf,
    strandNodes,
    outcomes,
    carried,
    agents,
    events,
    measurements,
    dispatch,
    utilization,
  };
};

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const auditOf = (record: GateHealth | undefined): GateHealthReport["audit"] =>
  record === undefined
    ? undefined
    : {
        verdict: record.verdict,
        commit: record.commit,
        auditedAt: record.auditedAt,
        findings: record.findings.map(({ id, rule, found, decisionId }) => ({
          id,
          rule,
          found,
          decisionId,
        })),
      };

/** The new gate definitions a `gate.repaired` event carries, when it changed them. */
const definitionsOf = (
  payload: Readonly<Record<string, unknown>>,
): Pick<RepairReport, "definitionsChanged" | "setup" | "verification"> => {
  if (payload.definitionsChanged !== true) return { definitionsChanged: false };
  const setup = SetupStepSchema.array().safeParse(payload.setup);
  const verification = VerificationStepSchema.array().safeParse(payload.verification);
  return {
    definitionsChanged: true,
    ...(setup.success ? { setup: setup.data } : {}),
    ...(verification.success ? { verification: verification.data } : {}),
  };
};

/**
 * The run's gate health (D-P15-09): the project's record, the run's red base,
 * every job contract that is a repair with its node and decision, and every
 * check a verification recorded as flaky.
 */
const gatherGateHealth = async (
  stores: ProjectStores,
  scope: RunScope,
  records: Records,
  nodes: readonly ExecutionNode[],
  verifications: readonly Verification[],
): Promise<GateHealthReport> => {
  const { events } = records;
  let red: GateHealthReport["red"];
  const repaired = new Map<string, Readonly<Record<string, unknown>>>();
  for (const event of events) {
    if (event.type === "gate.red") {
      red = {
        baseCommit: String(event.payload.baseCommit ?? ""),
        failing: [...new Set([...(red?.failing ?? []), ...stringsOf(event.payload.failing)])],
      };
    }
    if (event.type === "gate.repaired") {
      repaired.set(String(event.payload.jobContractId), event.payload);
    }
  }

  const byId = new Map(
    records.decisions.map((decision) => [decision.decisionId as string, decision]),
  );
  const repairs = [...records.jobOf.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((job): RepairReport[] => {
      if (job.repair === undefined) return [];
      const node = nodes
        .filter((candidate) => candidate.jobContractId === job.jobContractId)
        .at(-1);
      const landed = repaired.get(job.jobContractId);
      return [
        {
          jobContractId: job.jobContractId,
          cause: job.repair.cause,
          gates: job.repair.gates,
          objective: firstLine(job.objective),
          status: node?.status ?? "not delegated",
          decision: byId.get(job.repair.decisionId),
          ...(landed === undefined ? { definitionsChanged: false } : definitionsOf(landed)),
        },
      ];
    });

  const flakes = [...verifications]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .flatMap((verification) =>
      verification.commands.flatMap((command): FlakeReport[] =>
        command.flaky === undefined
          ? []
          : [
              {
                stepId: command.stepId,
                jobContractId: verification.jobContractId,
                executionNodeId: verification.executionNodeId,
                commitSha: verification.commitSha,
                verificationId: verification.verificationId,
                firstExitCode: command.flaky.firstExitCode,
              },
            ],
      ),
    );

  const environmentFault = environmentFaultOf(events);
  const record = await stores.gateHealth.get(scope.projectId);
  const landings = nodes.filter(
    (node) => node.kind === "job" && node.status === "integrated",
  ).length;
  return {
    audit: auditOf(record),
    red,
    ...(environmentFault === undefined ? {} : { environmentFault }),
    repairs,
    flakes,
    verificationTime: verificationTimeOf(
      records.program,
      verifications,
      landings,
      record?.forecast,
    ),
  };
};

/** Every node's verifications: the jobs' queue and candidate checks, and the program node's end gates (A-57). */
const gatherVerifications = async (
  stores: ProjectStores,
  scope: RunScope,
  nodes: readonly ExecutionNode[],
): Promise<Verification[]> => {
  const verifications: Verification[] = [];
  for (const node of nodes) {
    verifications.push(...(await stores.verifications.listByNode(scope, node.executionNodeId)));
  }
  return verifications;
};

export const gatherReport = async (stores: ProjectStores, scope: RunScope): Promise<RunReport> => {
  const program = await stores.programContracts.get(scope.projectId, scope.programId);
  const run = await stores.runs.get(scope, scope.runId);
  if (program === undefined || run === undefined) {
    throw new Error(`run ${scope.runId} or its program is not in the control plane`);
  }
  const records = await readRecords(stores, scope, program, run.carriedStrands ?? []);
  const blocked = blockedBy(program, records.outcomes);
  const strands = strandsOf(program).map((strand) => strandReportOf(records, strand, blocked));
  const rulings = rulingsOf(records);
  const unreviewed = unreviewedOf(records);
  const nodes = [...records.tree.nodes.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const verifications = await gatherVerifications(stores, scope, nodes);

  const p20 = p20Of(records, run, nodes, verifications);
  const feedbackSections = await feedbackSectionsOf(stores, scope, run, p20.asOf, {
    resources: resourcesOfRoutes([...records.routesOf.values()].flat(), records.measurements),
    ...(p20.infrastructure === undefined ? {} : { infrastructure: p20.infrastructure }),
  });

  return {
    program,
    run,
    strands,
    criteria: program.successCriteria.map((criterion) => {
      const by = strandsOf(program)
        .filter((strand) => strand.successCriteria.includes(criterion.id))
        .map((strand) => strand.id);
      return {
        id: criterion.id,
        outcome: criterion.outcome,
        by,
        met: by.length > 0 && by.every((id) => records.outcomes[id] === "succeeded"),
      };
    }),
    pendingPrerequisites: prerequisitesOf(program).filter((p) => p.status !== "satisfied"),
    graph: await gatherDecisionGraph(
      stores,
      scope,
      records.decisions,
      records.tree.nodes,
      records.jobOf,
    ),
    corrections: await gatherCorrections(stores, program),
    usage: usageOf([...records.routesOf.values()].flat()),
    rulings,
    unreviewed,
    gateHealth: await gatherGateHealth(stores, scope, records, nodes, verifications),
    stepAdjustments: stepAdjustmentsOf(
      program.verification,
      adjustmentDecisionsOf(
        records.decisions,
        (nodeId) => records.tree.nodes.get(nodeId as ExecutionNodeId)?.kind,
      ),
      verifications,
      { maxWallClockSeconds: program.costPolicy?.maxWallClockSeconds },
    ),
    ...publicationOf(records.dispatch, program.repository.programBranch),
    ...p20,
    ...feedbackSections,
  };
};

interface MemberFigures {
  readonly resources?: ResourceTotals;
  readonly infrastructure?: InfrastructureReport;
}

const resourcesOfRoutes = (
  routes: readonly RoutingDecision[],
  measurements: readonly MeasurementSummary[],
): ResourceTotals => sumResources(routes.map((route) => resourcesOf(route, measurements)));

/** Every agent and (non-root) routing decision of the nodes; absent when any read was refused. */
const nodeRecordsOf = async (
  stores: ProjectStores,
  scope: RunScope,
  nodes: readonly ExecutionNode[] | undefined,
): Promise<{ agents?: Agent[]; routes?: RoutingDecision[] }> => {
  if (nodes === undefined) return {};
  const agents: Agent[] = [];
  const routes: RoutingDecision[] = [];
  for (const node of nodes) {
    const nodeAgents = await (async () =>
      stores.agents.listByNode(scope, node.executionNodeId))().catch(() => undefined);
    if (nodeAgents === undefined) return {};
    agents.push(...nodeAgents);
    if (node.parentNodeId === null) continue;
    const nodeRoutes = await (async () =>
      stores.routingDecisions.listByNode(scope, node.executionNodeId))().catch(() => undefined);
    if (nodeRoutes === undefined) return {};
    routes.push(...nodeRoutes);
  }
  return { agents, routes };
};

/**
 * One completion member run's model and machine figures. Every read is
 * tolerated: a figure whose records could not all be read is absent, not zero.
 * Without occupancy the machine figures carry `infrastructureOf`'s legacy coverage.
 */
const memberFiguresOf = async (
  stores: ProjectStores,
  scope: RunScope,
  run: Run,
  asOf: IsoTimestamp,
): Promise<MemberFigures> => {
  const nodes = await (async () =>
    readAll<ExecutionNode>((page) => stores.executionNodes.listByRun(scope, page)))().catch(
    () => undefined,
  );
  const measurements = await (async () =>
    readAll<MeasurementSummary>((page) => stores.measurements.listByRun(scope, page)))().catch(
    () => undefined,
  );
  const dispatch = await (async () => stores.dispatches.get(scope))().catch(() => undefined);
  const utilization = await (async () => stores.computeUtilizations.get(scope))().catch(
    () => undefined,
  );
  const { agents, routes } = await nodeRecordsOf(stores, scope, nodes);
  const infrastructure =
    agents === undefined
      ? undefined
      : infrastructureOf({
          run,
          ...(dispatch === undefined ? {} : { dispatch }),
          ...(utilization === undefined ? {} : { utilization }),
          agents,
          asOf,
        });
  return {
    ...(routes === undefined || measurements === undefined
      ? {}
      : { resources: resourcesOfRoutes(routes, measurements) }),
    ...(infrastructure === undefined ? {} : { infrastructure }),
  };
};

/**
 * D-04/D-05 reads. Each is tolerated: an execution principal that is refused,
 * or a control plane older than these stores, still gets its report.
 */
const feedbackSectionsOf = async (
  stores: ProjectStores,
  scope: RunScope,
  run: Run,
  asOf: IsoTimestamp,
  current: MemberFigures,
): Promise<Pick<RunReport, "feedback" | "feedbackCoverage" | "completions">> => {
  const own = await (async () => stores.feedback.get(scope))().catch(() => undefined);
  const programRuns = await readAll<Run>((page) => stores.runs.listByProgram(scope, page)).catch(
    () => [run],
  );
  const programFeedback = await readAll<RunFeedback>((page) =>
    stores.feedback.listByProgram(scope, page),
  ).catch(() => (own === undefined ? [] : [own]));
  const histories = await readAll<CompletionHistory>((page) =>
    stores.completionHistories.listByProject(scope.projectId, page),
  ).catch(() => []);
  const mine = histories.filter((history) =>
    history.members.some((m) => m.programId === scope.programId && m.runId === scope.runId),
  );
  const runs = new Map<string, Run>();
  const feedback = new Map<string, RunFeedback>();
  const resources = new Map<string, ResourceTotals>();
  const infrastructure = new Map<string, InfrastructureReport>();
  const self = `${scope.programId}/${scope.runId}`;
  // A checkpoint is computed from its own snapshot, so a run since removed from
  // the history is still gathered; each run is read once across histories.
  for (const member of new Set(
    mine.flatMap((h) =>
      [h.members, ...h.checkpoints.map((c) => c.members)].flatMap((ms) =>
        ms.map((m) => `${m.programId}/${m.runId}`),
      ),
    ),
  )) {
    const [programId, runId] = member.split("/") as [ProgramId, RunId];
    const memberScope = { projectId: scope.projectId, programId, runId };
    const found = await (async () => stores.runs.get(memberScope, runId))().catch(() => undefined);
    if (found !== undefined) runs.set(member, found);
    const verdict = await (async () => stores.feedback.get(memberScope))().catch(() => undefined);
    if (verdict !== undefined) feedback.set(member, verdict);
    if (found === undefined) continue;
    const figures =
      member === self ? current : await memberFiguresOf(stores, memberScope, found, asOf);
    if (figures.resources !== undefined) resources.set(member, figures.resources);
    if (figures.infrastructure !== undefined) infrastructure.set(member, figures.infrastructure);
  }
  return {
    feedback: runFeedbackOf(run, own),
    feedbackCoverage: feedbackCoverageOf(programRuns, programFeedback),
    completions: mine.map((history) =>
      completionOf({ history, runs, feedback, resources, infrastructure, asOf }),
    ),
  };
};

/**
 * The newest timestamp on any record read. `gatherReport` has no clock (core
 * is offline and the stores carry none), so the report's `asOf` is taken from
 * the newest record rather than from the wall clock.
 */
const newestOf = (
  run: Run,
  records: Records,
  verifications: readonly Verification[],
): IsoTimestamp => {
  const stamps: string[] = [run.startedAt];
  if (run.endedAt !== undefined) stamps.push(run.endedAt);
  for (const node of records.tree.nodes.values()) stamps.push(node.createdAt);
  for (const event of records.events) stamps.push(event.occurredAt, event.recordedAt);
  for (const agent of records.agents) {
    stamps.push(agent.createdAt);
    if (agent.startedAt !== undefined) stamps.push(agent.startedAt);
    if (agent.endedAt !== undefined) stamps.push(agent.endedAt);
  }
  for (const verification of verifications) {
    stamps.push(verification.startedAt);
    if (verification.endedAt !== undefined) stamps.push(verification.endedAt);
  }
  return stamps.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) as IsoTimestamp;
};

/** The S-05 reducers over what `readRecords` already read: no store is read twice. */
const p20Of = (
  records: Records,
  run: Run,
  nodes: readonly ExecutionNode[],
  verifications: readonly Verification[],
): Pick<RunReport, "operations" | "delivery" | "review" | "infrastructure" | "asOf"> => {
  const asOf = newestOf(run, records, verifications);
  const jobs = [...records.jobOf.values()];
  const routes = [...records.routesOf.values()].flat();
  const examinations = [...records.examinationsOf.values()].flat();
  const operations = operationsOf({
    run,
    nodes,
    jobs,
    agents: records.agents,
    routes,
    verifications,
    examinations,
    observations: lifecycleObservationsOf(records.events),
    asOf,
  });
  const occupancy = occupancyOf({ operations, agents: records.agents, asOf });
  const infrastructure = infrastructureOf({
    run,
    ...(records.dispatch === undefined ? {} : { dispatch: records.dispatch }),
    ...(records.utilization === undefined ? {} : { utilization: records.utilization }),
    agents: records.agents,
    occupancy,
    asOf,
  });
  return {
    operations,
    delivery: deliveryOf({
      nodes,
      jobs,
      routes,
      verifications,
      measurements: records.measurements,
    }),
    review: reviewOf({
      nodes,
      jobs,
      routes,
      examinations,
      decisions: records.decisions,
      agents: records.agents,
      measurements: records.measurements,
      events: records.events,
    }),
    ...(infrastructure === undefined ? {} : { infrastructure }),
    asOf,
  };
};

const publicationOf = (
  dispatch: Dispatch | undefined,
  branch: string,
): { readonly publication?: PublicationReport } => {
  if (dispatch === undefined) return {};
  const landed = new Set([
    ...dispatch.publication.intents.map((intent) => intent.head),
    ...(dispatch.publication.head === undefined ? [] : [dispatch.publication.head]),
  ]);
  const unlanded = (dispatch.publication.strands ?? []).filter(
    (strand) => !landed.has(strand.head),
  );
  return { publication: { branch, state: publicationStateOf(dispatch.publication), unlanded } };
};

/** A-60: where the work of strands that did not land is kept. */
const renderUnlanded = (unlanded: readonly StrandPublication[]): string[] =>
  unlanded.length === 0
    ? []
    : [
        "## Work that did not land is kept at GitHub",
        "",
        "The next run of this plan continues each of these strands from its branch rather than building it again.",
        "",
        "| Branch | Head | State |",
        "|---|---|---|",
        ...unlanded.map(
          (strand) =>
            `| \`${strand.branch}\` | \`${strand.head.slice(0, 12)}\` | ${strand.status === "published" ? "at GitHub" : cell(`${strand.status}${strand.detail === undefined ? "" : `: ${strand.detail}`}`)} |`,
        ),
        "",
      ];

/**
 * Whether GitHub has the run's work, said before anything else: a run whose
 * landings are not all at GitHub has not delivered, whatever its strands did.
 */
const renderPublication = (publication: PublicationReport | undefined): string[] => {
  if (publication === undefined) return [];
  return [...renderLandings(publication), ...renderUnlanded(publication.unlanded)];
};

const renderLandings = (publication: PublicationReport): string[] => {
  const { branch, state } = publication;
  if (state.kind === "none") return [];
  if (state.kind === "published") {
    return [
      `GitHub has every landing: \`${branch}\` is at \`${state.head?.slice(0, 12) ?? "?"}\`.`,
      "",
    ];
  }
  const count = state.unpublished.length;
  const landings = `${count} landing${count === 1 ? "" : "s"}`;
  return [
    "## NOT ON GITHUB — read this first",
    "",
    state.kind === "blocked"
      ? `${landings} of this run are not on GitHub's \`${branch}\`. ${state.blocked ?? ""}`.trimEnd()
      : `${landings} of this run were still waiting for the publisher when this report was written.`,
    "",
    `GitHub's \`${branch}\` is at \`${state.head?.slice(0, 12) ?? "the run's base"}\`; the run's work ends at \`${state.tip?.slice(0, 12) ?? "?"}\`.`,
    "Every landing is kept in the run's stored bundles. Once the cause is fixed, `nightshift resume <program>` publishes them in order; no machine is needed.",
    "",
    "| Landing | State | Why |",
    "|---|---|---|",
    ...state.unpublished.map(
      (intent) =>
        `| \`${intent.head.slice(0, 12)}\` | ${intent.status} | ${cell(intent.status === "held" ? "behind the block above" : (intent.detail ?? ""))} |`,
    ),
    "",
  ];
};

// --- rendering ----------------------------------------------------------------

const OUTCOME_WORD: Readonly<Record<StrandReport["outcome"], string>> = {
  succeeded: "succeeded",
  provisional: "PROVISIONAL (checks deferred for a human prerequisite; not on the program branch)",
  failed: "PARKED (failed)",
  cancelled: "PARKED (cancelled)",
  running: "unfinished",
  pending: "unfinished",
  "not delegated": "never delegated",
};

const cell = (text: string): string => text.replace(/\|/g, "/").replace(/\n/g, " ");

const renderDecision = (decision: Decision): string[] => [
  `- **${decision.context.replace(DEPARTURE_PREFIX, "").trim()}**`,
  `  Chose: ${decision.choice}`,
  `  Why: ${decision.rationale}`,
];

const duration = (run: Run): string => {
  if (run.endedAt === undefined) return "not ended";
  const seconds = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${seconds % 60} s`;
};

/** Where a route sat: its role's choice (D-RR-01), or the ladder of a route made before. */
const placeOf = (route: RoutingDecision): string | undefined => {
  if (route.position !== undefined) return `${route.role ?? "?"}'s choice ${route.position + 1}`;
  if (route.ladder !== undefined) return `${route.ladder}, ${route.rung?.tier ?? "?"}`;
  return undefined;
};

/** One route, as a reader wants it: where, by which rule, and how it ended. */
const describeRoute = (route: RoutingDecision): string => {
  const place = placeOf(route);
  const effort = route.chosen.effort === undefined ? "" : `, ${route.chosen.effort} effort`;
  const where =
    place === undefined ? route.chosen.model : `${route.chosen.model} (${place}${effort})`;
  const how = route.wasOverride ? "pinned" : route.ruleId;
  return `${where} by ${how}: ${route.outcome}`;
};

const renderRoutes = (job: JobReport): string[] =>
  job.routes.length <= 1 && job.routes.every((route) => route.outcome !== "unavailable")
    ? job.routes.map((route) => `  - Route: ${describeRoute(route)}`)
    : [
        "  - Routes, in order (a fallback is `unavailable`; a climb follows a failure):",
        ...job.routes.map((route, index) => `    ${index + 1}. ${describeRoute(route)}`),
      ];

const renderExaminations = (job: JobReport): string[] =>
  job.examinations.flatMap((examination) => [
    `  - Examined by ${examination.examinerRoute.model}${examination.fixAttempt > 0 ? ` (fix ${examination.fixAttempt})` : ""}: ${examination.outcome}${examination.blocking ? ", blocking" : ", advisory"}${examination.independenceWaived === undefined ? "" : ` (independence waived: ${examination.independenceWaived.reason})`}`,
    ...examination.questions.map(
      (qa) =>
        `    - Asked: ${qa.question} Answered (${qa.answeredBy === "resumed_session" ? "resumed session" : "from its transcript"}): ${qa.answer}`,
    ),
    ...examination.findings.map(
      (finding) =>
        `    - ${finding.id} ${finding.severity}: ${finding.summary} (${finding.resolution})`,
    ),
  ]);

const renderJobs = (strand: StrandReport): string[] => {
  if (strand.jobs.length === 0) {
    return [
      strand.outcome === "succeeded" ? "Ran as a single job." : "No jobs were delegated.",
      "",
    ];
  }
  const detail = strand.jobs.flatMap((job) => {
    const lines = [...renderRoutes(job), ...renderExaminations(job)];
    return lines.length === 0 ? [] : [`- ${cell(job.objective)}`, ...lines];
  });
  return [
    "| Job | Status | Commit | Attempts |",
    "|---|---|---|---|",
    ...strand.jobs.map((job) => {
      const why = job.reason === undefined ? "" : ` (${cell(job.reason).slice(0, 100)})`;
      return `| ${cell(job.objective)} | ${job.status}${why} | ${job.commitSha?.slice(0, 8) ?? ""} | ${job.attempts} |`;
    }),
    "",
    ...(detail.length === 0 ? [] : [...detail, ""]),
  ];
};

/**
 * The arbiter's rulings, first in the report (D-P8-13): each is a decision an
 * agent made that the owner can reverse, and before P9 reversing one replays
 * nothing.
 */
/**
 * How often an arbiter that shared a side's model sided with that side (the
 * owner's question, 2026-09-26): with the examiner, it upheld; with the builder,
 * it overturned.
 */
const renderAgreement = (rulings: readonly RulingReport[]): string[] => {
  const sharing = rulings.filter((ruling) => ruling.sharesModelWith !== undefined);
  if (sharing.length === 0) return [];
  const agreed = sharing.filter(
    ({ ruling, sharesModelWith }) =>
      (sharesModelWith === "examiner") === (ruling.choice === "uphold"),
  ).length;
  return [
    `${sharing.length} of these rulings came from an arbiter on one side's own model, in a fresh`,
    `context; it sided with that side ${agreed} of ${sharing.length} time(s).`,
    "",
  ];
};

const byWhom = ({
  arbiterModel,
  sharesModelWith,
}: Pick<RulingReport, "arbiterModel" | "sharesModelWith">): string => {
  if (arbiterModel === undefined) return "";
  if (sharesModelWith === undefined) return ` by ${arbiterModel}`;
  const side = sharesModelWith === "examiner" ? "examiner's" : "builder's";
  return ` by ${arbiterModel}, the ${side} model in a fresh context`;
};

const renderRulings = (rulings: readonly RulingReport[]): string[] =>
  rulings.length === 0
    ? []
    : [
        "## Arbiter rulings — read these first",
        "",
        "An arbiter ruled on these disputed findings. Each ruling is yours to reverse with",
        "`nightshift ruling reverse <program> <decisionId> --reason …`. Reversing one records",
        "your decision and replays nothing: an overturn's work stays landed and an uphold's ruling",
        "stays carried out until the decision graph (P9); roll back by hand from the checkpoint named.",
        "",
        ...renderAgreement(rulings),
        ...rulings.flatMap(({ ruling, nodeId, finding, reversedBy, ...who }) => [
          `- **${ruling.choice === "overturn" ? "Overturned" : "Upheld"}**${byWhom(who)} ${finding} on ${nodeId}: ${ruling.rationale}`,
          `  Decision \`${ruling.decisionId}\`, made against checkpoint \`${ruling.checkpointBefore}\`${ruling.checkpointAfter === undefined ? "" : `, landed at \`${ruling.checkpointAfter}\``}.`,
          ...(reversedBy === undefined ? [] : [`  Reversed by you: ${reversedBy.rationale}`]),
        ]),
        "",
      ];

const renderStrand = (strand: StrandReport): string[] => {
  const blockedNote =
    strand.blockedBy.length === 0 ? "" : `, blocked by ${strand.blockedBy.join(", ")}`;
  return [
    `### ${strand.id} ${strand.name}: ${OUTCOME_WORD[strand.outcome]}${blockedNote}`,
    "",
    ...(strand.carriedFrom === undefined
      ? []
      : [
          `Carried over from run \`${strand.carriedFrom.runId}\`, which built it under this same ` +
            `plan; this run did not build it again. ${strand.carriedFrom.landed.length} landed ` +
            `commit${strand.carriedFrom.landed.length === 1 ? "" : "s"}, all on the branch this run started from` +
            (strand.carriedFrom.landed.length === 0
              ? "."
              : `: ${strand.carriedFrom.landed.map((sha) => sha.slice(0, 8)).join(", ")}.`),
          "",
        ]),
    // First, because it is what the human most needs to know about a strand.
    ...(strand.departures.length === 0
      ? []
      : [
          "**Departed from the plan's approach:**",
          "",
          ...strand.departures.flatMap(renderDecision),
          "",
        ]),
    ...(strand.reason === undefined ? [] : [`Why: ${strand.reason}`, ""]),
    ...(strand.outcome !== "provisional"
      ? []
      : [
          `Waiting on: ${strand.waitingOn.length === 0 ? "work it was built on, whose own checks are deferred" : strand.waitingOn.join(", ")}`,
          "",
        ]),
    "Acceptance, as planned:",
    ...strand.acceptance.map((item) => `- ${item}`),
    "",
    ...(strand.attempts > 1 ? [`Attempts at the strand: ${strand.attempts}`, ""] : []),
    ...renderJobs(strand),
  ];
};

/**
 * Every departure from the plan's approach, by strand, ahead of everything
 * else about the strands (SC-P7-11): what the human most needs to know.
 */
const renderDepartures = (strands: readonly StrandReport[]): string[] => {
  const departed = strands.filter((strand) => strand.departures.length > 0);
  return departed.length === 0
    ? []
    : [
        "## Departures from the plan",
        "",
        ...departed.flatMap((strand) => [
          `**${strand.id} ${strand.name}**`,
          "",
          ...strand.departures.flatMap(renderDecision),
          "",
        ]),
      ];
};

const CAUSE_WORD: Readonly<Record<RepairCause, string>> = {
  red_base: "red base",
  flaky: "flaky",
};

const renderSteps = (title: string, steps: readonly { id: string; command: string }[]) => [
  `  - ${title}:`,
  ...steps.map((step) => `    - \`${step.id}\`: \`${step.command}\``),
];

const renderRepair = (repair: RepairReport): string[] => [
  `- **Repair \`${repair.jobContractId}\`** (${CAUSE_WORD[repair.cause]}) of ${repair.gates.join(", ")}: ${repair.status}`,
  `  ${repair.objective}`,
  ...(repair.decision === undefined
    ? ["  Decision: not on the record."]
    : [
        `  Decision \`${repair.decision.decisionId}\`: ${repair.decision.choice}`,
        `  Why: ${repair.decision.rationale}`,
      ]),
  ...(repair.definitionsChanged
    ? [
        "  New gate definitions; every later verification uses them:",
        ...(repair.setup === undefined ? [] : renderSteps("Setup", repair.setup)),
        ...(repair.verification === undefined
          ? []
          : renderSteps("Verification", repair.verification)),
      ]
    : []),
];

/**
 * Gate health (D-P15-09): the project's audit, whether the run started red,
 * an environment fault side by side (P16 D-07), what it repaired under which decision, and every check that flaked. Repair
 * jobs sit outside every strand, so this is the only place they appear.
 */
/**
 * Where the verification time went (P17, D-P17-07): each step's runs and total
 * by phase, the forecast's one run beside it, and the recommendations re-priced
 * with this run's durations. Nothing when nothing was verified.
 */
const renderVerificationTime = (time: VerificationTimeReport): string[] => {
  if (time.verifications === 0) return [];
  const forecast = time.forecast;
  return [
    "### Verification time",
    "",
    `${humanDuration(time.totalMs)} across ${time.verifications} verification${time.verifications === 1 ? "" : "s"} and ${time.landings} landing${time.landings === 1 ? "" : "s"}` +
      (forecast === undefined
        ? "."
        : `; the forecast assumed ${forecast.landings} landings at ${humanDuration(forecast.landingMs)} each, ≈ ${humanDuration(forecast.projectedMs)}, measured on ${forecast.machine}.`),
    "",
    "| Step | Runs | Total | Per run | Quiet start | Queue / candidate / end | Forecast per run |",
    "|------|------|-------|---------|-------------|-------------------------|------------------|",
    ...time.steps.map((step) => {
      const per = step.runs === 0 ? "—" : humanDuration(step.totalMs / step.runs);
      const quiet = step.runs === 0 ? "—" : humanDuration(step.quietMs / step.runs);
      const phases = `${step.byPhase.queue.runs} / ${step.byPhase.candidate.runs} / ${step.byPhase.run.runs}`;
      const forecastPer = step.forecastMs === undefined ? "—" : humanDuration(step.forecastMs);
      return `| \`${step.id}\` | ${step.runs} | ${humanDuration(step.totalMs)} | ${per} | ${quiet} | ${phases} | ${forecastPer} |`;
    }),
    "",
    ...(time.recommendations.length === 0
      ? [
          forecast === undefined
            ? "No recommendations: run `nightshift gates <program> --record` before a run to keep what the gates resolve to, and the report prices them here."
            : "No recommendations from the catalogue for this run's durations.",
          "",
        ]
      : [
          "Recommendations, priced with this run's durations:",
          "",
          ...time.recommendations.map(
            (recommendation) =>
              `- **${recommendation.title}**${recommendation.rule === undefined ? "" : ` (rule ${recommendation.rule})`}: saves ≈ ${humanDuration(recommendation.savingMs ?? 0)} — ${recommendation.formula}. ${recommendation.evidence.join("; ")}. Fix: ${recommendation.fix}.` +
              (recommendation.edit === undefined
                ? ""
                : ` Edit the contract: on \`${recommendation.edit.stepId}\`, set ${Object.entries(
                    recommendation.edit.set,
                  )
                    .map(([key, value]) => `\`"${key}": "${value}"\``)
                    .join(", ")}.`),
          ),
          "",
        ]),
  ];
};

const renderGateHealth = ({
  audit,
  red,
  environmentFault,
  repairs,
  flakes,
  verificationTime,
}: GateHealthReport): string[] => {
  if (
    audit === undefined &&
    red === undefined &&
    environmentFault === undefined &&
    repairs.length === 0 &&
    flakes.length === 0 &&
    verificationTime.verifications === 0
  ) {
    return [
      "## Gate health",
      "",
      "No gate-health record, no red base, no repairs and no flakes.",
      "",
    ];
  }
  return [
    "## Gate health",
    "",
    audit === undefined
      ? "Audit: no gate-health record for this project."
      : `Audit: **${audit.verdict}** at \`${audit.commit.slice(0, 8)}\`, ${audit.auditedAt}${audit.findings.length === 0 ? "." : ":"}`,
    ...(audit?.findings ?? []).map(
      (finding) =>
        `- ${finding.id} (rule ${finding.rule}): ${finding.found} Decided by \`${finding.decisionId}\`.`,
    ),
    "",
    ...(red === undefined
      ? []
      : [
          `The base was red: ${red.failing.join(", ")} failed on \`${red.baseCommit.slice(0, 8)}\`, so the run repaired it before the strands.`,
          "",
        ]),
    ...(environmentFault === undefined ? [] : renderEnvironmentFault(environmentFault)),
    ...(repairs.length === 0 ? [] : ["Repairs:", "", ...repairs.flatMap(renderRepair), ""]),
    ...(flakes.length === 0
      ? []
      : [
          "Flakes (each failed, then passed on a rerun of the same commit):",
          "",
          ...flakes.map(
            (flake) =>
              `- \`${flake.stepId}\` ${flake.jobContractId === null ? "in the end gates" : `on job \`${flake.jobContractId}\``} (node \`${flake.executionNodeId}\`) at \`${flake.commitSha.slice(0, 8)}\`: first run exited ${flake.firstExitCode}; verification \`${flake.verificationId}\`.`,
          ),
          "",
        ]),
    ...renderVerificationTime(verificationTime),
  ];
};

const isParked = (strand: StrandReport): boolean =>
  strand.outcome === "failed" || strand.outcome === "cancelled";

const renderParked = (strands: readonly StrandReport[]): string[] => {
  const parked = strands.filter(isParked);
  if (parked.length === 0) return ["Nothing was parked.", ""];
  return [
    ...parked.map((strand) => {
      const cause =
        strand.blockedBy.length > 0
          ? `blocked by ${strand.blockedBy.join(", ")}, so it was never started`
          : (strand.reason ?? "no reason was recorded");
      return `- **${strand.id} ${strand.name}**: ${cause}`;
    }),
    "",
  ];
};

const renderDeferred = (strands: readonly StrandReport[]): string[] => {
  const provisional = strands.filter((strand) => strand.outcome === "provisional");
  if (provisional.length === 0) return ["Nothing was deferred.", ""];
  const waitingOn = [...new Set(provisional.flatMap((strand) => strand.waitingOn))].sort();
  return [
    `${provisional.map((strand) => strand.id).join(", ")} ${provisional.length === 1 ? "is" : "are"} done, on the run's provisional line, ` +
      "and **not on the program branch**: some checks could not run without a human.",
    "",
    `1. Do what is pending below${waitingOn.length === 0 ? "" : ` (${waitingOn.join(", ")})`}.`,
    "2. `nightshift preflight <program>` until it passes.",
    "3. `nightshift resume <program>`: the deferred checks run in order, what passes lands on the",
    "   program branch unchanged, and anything built on a check that fails is discarded, saying so.",
    "",
  ];
};

const renderPrerequisites = (pending: readonly Prerequisite[]): string[] =>
  pending.length === 0
    ? ["None.", ""]
    : [
        ...pending.flatMap((prerequisite) => [
          `- **${prerequisite.id}** ${prerequisite.description}`,
          `  To fix: ${prerequisite.remediation.replace(/\n/g, "\n  ")}`,
          `  Checked by: \`${prerequisite.verifyCommand}\``,
        ]),
        "",
      ];

/** A row's dollars: unknown when no route had any, and saying so when only some did. */
const costCell = (row: UsageRow): string => {
  if (row.unpriced === row.attempts) return "unknown";
  const known = `${row.costUsd.toFixed(2)}${row.estimated ? "*" : ""}`;
  return row.unpriced === 0 ? known : `${known} + ${row.unpriced} unknown`;
};

/** The run's totals against its budgets (D-P8-08). */
const renderBudget = (report: RunReport): string[] => {
  const { maxUsd, maxTokens } = report.program.costPolicy;
  if (maxUsd === undefined && maxTokens === undefined) return [];
  const usd = report.usage.reduce((total, row) => total + row.costUsd, 0);
  const tokens = report.usage.reduce((total, row) => total + row.inputTokens + row.outputTokens, 0);
  const estimated = report.usage.some((row) => row.estimated);
  const unpriced = report.usage.reduce((total, row) => total + row.unpriced, 0);
  const caveats = [
    ...(estimated ? ["partly estimated"] : []),
    ...(unpriced > 0 ? [`${unpriced} route(s) unpriced and not counted`] : []),
  ];
  return [
    "",
    `Budget: ${maxUsd === undefined ? "" : `$${usd.toFixed(2)}${caveats.length === 0 ? "" : ` (${caveats.join("; ")})`} of $${maxUsd}`}${
      maxUsd !== undefined && maxTokens !== undefined ? "; " : ""
    }${maxTokens === undefined ? "" : `${tokens} of ${maxTokens} tokens`}.`,
  ];
};

/**
 * Why the program exists, each story with its criteria met or not (P14,
 * D-P14-11). Absent for a program planned before stories existed.
 */
const renderStories = (report: RunReport): string[] => {
  const statuses = storyStatuses(report);
  if (statuses.length === 0) return [];
  return [
    "## Stories",
    "",
    ...statuses.flatMap(({ story, criteria, met, strands }) => [
      `### ${story.id} ${firstLine(story.outcome).replace(/\.\s*$/, "")}: ${met ? "done" : "not yet"}`,
      "",
      `- **Who:** ${story.who}`,
      `- **Today:** ${story.problem}`,
      `- **Afterwards:** ${story.outcome}`,
      ...(story.words ?? []).map((words) => `> "${words.replace(/\n/g, " ")}"`),
      "",
      `Criteria: ${
        criteria.length === 0
          ? "none"
          : criteria
              .map((criterion) => `${criterion.id} ${criterion.met ? "met" : "NOT met"}`)
              .join(", ")
      }. Strands: ${strands.length === 0 ? "none" : strands.join(", ")}.`,
      "",
    ]),
  ];
};

/** What was not verified, first (P19, D-05): a skipped step, a skip not applied, a raised time. */
const renderNotVerified = ({ skipped, raised }: StepAdjustments): string[] => {
  if (skipped.length === 0 && raised.length === 0) return [];
  return [
    "## Not verified — read this first",
    "",
    ...skipped.map((skip) => {
      if (skip.commits.length > 0) {
        return `- **${skip.stepId} was not run**: skipped by decision ${skip.decisionId} on ${skip.commits
          .map((commit) => commit.slice(0, 12))
          .join(", ")}, because ${skip.reason}${skip.inForce ? "" : " (no longer in force)"}`;
      }
      if (skip.notApplied !== undefined) {
        return `- **${skip.stepId} skip not applied**: decision ${skip.decisionId}; ${skip.notApplied}`;
      }
      return `- **${skip.stepId} is skipped**: by decision ${skip.decisionId}, no verification has run since, because ${skip.reason}`;
    }),
    ...raised.map((raise) =>
      raise.notApplied !== undefined
        ? `- **${raise.stepId}'s ${raise.field} raise not applied**: decision ${raise.decisionId}; ${raise.notApplied}`
        : `- **${raise.stepId}'s ${raise.field} raised** from ${raise.from} to ${raise.to} seconds by decision ${raise.decisionId}, because ${raise.reason}`,
    ),
    "",
  ];
};

const NOT_OBSERVED = "not observed";

const secs = (ms: number | undefined): string =>
  ms === undefined ? NOT_OBSERVED : humanDuration(Math.round(ms / 1000));
const num = (value: number | undefined): string =>
  value === undefined ? NOT_OBSERVED : String(value);
const pct = (value: number | undefined): string =>
  value === undefined ? NOT_OBSERVED : `${(value * 100).toFixed(0)}%`;
const usd = (value: number | undefined): string =>
  value === undefined ? NOT_OBSERVED : `$${value.toFixed(2)}`;
const recordOf = (record: Readonly<Record<string, number>>): string => {
  const entries = Object.entries(record).filter(([, value]) => value > 0);
  return entries.length === 0
    ? "none"
    : entries.map(([key, value]) => `${key} ${value}`).join(", ");
};

const resourcesLine = (totals: ResourceTotals): string => {
  const { tokens, coverage } = totals;
  const cover = Object.entries(coverage)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  return `input ${num(tokens.input)}, output ${num(tokens.output)} tokens (${totals.tokenCoverage} coverage${
    cover === "" ? "" : `: ${cover}`
  }); estimated ${usd(totals.usd.estimated)}, reported ${usd(totals.usd.reported)}${
    totals.unpriced > 0 ? `; ${totals.unpriced} unpriced` : ""
  }`;
};

/** "Where the time went" (P20, S-05): observed intervals only; an open one is never closed. */
const renderOperations = (ops: OperationsReport): string[] => {
  const { unions, endings, chain } = ops;
  return [
    "## Where the time went",
    "",
    `Elapsed ${secs(ops.elapsedMs)} (as of ${ops.asOf}). Peak concurrency ${ops.concurrency.peak}.`,
    "",
    `- **By phase (union, counted once):** work ${secs(unions.work)}, wait ${secs(unions.wait)}, queue ${secs(unions.queue)}, integration ${secs(unions.integration)}, examination ${secs(unions.examination)}, setup ${secs(unions.setup)}, startup ${secs(unions.startup)}, verification ${secs(unions.verification)}`,
    `- **Wait by blocker kind:** ${
      Object.keys(unions.waitByBlockerKind).length === 0
        ? "none"
        : Object.entries(unions.waitByBlockerKind)
            .map(([kind, ms]) => `${kind} ${secs(ms)}`)
            .join(", ")
    }`,
    `- **Unattributed:** ${secs(ops.unattributedMs)}. **Ambiguous (open or incomplete, in no union):** ${secs(ops.ambiguousMs)}`,
    `- **Endings:** integrated ${endings.integrated}, merged ${endings.merged}, integration conflict ${endings.integration_conflict}, verification failed ${endings.verification_failed}, failed ${endings.failed}, deferred ${endings.deferred}, examination stopped ${endings.examination_stopped}, examination skipped ${endings.examinationSkipped}, other ${endings.other}`,
    "",
    `Observed chain (not a claim about a faster schedule): covers ${secs(chain.coveredMs)} of ${secs(chain.elapsedMs)}, coverage ${pct(chain.coverage)}, ${
      chain.incomplete
        ? `incomplete${chain.stoppedBecause === undefined ? "" : ` (${chain.stoppedBecause})`}`
        : "complete"
    }; ${chain.ambiguous.length} ambiguous step(s).`,
    "",
    ...(chain.steps.length === 0
      ? ["No chain was observed.", ""]
      : [
          ...chain.steps.map(
            (step) =>
              `1. ${step.nodeId} ${step.phase} ${step.from} to ${step.to} (${secs(Date.parse(step.to) - Date.parse(step.from))}, via ${step.link})`,
          ),
          "",
        ]),
    ...chain.ambiguous.map(
      (tie) =>
        `- Tie at ${tie.operationId}: ${tie.candidates.map((c) => `${c.nodeId} ${c.phase}`).join(" or ")}`,
    ),
    ...(chain.ambiguous.length === 0 ? [] : [""]),
  ];
};

const attemptLine = (label: string, figures: FirstAttemptFigures): string =>
  `${label}: ${figures.succeeded}/${figures.denominator} (${pct(figures.rate)}), ${figures.unfinished} unfinished`;

/** "Delivery" (P20, S-05): settled work items only in a rate's denominator. */
const renderDelivery = (delivery: DeliveryReport): string[] => {
  const { firstAttempt, outcomes, rework } = delivery;
  return [
    "## Delivery",
    "",
    `${delivery.workItems} work item(s) and ${delivery.repairJobs} repair job(s) in ${delivery.strands} strand(s); ${delivery.attempts} attempt(s), ${delivery.helperCalls} helper call(s).`,
    "",
    `- **First-attempt success:** ${attemptLine("all jobs", firstAttempt)}; coverage ${firstAttempt.coverage}${
      firstAttempt.reasons.length === 0 ? "" : ` (${firstAttempt.reasons.join("; ")})`
    }`,
    `- **Excluding repair jobs:** ${attemptLine("jobs", firstAttempt.excludingRepairs)}`,
    `- **Outcomes:** ${recordOf(outcomes.counts)}; failed by ${recordOf(outcomes.failedBy)}`,
    `- **Rework:** ${rework.attempts} attempt(s), each counted once`,
    ...rework.byCause.map(
      (row) =>
        `  - ${row.kind}: ${row.attempts} attempt(s), ${row.sharedAttempts} shared with another cause; ${resourcesLine(row.resources)}`,
    ),
    `  - unknown cause: ${rework.unknownCause.attempts} attempt(s); ${resourcesLine(rework.unknownCause.resources)}`,
    `- **First attempts:** ${resourcesLine(rework.resources.firstAttempts)}`,
    `- **All rework:** ${resourcesLine(rework.resources.rework)}`,
    "",
  ];
};

/** "Review" (P20, S-05): coverage and overhead; a ruling is agreement, not truth. */
const renderReview = (review: ReviewReport): string[] => {
  const { coverage, dispositions, overhead, linkage } = review;
  const row = (label: string, value: OverheadRow): string =>
    `${label}: ${value.calls} call(s); ${resourcesLine(value.resources)}`;
  return [
    "## Review",
    "",
    `- **Coverage:** ${coverage.examinedNodes} node(s) examined, ${coverage.examinedByStrand} examined by strand, ${coverage.landedUnexamined} landed unexamined, ${coverage.skipped} skipped; ${coverage.examinations.total} examination(s) (${recordOf(coverage.examinations.byOutcome)})`,
    `- **Dispositions:** ${dispositions.unique} unique finding(s); latest ${recordOf(dispositions.byLatest)}; rulings ${recordOf(dispositions.rulings)}. ${dispositions.note}`,
    "- **Overhead by role (apart from repairs):**",
    `  - ${row("examiner", overhead.examiner)}`,
    `  - ${row("answerer", overhead.answerer)}`,
    `  - ${row("arbiter", overhead.arbiter)}`,
    `  - ${row("plan review", overhead.planReview)}`,
    `- **Repairs caused by review:** ${review.repairs.attempts} attempt(s); ${resourcesLine(review.repairs.resources)}`,
    `- **Linkage:** findings ${recordOf(linkage.findings)}; ${linkage.helpersUnlinked} helper call(s) unlinked; ${linkage.repairsWithoutFindings} repair(s) without findings`,
    "",
  ];
};

/** "Machine" (P20, S-05): one line when local expense has no configured basis. */
const renderMachine = (infrastructure: InfrastructureReport | undefined): string[] => {
  if (infrastructure === undefined) {
    return [
      "## Machine",
      "",
      infrastructureUnavailable("no dispatch is recorded for this run"),
      "",
    ];
  }
  const { lifetime, components, recorded, reconciliation, occupancy, apportionment } =
    infrastructure;
  return [
    "## Machine",
    "",
    `- **Lifetime:** ${secs(lifetime.instanceLifetimeMs)} (coverage ${lifetime.coverage}; ${lifetime.observedEndings} observed ending(s), ${lifetime.runnerOnlyEndings} runner-only ending(s); last machine ending ${lifetime.lastEndedAt ?? NOT_OBSERVED}, last runner ending ${lifetime.lastRunnerEndedAt ?? NOT_OBSERVED}; ${lifetime.openAttempts} attempt(s) without an observed end; gaps between attempts ${secs(lifetime.gapsBetweenAttemptsMs)})`,
    ...infrastructure.attempts.map(
      (a) =>
        `  - attempt ${a.generation} (${a.reason}): ${
          a.lifetimeMs === undefined
            ? `machine end unobserved${a.runnerLifetimeMs === undefined ? ", runner not ended" : `, runner ran ${secs(a.runnerLifetimeMs)} at least (lower bound)`}`
            : `machine lived ${secs(a.lifetimeMs)} (observed terminatedAt ${a.terminatedAt})`
        }${a.endedAt === undefined ? "" : `; runner ended ${a.endedAt}${a.endReason === undefined ? "" : ` (${a.endReason})`}`}${a.afterRunnerMs === undefined ? "" : `; ${secs(a.afterRunnerMs)} after the runner stopped`}${a.terminationRequestedAt === undefined ? "" : `; termination requested ${a.terminationRequestedAt}`}${a.terminationFailed === true ? "; termination request failed" : ""}`,
    ),
    `- **Instance:** ${usd(components.instance.usd)} for ${components.instance.seconds}s (runner-metered ${components.instance.runnerMeteredSeconds}s), ${components.instance.basis} (${components.instance.provenance}; ${components.instance.coverage})`,
    `- **Volume:** ${usd(components.volume.usd)} for ${components.volume.seconds}s${components.volume.open ? ", open" : ""} (${components.volume.provenance})`,
    `- **Total:** ${usd(components.total.usd)} (${components.total.basis})`,
    `- **Recorded spend:** ${JSON.stringify(recorded)}; computed ${usd(reconciliation.computedUsd)} against metered ${usd(reconciliation.meteredUsd)} over ${reconciliation.meteredSeconds}s (${reconciliation.covers})${
      reconciliation.discrepancy === undefined
        ? ""
        : `. **Discrepancy:** computed ${usd(reconciliation.discrepancy.computedUsd)} vs metered ${usd(reconciliation.discrepancy.meteredUsd)}`
    }`,
    `- **Occupancy:** coverage ${occupancy.coverage}; busy ${secs(occupancy.busyMs)}${occupancy.idleMs === undefined ? " at least" : ""}, idle ${occupancy.idleMs === undefined ? `not claimed${occupancy.idleNote === undefined ? "" : ` (${occupancy.idleNote})`}` : secs(occupancy.idleMs)}, provisioning ${secs(occupancy.provisioningMs)}, setup ${occupancy.setupSeconds === undefined ? NOT_OBSERVED : `${occupancy.setupSeconds}s`}; peak ${occupancy.peakConcurrentOccupants} concurrent occupant(s)`,
    ...(apportionment.perNode === undefined
      ? [
          `- **Per-node shares:** none${apportionment.note === undefined ? "" : `. ${apportionment.note}`}`,
        ]
      : [
          `- **Per-node shares (${apportionment.method}):**`,
          ...apportionment.perNode.map(
            (node) => `  - ${node.nodeId}: ${secs(node.occupiedMs)}, ${usd(node.shareUsd)}`,
          ),
          ...(apportionment.unapportionedUsd === undefined
            ? []
            : [`  - unapportioned ${usd(apportionment.unapportionedUsd)}`]),
          ...(apportionment.unapportioned ?? []).map(
            (a) => `  - attempt ${a.generation}: ${usd(a.usd)} unapportioned (${a.why})`,
          ),
          ...(apportionment.note === undefined ? [] : [`  - ${apportionment.note}`]),
        ]),
    "",
  ];
};

const seconds = (value: number | undefined): string => {
  if (value === undefined) return "none";
  const whole = Math.round(value);
  const minutes = Math.floor(whole / 60);
  return minutes === 0 ? `${whole} s` : `${minutes} min ${whole % 60} s`;
};

const percent = (value: number | undefined): string =>
  value === undefined ? "n/a" : `${Math.round(value * 100)}%`;

/** "Human verdict" (D-04): a person's one-click verdict; it names no finding, examiner or cause. */
const renderHumanVerdict = (report: RunReport): string[] => {
  const { feedback, feedbackCoverage: c } = report;
  const verdict =
    feedback.verdict === "worked"
      ? "worked"
      : feedback.verdict === "did_not_work"
        ? "did not work"
        : "not rated";
  return [
    "## Human verdict",
    "",
    "A person's one-click verdict on whether the run worked. It is not a verification and says nothing about why.",
    "",
    `- Verdict: **${verdict}**`,
    ...(feedback.by === undefined ? [] : [`- By: ${feedback.by}`]),
    ...(feedback.recordedAt === undefined ? [] : [`- When: ${feedback.recordedAt}`]),
    ...(feedback.resultCommit === undefined ? [] : [`- Result commit: ${feedback.resultCommit}`]),
    ...(feedback.ratingDelaySeconds === undefined
      ? []
      : [
          `- Rating delay: ${seconds(feedback.ratingDelaySeconds)} after the run ended (calendar time, not work time)`,
        ]),
    `- This program: ${c.rated} of ${c.eligible} ended run(s) rated; ${c.positive} worked, ${c.negative} did not; positive share among rated ${percent(c.positiveShare)}; ${c.unrated} unrated.`,
    "",
  ];
};

const renderCompletionFigures = (f: CompletionReport["current"]): string[] => [
  `lead time ${f.leadTimeSeconds === undefined ? "none (no worked verdict)" : seconds(f.leadTimeSeconds)}`,
  `run completion ${seconds(f.runCompletionSeconds)}`,
  `active union ${seconds(f.activeSeconds)}`,
  ...renderCompletionResources(f),
];

const renderCompletionResources = (f: CompletionReport["current"]): string[] => {
  const r = f.resources;
  const c = r?.coverage;
  const attempts = c === undefined ? 0 : c.complete + c.partial + c.unknown + c.legacy + c.missing;
  const figure = (value: number | undefined): string =>
    attempts === 0 || value === undefined ? NOT_OBSERVED : String(value);
  const dollars = (value: number | undefined): string =>
    attempts === 0 ? NOT_OBSERVED : usd(value);
  const machines = f.infrastructure;
  return [
    `tokens in ${figure(r?.tokens.input)}, out ${figure(r?.tokens.output)}`,
    `estimated ${dollars(r?.usd.estimated)}, reported ${dollars(r?.usd.reported)} (separate figures)`,
    `infrastructure ${machines === undefined || machines.members === 0 ? NOT_OBSERVED : `${usd(machines.usd)} over ${machines.members} member run(s)`}`,
    ...(c === undefined || attempts === 0
      ? []
      : [
          `token coverage complete ${c.complete}, partial ${c.partial}, unknown ${c.unknown}, legacy ${c.legacy}, missing ${c.missing}`,
        ]),
  ];
};

/** "Completion" (D-05): lead time, run completion and active union are three figures, none of them work time. */
const renderCompletions = (completions: readonly CompletionReport[]): string[] => {
  if (completions.length === 0) return [];
  return [
    "## Completion",
    "",
    "Lead time, run completion and the active union are three different figures; none is human work time.",
    "",
    ...completions.flatMap((c) => [
      `### ${c.title} (membership v${c.version})`,
      "",
      ...c.members.map(
        (m) =>
          `- ${m.programId}/${m.runId}: ${m.role}, ${m.unreadable === true ? "unreadable" : `${m.status}, ${m.verdict}`}`,
      ),
      "",
      `Coverage: ${c.coverage.rated} of ${c.coverage.eligible} rated; ${c.coverage.positive} worked, ${c.coverage.negative} did not; positive share among rated ${percent(c.coverage.positiveShare)}.`,
      `Now: ${renderCompletionFigures(c.current).join("; ")}.`,
      ...c.checkpoints.map(
        (k) =>
          `Checkpoint ${k.name} (membership v${k.membershipVersion}): ${renderCompletionFigures(k).join("; ")}.`,
      ),
      ...(c.laterFixes.length === 0
        ? []
        : [`Later fixes: ${c.laterFixes.map((m) => `${m.programId}/${m.runId}`).join(", ")}.`]),
      "",
    ]),
  ];
};

/** The report as markdown. Pure: the same records always give the same document. */
export const renderReport = (report: RunReport): string => {
  const { program, run, strands } = report;
  const succeeded = strands.filter((strand) => strand.outcome === "succeeded").length;
  const provisional = strands.filter((strand) => strand.outcome === "provisional").length;
  const lines: string[] = [
    `# Report: ${firstLine(program.objective)}`,
    "",
    `Run \`${run.runId}\` of plan \`${program.planHash?.slice(0, 12) ?? "(unplanned)"}\`: **${run.status}**${
      run.outcomeReason === undefined ? "" : `. ${run.outcomeReason}`
    }`,
    "",
    `${succeeded} of ${strands.length} strands succeeded; ${provisional} deferred; ${strands.filter(isParked).length} parked. Wall clock ${duration(run)}.`,
    "",
    ...renderNotVerified(report.stepAdjustments),
    ...renderPublication(report.publication),
    ...renderCorrections(report.corrections),
    ...renderRulings(report.rulings),
    ...renderUnreviewed(report.unreviewed),
    ...renderStories(report),
    ...renderDepartures(strands),
    ...renderGateHealth(report.gateHealth),
    "## Strands",
    "",
    ...strands.flatMap(renderStrand),
    "## Success criteria",
    "",
    "| Criterion | State | By |",
    "|---|---|---|",
    ...report.criteria.map(
      (criterion) =>
        `| ${criterion.id} ${cell(criterion.outcome)} | ${criterion.met ? "met" : "NOT met"} | ${criterion.by.join(", ")} |`,
    ),
    "",
    "## Parked",
    "",
    ...renderParked(strands),
    "## Deferred",
    "",
    ...renderDeferred(strands),
    "## Human prerequisites still pending",
    "",
    ...renderPrerequisites(report.pendingPrerequisites),
    ...renderDecisionGraph(report.graph),
    "## Usage",
    "",
    "Token counts are what each harness reported and are not comparable across harnesses.",
    "A cost marked * is estimated from the price table, not reported by the harness. A cost",
    "that is unknown had neither: give the org's price table a price for that model to estimate it.",
    "",
    "| Harness | Model | For | Routes | Input tokens | Output tokens | Cost (USD) |",
    "|---|---|---|---|---|---|---|",
    ...report.usage.map(
      (row) =>
        `| ${row.harness} | ${row.model} | ${row.purpose} | ${row.attempts} | ${row.inputTokens} | ${row.outputTokens} | ${costCell(row)} |`,
    ),
    ...renderBudget(report),
    "",
    ...renderOperations(report.operations),
    ...renderDelivery(report.delivery),
    ...renderHumanVerdict(report),
    ...renderCompletions(report.completions),
    ...renderReview(report.review),
    ...renderMachine(report.infrastructure),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
};
