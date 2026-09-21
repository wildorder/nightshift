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
  Decision,
  ExecutionNode,
  JobContract,
  Prerequisite,
  ProgramContract,
  RoutingDecision,
  Run,
} from "@nightshift/contracts";
import {
  blockedBy,
  buildTree,
  descendantsOf,
  type ExecutionTree,
  type ProjectStores,
  prerequisitesOf,
  type RunScope,
  type StrandOutcome,
  type StrandOutcomes,
  strandOutcomes,
  strandsOf,
} from "@nightshift/core";

export const DEPARTURE_PREFIX = "DEPARTURE:";

export interface JobReport {
  readonly nodeId: string;
  readonly objective: string;
  readonly status: string;
  readonly commitSha: string | null;
  readonly attempts: number;
  readonly reason: string | undefined;
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
  /** How many times the strand itself was attempted. */
  readonly attempts: number;
}

export interface UsageRow {
  readonly harness: string;
  readonly model: string;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
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
  /** The run's own decisions: authority `agent`, departures excluded (they lead their strand). */
  readonly decisions: readonly Decision[];
  readonly humanDecisions: readonly Decision[];
  readonly usage: readonly UsageRow[];
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
  /** Every attempt at every strand, oldest first. */
  readonly strandNodes: readonly { readonly strandId: string; readonly node: ExecutionNode }[];
  readonly outcomes: StrandOutcomes;
}

const jobReportOf = (records: Records, node: ExecutionNode): JobReport => ({
  nodeId: node.executionNodeId,
  objective: firstLine(
    (node.jobContractId === null ? undefined : records.jobOf.get(node.jobContractId))?.objective ??
      "",
  ),
  status: node.status,
  commitSha: node.commitSha,
  attempts: Math.max(1, records.routesOf.get(node.executionNodeId)?.length ?? 1),
  reason: node.outcomeReason,
});

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
    jobs: under
      .map((id) => records.tree.nodes.get(id))
      .filter((node): node is ExecutionNode => node !== undefined && node.kind === "job")
      .map((node) => jobReportOf(records, node)),
    departures: records.decisions.filter(
      (decision) =>
        inStrand.has(decision.executionNodeId) &&
        decision.context.trimStart().startsWith(DEPARTURE_PREFIX),
    ),
  };
};

const usageOf = (routes: readonly RoutingDecision[]): UsageRow[] => {
  const rows = new Map<string, UsageRow>();
  for (const route of routes) {
    const key = `${route.chosen.harness} / ${route.chosen.model}`;
    const so = rows.get(key) ?? {
      harness: route.chosen.harness,
      model: route.chosen.model,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    rows.set(key, {
      ...so,
      attempts: so.attempts + 1,
      inputTokens: so.inputTokens + (route.usage.inputTokens ?? 0),
      outputTokens: so.outputTokens + (route.usage.outputTokens ?? 0),
      costUsd: so.costUsd + (route.usage.actualCostUsd ?? route.usage.estimatedCostUsd ?? 0),
    });
  }
  return [...rows.values()];
};

const readRecords = async (
  stores: ProjectStores,
  scope: RunScope,
  program: ProgramContract,
): Promise<Records> => {
  const nodes = await readAll<ExecutionNode>((page) =>
    stores.executionNodes.listByRun(scope, page),
  );
  const jobs = await readAll<JobContract>((page) => stores.jobContracts.listByRun(scope, page));
  const decisions = await readAll<Decision>((page) => stores.decisions.listByRun(scope, page));
  const jobOf = new Map(jobs.map((job) => [job.jobContractId as string, job]));

  const routesOf = new Map<string, readonly RoutingDecision[]>();
  for (const node of nodes) {
    if (node.parentNodeId === null) continue;
    routesOf.set(
      node.executionNodeId,
      await stores.routingDecisions.listByNode(scope, node.executionNodeId),
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
    strandNodes.map(({ strandId, node }) => ({
      strandId,
      status: node.status,
      createdAt: node.createdAt,
    })),
  );
  return { program, tree: buildTree(nodes), jobOf, decisions, routesOf, strandNodes, outcomes };
};

export const gatherReport = async (stores: ProjectStores, scope: RunScope): Promise<RunReport> => {
  const program = await stores.programContracts.get(scope.projectId, scope.programId);
  const run = await stores.runs.get(scope, scope.runId);
  if (program === undefined || run === undefined) {
    throw new Error(`run ${scope.runId} or its program is not in the control plane`);
  }
  const records = await readRecords(stores, scope, program);
  const blocked = blockedBy(program, records.outcomes);
  const strands = strandsOf(program).map((strand) => strandReportOf(records, strand, blocked));
  const departed = new Set(strands.flatMap((strand) => strand.departures.map((d) => d.decisionId)));

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
    decisions: records.decisions.filter(
      (decision) => decision.authority === "agent" && !departed.has(decision.decisionId),
    ),
    humanDecisions: records.decisions.filter((decision) => decision.authority === "human"),
    usage: usageOf([...records.routesOf.values()].flat()),
  };
};

// --- rendering ----------------------------------------------------------------

const OUTCOME_WORD: Readonly<Record<StrandReport["outcome"], string>> = {
  succeeded: "succeeded",
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

const renderJobs = (strand: StrandReport): string[] => {
  if (strand.jobs.length === 0) {
    return [
      strand.outcome === "succeeded" ? "Ran as a single job." : "No jobs were delegated.",
      "",
    ];
  }
  return [
    "| Job | Status | Commit | Attempts |",
    "|---|---|---|---|",
    ...strand.jobs.map((job) => {
      const why = job.reason === undefined ? "" : ` (${cell(job.reason).slice(0, 100)})`;
      return `| ${cell(job.objective)} | ${job.status}${why} | ${job.commitSha?.slice(0, 8) ?? ""} | ${job.attempts} |`;
    }),
    "",
  ];
};

const renderStrand = (strand: StrandReport): string[] => {
  const blockedNote =
    strand.blockedBy.length === 0 ? "" : `, blocked by ${strand.blockedBy.join(", ")}`;
  return [
    `### ${strand.id} ${strand.name}: ${OUTCOME_WORD[strand.outcome]}${blockedNote}`,
    "",
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

/** The report as markdown. Pure: the same records always give the same document. */
export const renderReport = (report: RunReport): string => {
  const { program, run, strands } = report;
  const succeeded = strands.filter((strand) => strand.outcome === "succeeded").length;
  const lines: string[] = [
    `# Report: ${firstLine(program.objective)}`,
    "",
    `Run \`${run.runId}\` of plan \`${program.planHash?.slice(0, 12) ?? "(unplanned)"}\`: **${run.status}**${
      run.outcomeReason === undefined ? "" : `. ${run.outcomeReason}`
    }`,
    "",
    `${succeeded} of ${strands.length} strands succeeded; ${strands.filter(isParked).length} parked. Wall clock ${duration(run)}.`,
    "",
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
    "## Human prerequisites still pending",
    "",
    ...renderPrerequisites(report.pendingPrerequisites),
    "## Decisions the run took",
    "",
    ...(report.decisions.length === 0
      ? ["None recorded.", ""]
      : [...report.decisions.flatMap(renderDecision), ""]),
    "## Usage",
    "",
    "Token counts are what each harness reported and are not comparable across harnesses.",
    "",
    "| Harness | Model | Attempts | Input tokens | Output tokens | Cost (USD) |",
    "|---|---|---|---|---|---|",
    ...report.usage.map(
      (row) =>
        `| ${row.harness} | ${row.model} | ${row.attempts} | ${row.inputTokens} | ${row.outputTokens} | ${row.costUsd.toFixed(2)} |`,
    ),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
};
