/**
 * `docs/programs/{id}/report.md` (P7, T4; D-P7-09, SC-P7-11).
 *
 * Written **from the control plane alone**: every fact below is a record, so the
 * same report can be produced on a machine that never saw the repository (A-06),
 * and the next `plan-program` reads it when re-planning.
 *
 * It reports against the plan, in the order a human wants in the morning: what
 * happened to each strand, leading with any departure from the approach they
 * approved; whether each success criterion was met, and by what; what was parked
 * and what that blocked; what is still theirs to do; and the decisions the run
 * took without them.
 *
 * Gathering reads; rendering is pure. A departure is a decision whose context
 * begins with {@link DEPARTURE_PREFIX}: a convention the strand's brief states,
 * because whether an approach was departed from is a judgement only the agent
 * that made it can record.
 */
import type {
  Agent,
  CarriedStrand,
  Decision,
  Examination,
  ExecutionNode,
  JobContract,
  Prerequisite,
  ProgramContract,
  RoutingDecision,
  Run,
} from "@nightshift/contracts";
import type { ProjectStores } from "../ports/stores.js";
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
  type CorrectionReport,
  type DecisionReport,
  gatherCorrections,
  gatherDecisionGraph,
  renderCorrections,
  renderDecisionGraph,
} from "./decision-graph.js";
import { storyStatuses } from "./stories.js";

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

  const routesOf = new Map<string, readonly RoutingDecision[]>();
  const examinationsOf = new Map<string, readonly Examination[]>();
  const agentOf = new Map<string, Agent>();
  for (const node of nodes) {
    if (node.parentNodeId === null) continue;
    routesOf.set(
      node.executionNodeId,
      await stores.routingDecisions.listByNode(scope, node.executionNodeId),
    );
    if (node.kind !== "job") continue;
    const examinations = await stores.examinations.listByNode(scope, node.executionNodeId);
    if (examinations.length > 0) {
      for (const agent of await stores.agents.listByNode(scope, node.executionNodeId)) {
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
  };
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
  };
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

/** One route, as a reader wants it: where, by which rule, and how it ended. */
const describeRoute = (route: RoutingDecision): string => {
  const where =
    route.ladder === undefined
      ? route.chosen.model
      : `${route.chosen.model} (${route.ladder}, ${route.rung?.tier ?? "?"}${route.chosen.effort === undefined ? "" : `, ${route.chosen.effort} effort`})`;
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
    `  - Examined by ${examination.examinerRoute.model}${examination.fixAttempt > 0 ? ` (fix ${examination.fixAttempt})` : ""}: ${examination.outcome}${examination.blocking ? ", blocking" : ", advisory"}`,
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
    ...renderCorrections(report.corrections),
    ...renderRulings(report.rulings),
    ...renderStories(report),
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
  ];
  return `${lines.join("\n").trimEnd()}\n`;
};
