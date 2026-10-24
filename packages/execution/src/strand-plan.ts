/**
 * A strand's job plan and its review (P18, D-P18-01).
 *
 * A strand's orchestrator authors its jobs before any of them is built: each
 * job's objective, acceptance, the paths it expects to touch and the jobs it
 * depends on, as parallel as the work allows. The plan is a decision on the
 * strand's node, `STRAND PLAN: …`. An independent examiner then reviews it
 * against the strand's brief, the review is a decision beside it,
 * `STRAND PLAN REVIEW: …`, and the orchestrator's own session is resumed with
 * it, to revise or to build. At most {@link MAX_PLAN_REVIEWS} reviews; nothing
 * is delegated before the first.
 *
 * The reviewer hands its verdict back through a file the engine names, not the
 * control plane: an examiner may write nothing but its own examination, and
 * this is not one. The engine records the decision.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type Decision,
  type ExecutionNode,
  type FindingSeverity,
  FindingSeveritySchema,
  type JobContract,
} from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import { z } from "zod";
import type { ExecutionEnvironment, RunSession } from "./environment.js";
import { createHelper, endHelper, observeLifecycle, runHelper } from "./examine.js";

export const STRAND_PLAN_CONTEXT = "STRAND PLAN:";
export const STRAND_PLAN_REVIEW_CONTEXT = "STRAND PLAN REVIEW:";
/** A first review, and one more of the revision. */
export const MAX_PLAN_REVIEWS = 2;
/** Where a plan reviewer writes its verdict, set in its MCP server's environment. */
export const PLAN_REVIEW_FILE_ENV = "NIGHTSHIFT_PLAN_REVIEW_FILE";

/** One job of a strand's plan, as its orchestrator authors it. */
export const PlannedJobSchema = z.strictObject({
  /** The plan's own name for it, `J1`, `J2`: what `dependsOn` refers to. */
  id: z.string().min(1).max(40),
  objective: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  /** The paths the job expects to change: guidance for the review's overlap check, never a fence. */
  touches: z.array(z.string().min(1)),
  dependsOn: z.array(z.string().min(1)),
});
export type PlannedJob = z.infer<typeof PlannedJobSchema>;

export const PlanReviewSchema = z.strictObject({
  verdict: z.enum(["sound", "revise"]),
  findings: z.array(
    z.strictObject({
      severity: FindingSeveritySchema,
      summary: z.string().min(1),
      /** The plan's job ids it is about, when it is about some. */
      jobs: z.array(z.string()).optional(),
    }),
  ),
  summary: z.string().min(1),
});
export type PlanReview = z.infer<typeof PlanReviewSchema>;

/** How a review round ended, as its decision's context says it. */
export type PlanReviewVerdict = PlanReview["verdict"] | "not reviewed" | "undeliverable";

/**
 * A review as the reader takes it (PIP-32): a `revise` that names nothing to
 * change asks for nothing, so it is `sound`. The tool refuses one; a reviewer
 * that wrote the file another way is held to the same rule here.
 */
const takenAs = (review: PlanReview): PlanReview =>
  review.verdict === "revise" && review.findings.length === 0
    ? { ...review, verdict: "sound" }
    : review;

/** The verdict a review decision records, read back from its context. */
export const planReviewVerdictOf = (decision: Decision): PlanReviewVerdict | undefined => {
  const verdict = decision.context.split(" — ").at(-1);
  return verdict === "sound" ||
    verdict === "revise" ||
    verdict === "not reviewed" ||
    verdict === "undeliverable"
    ? verdict
    : undefined;
};

/** A plan's jobs, said for a human and a reviewer: the decision's choice. */
export const renderPlan = (jobs: readonly PlannedJob[]): string =>
  jobs
    .map((job) =>
      [
        `${job.id}: ${job.objective}`,
        `  depends on: ${job.dependsOn.length === 0 ? "nothing (starts at once)" : job.dependsOn.join(", ")}`,
        `  touches: ${job.touches.length === 0 ? "(not said)" : job.touches.join(", ")}`,
        ...job.acceptance.map((line) => `  - ${line}`),
      ].join("\n"),
    )
    .join("\n\n");

/**
 * The plan's problems a tool can see before anyone reviews it: a repeated id, a
 * dependency on no job of the plan, a cycle. Empty when there are none.
 */
export const planProblems = (jobs: readonly PlannedJob[]): readonly string[] => {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.id)) problems.push(`two jobs are called ${job.id}`);
    ids.add(job.id);
  }
  for (const job of jobs) {
    for (const dependency of job.dependsOn) {
      if (!ids.has(dependency))
        problems.push(`${job.id} depends on ${dependency}, which is not in the plan`);
      if (dependency === job.id) problems.push(`${job.id} depends on itself`);
    }
  }
  // A cycle: some job reachable from itself.
  const deps = new Map(jobs.map((job) => [job.id, job.dependsOn]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      problems.push(`the dependencies go round: ${[...path, id].join(" → ")}`);
      return;
    }
    visiting.add(id);
    for (const next of deps.get(id) ?? []) visit(next, [...path, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const job of jobs) visit(job.id, []);
  return [...new Set(problems)];
};

/** Where a strand's plan and its reviews stand, from the decisions on its node. */
export const planStateOf = async (
  environment: Pick<ExecutionEnvironment, "stores">,
  scope: RunSession["scope"],
  nodeId: string,
): Promise<{ readonly plans: readonly Decision[]; readonly reviews: readonly Decision[] }> => {
  const decisions: Decision[] = [];
  let cursor: string | undefined;
  do {
    const page = await environment.stores.decisions.listByRun(
      scope,
      cursor === undefined ? {} : { cursor },
    );
    decisions.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  const mine = decisions
    .filter((decision) => decision.executionNodeId === nodeId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    plans: mine.filter((decision) => decision.context.startsWith(STRAND_PLAN_CONTEXT)),
    reviews: mine.filter((decision) => decision.context.startsWith(STRAND_PLAN_REVIEW_CONTEXT)),
  };
};

/** A plan recorded since the last review, while reviews are left. */
export const reviewPending = (state: Awaited<ReturnType<typeof planStateOf>>): boolean =>
  state.plans.length > state.reviews.length && state.reviews.length < MAX_PLAN_REVIEWS;

const severityLabel = (severity: FindingSeverity): string =>
  severity === "material" ? "MATERIAL" : "minor";

/** A review, said as the decision's choice and in the orchestrator's brief. */
export const renderReview = (review: PlanReview): string =>
  [
    review.summary,
    ...review.findings.map(
      (finding) =>
        `- [${severityLabel(finding.severity)}] ${finding.summary}${
          finding.jobs === undefined || finding.jobs.length === 0
            ? ""
            : ` (${finding.jobs.join(", ")})`
        }`,
    ),
  ].join("\n");

/**
 * Has an independent examiner review the strand's latest plan, and records the
 * review as a decision on the strand's node. `undefined` when no reviewer could
 * run or it handed nothing back: the strand then builds on its plan unreviewed,
 * and the record says so, because a run never stops for a missing reviewer.
 */
export const reviewStrandPlan = async (
  environment: ExecutionEnvironment,
  input: {
    readonly session: RunSession;
    readonly node: ExecutionNode;
    readonly job: JobContract;
    readonly worktree: string;
    readonly plan: Decision;
    readonly round: number;
    /** The route the strand's orchestrator runs on: the reviewer must differ from it. */
    readonly builder: Parameters<
      NonNullable<ExecutionEnvironment["examination"]>["examinerRoute"]
    >[0]["implementer"];
  },
): Promise<PlanReview | undefined> => {
  const services = environment.examination;
  const { stores, clock, ids, outbox } = environment;
  const scope = input.session.scope;
  const nodeId = input.node.executionNodeId;
  const checkpoints = await stores.checkpoints.listByRun(scope);
  const before = checkpoints.items.at(-1);
  let recorded = false;
  const record = async (
    review: PlanReview | undefined,
    agentId: string | null,
    undeliverable?: string,
  ): Promise<void> => {
    if (before === undefined || recorded) return;
    recorded = true;
    const verdict: PlanReviewVerdict =
      review !== undefined ? review.verdict : undeliverable !== undefined ? "undeliverable" : "not reviewed";
    const decision: Decision = {
      schemaVersion: 1,
      ...scope,
      decisionId: ids.next("dec"),
      executionNodeId: nodeId,
      agentId: agentId as Decision["agentId"],
      context: `${STRAND_PLAN_REVIEW_CONTEXT} round ${input.round} of ${MAX_PLAN_REVIEWS} — ${verdict}`,
      alternatives: [
        { summary: "build the plan as authored" },
        { summary: "revise the plan before building" },
      ],
      choice:
        review !== undefined
          ? renderReview(review)
          : undeliverable !== undefined
            ? `The reviewer handed back a review that could not be read (${undeliverable}); the strand builds on its plan as if unreviewed.`
            : "No reviewer could review the plan; the strand builds on it unreviewed.",
      rationale:
        review === undefined
          ? "A run never stops for a missing reviewer (D-P18-01); the strand's landing is still verified and examined."
          : `An independent examiner reviewed decision ${input.plan.decisionId} against the strand's brief and acceptance.`,
      reversibility: "reversible",
      checkpointBefore: before.checkpointId,
      affectedNodes: [nodeId],
      authority: "agent",
      supersedesDecisionId: null,
      createdAt: nowIso(clock),
    };
    await stores.decisions.put(decision);
    outbox.emit({
      type: "decision.recorded",
      source: "control-plane",
      payload: { decisionId: decision.decisionId, context: decision.context },
      executionNodeId: nodeId,
      ...(agentId === null ? {} : { agentId: agentId as never }),
    });
  };

  if (services === undefined) {
    await record(undefined, null);
    return undefined;
  }
  // An independent reviewer when there is one; the strongest that can run when
  // there is not; and when nothing can, the strand builds unreviewed and the
  // record says so. Its orchestrator is waiting: it is never left waiting.
  const chosen = ((): ReturnType<typeof services.examinerRoute> | undefined => {
    try {
      return services.examinerRoute({
        job: input.job,
        implementer: input.builder,
        mustDifferModel: true,
        mustDifferProvider: false,
      });
    } catch {
      try {
        return services.strongestExaminerRoute({ job: input.job, implementer: input.builder });
      } catch {
        return undefined;
      }
    }
  })();
  if (chosen === undefined) {
    await record(undefined, null);
    return undefined;
  }
  try {
    return await reviewWith(environment, input, services, chosen, record);
  } catch {
    await record(undefined, null);
    return undefined;
  }
};

/** One reviewer's run on the plan, and its verdict recorded. */
const reviewWith = async (
  environment: ExecutionEnvironment,
  input: Parameters<typeof reviewStrandPlan>[1],
  services: NonNullable<ExecutionEnvironment["examination"]>,
  route: ReturnType<NonNullable<ExecutionEnvironment["examination"]>["examinerRoute"]>,
  record: (
    review: PlanReview | undefined,
    agentId: string | null,
    undeliverable?: string,
  ) => Promise<void>,
): Promise<PlanReview | undefined> => {
  const { outbox } = environment;
  const scope = input.session.scope;
  const nodeId = input.node.executionNodeId;
  const helperInput = { session: input.session, node: input.node, job: input.job };
  const helper = await createHelper(environment, helperInput, "examiner", route, {
    kind: "plan_review",
    decisionId: input.plan.decisionId,
  });
  const operationId = `plan_review:${nodeId}:${input.round}`;
  const opening = observeLifecycle(environment, helperInput, helper, {
    operationId,
    phase: "plan_review",
    transition: "start",
    refs: [
      { kind: "decision", ref: input.plan.decisionId },
      { kind: "routing_decision", ref: helper.decision.routingDecisionId },
    ],
  });
  const verdictFile = join(
    environment.paths.scratch(input.worktree),
    `plan-review-${helper.agent.agentId}.json`,
  );
  await rm(verdictFile, { force: true }).catch(() => undefined);
  outbox.emit({
    type: "node.progress",
    source: "control-plane",
    payload: {
      message: `plan review ${input.round} of ${MAX_PLAN_REVIEWS}: ${route.target.model} is reviewing the strand's job plan`,
    },
    executionNodeId: nodeId,
    agentId: helper.agent.agentId,
  });
  const exit = await runHelper(environment, helperInput, helper, {
    opening: [opening],
    worktree: input.worktree,
    task: {
      kind: "review_plan",
      plan: `${input.plan.choice}\n\nThe orchestrator's notes: ${input.plan.rationale}`,
      round: input.round,
      of: MAX_PLAN_REVIEWS,
    },
    mcp: services.mcp({
      projectId: scope.projectId,
      programId: scope.programId,
      runId: scope.runId,
      nodeId,
      agentId: helper.agent.agentId,
      jobContractId: input.job.jobContractId,
      worktree: input.worktree,
      role: "examiner",
      executionToken: helper.token ?? "",
      extraEnv: { [PLAN_REVIEW_FILE_ENV]: verdictFile },
    }),
  });
  // No file: the reviewer handed nothing back. A file that cannot be read as a
  // review: it reviewed, and what it said cannot be delivered (PIP-32).
  const text = await readFile(verdictFile, "utf8").catch(() => undefined);
  let review: PlanReview | undefined;
  let undeliverable: string | undefined;
  if (text !== undefined) {
    try {
      const handed = PlanReviewSchema.safeParse(JSON.parse(text));
      if (handed.success) review = takenAs(handed.data);
      else undeliverable = handed.error.issues.map((issue) => issue.message).join("; ");
    } catch (error) {
      undeliverable = error instanceof Error ? error.message : String(error);
    }
  }
  observeLifecycle(environment, helperInput, helper, {
    operationId,
    phase: "plan_review",
    transition: "end",
    reason:
      review !== undefined
        ? `verdict: ${review.verdict}`
        : undeliverable !== undefined
          ? "undeliverable"
          : "no_review",
  });
  await endHelper(environment, helperInput, helper, [exit], review !== undefined);
  await record(review, helper.agent.agentId, undeliverable);
  return review;
};
