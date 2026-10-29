/**
 * The line's repair, as an engine repair job (S-02, D-02, P15 D-P15-04).
 *
 * The composer's `repair(request)` port. A repair is an ordinary job of the
 * line's run, delegated through the same engine as any other: it records a
 * decision authored by the composer's agent, puts the run's local program branch
 * (the line branch, D-06) at the request's base in the checkout the engine
 * integrates into, delegates a job at risk `high` with `repair` set, and waits
 * until the node is integrated or settled. Nothing here launches an agent.
 *
 * Repairs share one checkout and one branch, so they run one at a time.
 */
import {
  type CommitSha,
  type ExecutionNodeId,
  type JobContract,
  JobContractSchema,
  type LineRange,
} from "@nightshift/contracts";
import { conservativeDefaults, isDoneForNow, nowIso } from "@nightshift/core";
import {
  continuedByNightshift,
  type GitRunner,
  git,
  type LineCommandLog,
  type LineRepairRequest,
  type RepairOutcome,
  revParse,
} from "@nightshift/execution";
import { type DecisionInput, recordDecision, repairObjective } from "../repair-job.js";
import { routeJob } from "../routing.js";
import type { LineSession } from "./line-session.js";

export interface LineRepairOptions extends Pick<LineSession, "session" | "engine" | "outbox"> {
  readonly runtime: Pick<LineSession["runtime"], "stores" | "ids" | "clock">;
  /** The checkout the engine integrates into. Must be clean when a repair starts. */
  readonly checkout: string;
  /** The line branch, which is the run's local program branch (D-06). */
  readonly branch: string;
  readonly git: GitRunner;
  /** How often the node is read while waiting. */
  readonly pollMs?: number;
}

const ATTEMPTS = 3;
const DEFAULT_REPAIR_POLL_MS = 100;

const short = (sha: string): string => sha.slice(0, 12);

const rangeText = (range: LineRange): string =>
  `${range.program}: ${range.from === undefined ? "start" : short(range.from)}..${short(range.upTo)}`;

const rangesText = (ranges: readonly LineRange[]): string =>
  ranges.length === 0 ? "none" : ranges.map(rangeText).join("; ");

const failingChecks = (checks: readonly LineCommandLog[]): LineCommandLog[] => {
  const failing = checks.filter((check) => check.exitCode !== 0);
  return failing.length > 0 ? failing : [...checks];
};

/** The step ids or paths the repair is about; a repair names at least one gate. */
const gatesOf = (request: LineRepairRequest): string[] => {
  const gates =
    request.cause === "line_conflict"
      ? request.paths
      : failingChecks(request.checks).map((check) => check.stepId);
  const unique = [...new Set(gates)];
  return unique.length > 0 ? unique : ["line"];
};

/** What the repair is asked to do, in words (the job's objective before the repair paragraph). */
export const lineRepairBrief = (request: LineRepairRequest): string => {
  const lines = [
    `Repair the project line (attempt ${request.attempt} of ${ATTEMPTS}).`,
    "",
    `Line head: ${request.lineHead}`,
    `Range being composed: ${rangeText(request.range)}`,
    `Base commit (your starting point): ${request.base}`,
    `Ranges held behind it: ${rangesText(request.held)}`,
    `Landed on the line since this lineage's first failure: ${rangesText(request.landedSince)}`,
    "",
  ];
  if (request.cause === "line_conflict") {
    lines.push(
      "The base commit is the range merged onto the line with conflict markers committed in the " +
        "named paths. Resolve each conflict keeping both sides' intent, and leave no conflict " +
        "markers (<<<<<<<, =======, >>>>>>>) in any file.",
      `Conflicting paths:\n${request.paths.map((path) => `  ${path}`).join("\n")}`,
    );
  } else {
    lines.push(
      "The base is the red composition: the range composed onto the line, which fails the " +
        "checks below. Make it green without weakening a gate.",
      `Paths the range changed:\n${request.paths.map((path) => `  ${path}`).join("\n")}`,
      "Failing checks:",
    );
    for (const check of failingChecks(request.checks)) {
      lines.push(
        `--- ${check.stepId}: ${check.command}` +
          (check.exitCode === undefined ? " (did not finish)" : ` (exit ${check.exitCode})`),
        check.tail,
      );
    }
  }
  lines.push("", "Recent repairs of this line:");
  if (request.recentRepairs.length === 0) lines.push("  none");
  for (const repair of request.recentRepairs) {
    lines.push(
      `  ${rangeText(repair.range)} — ${repair.cause}: ${repair.outcome}` +
        (repair.words === undefined ? "" : ` — ${repair.words}`),
    );
  }
  return lines.join("\n");
};

const decisionOf = (request: LineRepairRequest, gates: readonly string[]): DecisionInput => ({
  context:
    request.cause === "line_conflict"
      ? `Range ${rangeText(request.range)} conflicted with line head ${short(request.lineHead)} in ${gates.join(", ")}.`
      : `Range ${rangeText(request.range)} composed onto line head ${short(request.lineHead)} is red: ${gates.join(", ")} failed.`,
  alternatives: [
    {
      summary: "Park the range without a repair",
      rejectedBecause: `the lineage has repairs left (attempt ${request.attempt} of ${ATTEMPTS})`,
    },
  ],
  choice: `Delegate repair attempt ${request.attempt} of ${ATTEMPTS} as a ${request.cause} job at risk high.`,
  rationale:
    "The line keeps composing other ranges; only this range's paths wait, and the repair is " +
    "bounded by the lineage's budget.",
  reversibility: "reversible",
});

export const createLineRepair = (
  options: LineRepairOptions,
): ((request: LineRepairRequest) => Promise<RepairOutcome>) => {
  const { session, runtime, engine, outbox, checkout, branch } = options;
  const { stores, ids, clock } = runtime;
  const pollMs = options.pollMs ?? DEFAULT_REPAIR_POLL_MS;
  const run = (args: readonly string[]) => git(options.git, args, { cwd: checkout });

  const placeBranch = async (base: CommitSha): Promise<void> => {
    const dirty = (await run(["status", "--porcelain"])).trim();
    if (dirty !== "") {
      throw new Error(`the line's checkout at ${checkout} is not clean:\n${dirty}`);
    }
    await run(["checkout", "-B", branch, base]);
  };

  /** The worker's own words, else the examiner's findings, else the node's outcome reason. */
  const wordsOf = async (nodeId: ExecutionNodeId): Promise<string> => {
    const scope = session.scope;
    const node = await stores.executionNodes.get(scope, nodeId);
    const eventSummary = async (type: string, key: string): Promise<string | undefined> => {
      const page = await stores.events.listByNode(scope, nodeId, { type });
      const payload = page.items.at(-1)?.payload as Record<string, unknown> | undefined;
      const value = payload?.[key];
      return typeof value === "string" && value.trim() !== "" ? value : undefined;
    };
    const worker =
      (await eventSummary("node.failed", "reason")) ??
      (await eventSummary("node.implemented", "summary"));
    if (worker !== undefined) return worker;
    const examinations = await stores.examinations.listByNode(scope, nodeId);
    const findings = examinations.at(-1)?.findings.map((finding) => finding.summary) ?? [];
    if (findings.length > 0) return findings.join("; ");
    return node?.outcomeReason ?? `the repair ended ${node?.status ?? "unknown"}`;
  };

  const awaitNode = async (nodeId: ExecutionNodeId): Promise<"integrated" | "failed"> => {
    for (;;) {
      const node = await stores.executionNodes.get(session.scope, nodeId);
      if (node?.status === "integrated") return "integrated";
      if (node !== undefined && isDoneForNow(node.status)) {
        const examinations = await stores.examinations.listByNode(session.scope, nodeId);
        // An arbiter's ruling is still being carried out by Nightshift itself.
        if (continuedByNightshift(node.status, examinations) === undefined) return "failed";
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  const repairOnce = async (request: LineRepairRequest): Promise<RepairOutcome> => {
    const gates = gatesOf(request);
    const decision = decisionOf(request, gates);
    const decisionId = ids.next("dec");
    const repair = { cause: request.cause, gates, decisionId } as const;
    const brief = lineRepairBrief(request);
    const job: JobContract = JobContractSchema.parse({
      schemaVersion: 1,
      ...session.scope,
      jobContractId: ids.next("job"),
      objective: repairObjective(brief, repair, decision),
      acceptance: [
        request.cause === "line_conflict"
          ? "no conflict markers remain and both sides' intent is kept"
          : "every failing check passes without weakening a gate",
        "the line's gates pass on the result",
      ],
      dependencies: [],
      ...conservativeDefaults(session.program),
      risk: "high",
      repair,
      createdAt: nowIso(clock),
    });
    const route = routeJob(session.run, session.program, job, {
      pins: { harness: undefined, model: undefined, effort: undefined },
      unavailable: engine.unavailableRoutes(),
    });
    const ref = { runId: session.scope.runId, jobContractId: job.jobContractId };

    await recordDecision({ runtime }, { session, outbox }, decision, decisionId);
    await placeBranch(request.base);
    const submitted = await engine.submit({
      job,
      depth: 1,
      parentNodeId: session.rootNodeId,
      route,
      pins: { harness: undefined, model: undefined, effort: undefined },
    });
    if ((await awaitNode(submitted.nodeId)) === "failed") {
      return { kind: "failed", words: await wordsOf(submitted.nodeId), repair: ref };
    }
    return { kind: "repaired", commit: await revParse(options.git, checkout, branch), repair: ref };
  };

  let tail: Promise<unknown> = Promise.resolve();
  return (request) => {
    const result = tail.then(() => repairOnce(request));
    tail = result.catch(() => undefined);
    return result;
  };
};
