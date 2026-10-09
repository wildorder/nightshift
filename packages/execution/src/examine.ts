/**
 * Examination (P8, D-P8-09 … D-P8-15): an independent examiner judges a job's
 * verified work against evidence before it lands, and an arbiter rules on a
 * finding nobody could settle.
 *
 * ## Where it runs
 *
 * **Beside the merge queue** (D-P8-09). When a worker reports a job that the
 * run's policy says must be examined, its snapshot is checked on its own base
 * (a `candidate` verification, which is evidence for the examiner and never for
 * landing) and examined there, while other work lands. The node stays
 * `implemented` throughout, so P1's table is untouched. The queue then verifies
 * it on the program head as always, and if the replayed diff is the one that
 * was examined (the same patch id), the examination carries over; if the replay
 * changed the diff, it is examined again, in the queue.
 *
 * The candidate check reruns a failed check once, as the queue's does
 * (D-P15-06, `flaky.ts`): a check that then passes is recorded as flaky, the
 * job goes on to its examiner rather than ending `verification_failed`, and
 * `gate.flaked` names the flake.
 *
 * ## Who is involved
 *
 * - The **examiner**: an agent of its own on the job's node, with its own token
 *   and role, in a detached checkout of exactly the commit it judges, given
 *   evidence and none of the builder's reasoning (D-P8-10, D-P8-11). It may ask
 *   the builder up to three questions once (D-P8-15): it ends its turn, the
 *   builder's own session is resumed to answer (or, when it cannot be, the
 *   builder's route reads its transcript), and the examiner's session is resumed
 *   with the answers to submit.
 * - The **arbiter**: a fresh invocation on the highest tier, a model neither
 *   side used when there is one (as amended 2026-09-26), given the finding, its evidence, the questions and answers, the dispute and
 *   the diff (D-P8-13). Its ruling is a `Decision`, authority `agent`, whose
 *   `checkpointBefore` is the program head it ruled against: a rollback point.
 *
 * Every route here is recorded as a routing decision with its `purpose`, so it
 * counts against the run's budget and is in the dataset, and none of them is
 * one of the job's attempts.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Agent,
  AgentId,
  CommitSha,
  Decision,
  Examination,
  ExaminationFinding,
  ExaminationId,
  ExaminationQuestion,
  ExaminationRuling,
  ExecutionNode,
  ExecutionNodeId,
  JobContract,
  RouteChoice,
  RoutingDecision,
  Verification,
  VerificationStep,
} from "@nightshift/contracts";
import {
  blockingFindings,
  defaultOrgConfig,
  MAX_EXAMINATION_QUESTIONS,
  MAX_FIX_ATTEMPTS,
  MAX_RULING_ATTEMPTS,
  outcomeOfCommands,
  VerificationSchema,
} from "@nightshift/contracts";
import {
  examinationBlocks,
  examinationRequirementFor,
  labelCost,
  nowIso,
  policyOfRun,
  transition,
  transitionAgent,
} from "@nightshift/core";
import {
  type AgentTask,
  type ExaminationEvidence,
  type HarnessExit,
  type McpLaunch,
  refusingWorkerTools,
} from "@nightshift/harness";
import { runCheckoutSteps, toVerificationCommands } from "@nightshift/verification";
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type ExaminationServices,
  type ExecutionEnvironment,
  type RunSession,
} from "./environment.js";
import { announceFlakes, rerunFailures, withFlakes } from "./flaky.js";
import { gateDefinitions, withGateDefinitions } from "./gate-repair.js";
import {
  addDetachedWorktree,
  changedPaths,
  checkpointRef,
  effectiveHead,
  git,
  pruneWorktrees,
  updateRef,
} from "./git/index.js";
import { createHookSink } from "./hook-sink.js";
import { programRulings, rulingsCarriedBy } from "./rulings.js";
import { recordArtifact, runAsOf } from "./runner.js";
import { discardScratch, ensureScratch, freshScratch, projectStepEnv } from "./scratch.js";
import { prepareCheckout } from "./setup.js";

/** The environment variable an examiner's server reads its examination's frame from. */
export const EXAMINATION_CONTEXT_ENV = "NIGHTSHIFT_EXAMINATION";
/** The environment variable an arbiter's server reads what it rules on from. */
export const RULING_CONTEXT_ENV = "NIGHTSHIFT_RULING";

/** The frame of an examination, fixed before the examiner starts; the examiner supplies the verdict. */
export interface ExaminationContext {
  readonly examinationId: ExaminationId;
  readonly verificationId: Verification["verificationId"];
  readonly commitSha: CommitSha;
  readonly patchId: string;
  readonly implementerAgentId: AgentId;
  readonly examinerRoute: RoutingDecision["chosen"];
  readonly requiredByRisk: JobContract["risk"];
  readonly blocking: boolean;
  readonly fixAttempt: number;
  readonly round: 1 | 2;
  readonly questions: readonly ExaminationQuestion[];
  /** The arbiter's rulings the attempt carried out: the examination checks only these. */
  readonly followsRulings?: readonly ExaminationRuling[];
}

/** What an arbiter rules on. */
export interface RulingContext {
  readonly examinationId: ExaminationId;
  readonly findingId: string;
  readonly checkpointBefore: Decision["checkpointBefore"];
}

/** The decision an arbiter records: `choice` is exactly one of these. */
export const RULING_CHOICES = { overturn: "overturn", uphold: "uphold" } as const;

export type ExaminationOutcome =
  | { readonly kind: "not_required" }
  /** Nothing stops it landing: passed, advisory findings only, or every blocking one overturned. */
  | { readonly kind: "cleared"; readonly examination: Examination }
  /** A material finding stands under a blocking policy, and a fix may still be tried. */
  | { readonly kind: "blocked"; readonly examination: Examination; readonly reason: string }
  /** The arbiter upheld a finding: the job fails, and the next attempt carries the ruling out. */
  | { readonly kind: "upheld"; readonly examination: Examination; readonly reason: string }
  /** The check on its own base failed: a verification failure, as the queue's would have been. */
  | { readonly kind: "candidate_failed"; readonly verification: Verification }
  /** Some check needs a human prerequisite: examined at resume, after its checks pass (D-P8-14). */
  | { readonly kind: "postponed" }
  /** Nothing to judge with: no examiner could be routed or it gave no verdict. Not the work's failure. */
  | { readonly kind: "examiner_failed"; readonly reason: string };

export interface ExamineInput {
  readonly session: RunSession;
  readonly job: JobContract;
  readonly node: ExecutionNode;
  /** The commit under examination, and the one it was cut from. */
  readonly commitSha: CommitSha;
  readonly base: CommitSha;
  /** Called before the examiner starts; the queue passes nothing, the beside-queue path its own. */
  readonly phase: "candidate" | "queue";
  /** In the queue, the verification already run on the head, which is the evidence. */
  readonly verification?: Verification;
}

const MAX_DIFF_CHARS = 120_000;
const MAX_LOG_TAIL_CHARS = 2_000;
const MAX_TRANSCRIPT_CHARS = 200_000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * A stable identity for a change, whatever it sits on (D-P8-09, D-P8-12): the
 * diff with its line positions and blob ids stripped, hashed. The same change
 * replayed onto a newer head has the same one; a changed change does not. What
 * `git patch-id --stable` computes, done here because this package's git runner
 * takes no standard input.
 */
export const patchIdOf = (diff: string): string => {
  const normalised = diff
    .split("\n")
    .filter((line) => !line.startsWith("index ") && !line.startsWith("diff --git "))
    .map((line) => (line.startsWith("@@") ? "@@" : line.replace(/\s+/g, "")))
    .join("\n");
  return createHash("sha1").update(normalised).digest("hex");
};

const looksLikeTest = (path: string): boolean =>
  /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i.test(path);

/** What a run that recorded no policy is read against: the seeded org default (a run from before P8). */
const SEEDED_ORG = defaultOrgConfig(
  "org_00000000000000000000000000" as never,
  "1970-01-01T00:00:00.000Z",
);

/**
 * The requirement for this run and job, and whether it says to examine at all.
 * From the policy the run recorded when it started (D-P8-03); a session that
 * does not carry its run is read against the seeded default, narrowed by its
 * contract, which is what such a run would have recorded.
 */
export const requirementOf = (
  session: Pick<RunSession, "program"> & { readonly run?: RunSession["run"] | undefined },
  job: JobContract,
) =>
  examinationRequirementFor(
    policyOfRun(session.run ?? {}, session.program, SEEDED_ORG).examinationPolicy,
    job.risk,
  );

/**
 * Which fix this attempt is (D-P8-13): one more than the last examination's when
 * that one blocked, the same otherwise. An attempt retried for a conflict is not
 * a fix.
 */
export const fixAttemptOf = (examinations: readonly Examination[]): number => {
  const last = [...examinations].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (last === undefined) return 0;
  return examinationBlocks(last)
    ? Math.min(last.fixAttempt + 1, MAX_FIX_ATTEMPTS)
    : last.fixAttempt;
};

/** The findings of `examination` an arbiter upheld: final, and carried out by the next attempt. */
const upheldFindings = (examination: Examination): readonly ExaminationFinding[] =>
  examination.findings.filter((finding) => finding.resolution === "upheld");

/**
 * Whether `examination` lets its change land: nothing blocks, and no arbiter
 * upheld a finding against it. An upheld finding is no longer open, and without
 * the second clause the very change it was upheld against would carry over.
 */
const letsLand = (examination: Examination): boolean =>
  !examinationBlocks(examination) && upheldFindings(examination).length === 0;

/** An examination that lets this exact change land, found among the node's (D-P8-09). */
export const carriedExamination = (
  examinations: readonly Examination[],
  patchId: string,
): Examination | undefined =>
  [...examinations]
    .filter((examination) => examination.patchId === patchId && letsLand(examination))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);

const latestOf = (examinations: readonly Examination[]): Examination | undefined =>
  [...examinations].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);

/**
 * The arbiter's rulings the next attempt carries out, and the examination of it
 * checks (D-P8-13, as amended 2026-09-25): the findings the last examination had
 * upheld, or, when that one was itself a check of a ruling that was not carried
 * out, the same rulings again. Nothing otherwise.
 */
export const rulingsInForce = (
  examinations: readonly Examination[],
): readonly ExaminationRuling[] | undefined => {
  const last = latestOf(examinations);
  if (last === undefined) return undefined;
  const upheld = upheldFindings(last).flatMap((finding) =>
    finding.resolvedBy?.decisionId === undefined
      ? []
      : [
          {
            findingId: finding.id,
            decisionId: finding.resolvedBy.decisionId,
            summary: finding.summary,
            rationale: finding.resolvedBy.reason ?? finding.summary,
          },
        ],
  );
  if (upheld.length > 0) return upheld;
  return last.followsRulings !== undefined && examinationBlocks(last)
    ? last.followsRulings
    : undefined;
};

/**
 * The rulings an examination of the current attempt checks: those in force, or,
 * when this attempt's ruling was already found carried out and it is examined
 * again in the queue (its patch changed on a newer head), the same ones.
 */
const rulingsToCheck = (
  examinations: readonly Examination[],
): readonly ExaminationRuling[] | undefined =>
  rulingsInForce(examinations) ?? latestOf(examinations)?.followsRulings;

/** How many attempts have already tried to carry out an arbiter's ruling. */
const rulingAttemptsOf = (examinations: readonly Examination[]): number =>
  examinations.filter((examination) => examination.followsRulings !== undefined).length;

/** Why a blocked examination blocks, in a sentence a human and an orchestrator can act on. */
export const describeBlocking = (examination: Examination): string => {
  const open = blockingFindings(examination);
  const what = open.map((finding) => `${finding.id} ${finding.summary}`).join("; ");
  return (
    examination.followsRulings === undefined
      ? `examination_failed: ${open.length} material finding(s) by an independent examiner ` +
        `(${examination.examinerRoute.model}): ${what}`
      : `examination_ruling_unmet: this attempt did not carry out the arbiter's ruling, by ` +
        `${examination.examinerRoute.model}: ${what}`
  ).slice(0, 1_900);
};

/** The answers an answering builder gave, from its final message, or `undefined` when it gave none usable. */
export const parseAnswers = (
  text: string | undefined,
  questions: readonly string[],
  answeredBy: ExaminationQuestion["answeredBy"],
): readonly ExaminationQuestion[] | undefined => {
  if (text === undefined) return undefined;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return undefined;
    const answers = questions.map((question, index) => {
      const entry = parsed[index] as { answer?: unknown } | undefined;
      const answer =
        typeof entry?.answer === "string" && entry.answer.trim() !== "" ? entry.answer : undefined;
      return answer === undefined ? undefined : { question, answer, answeredBy };
    });
    return answers.every((answer) => answer !== undefined)
      ? (answers as ExaminationQuestion[])
      : undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// The examination
// ---------------------------------------------------------------------------

/**
 * Examines one job's work, when the run's policy says to (D-P8-09 … D-P8-15).
 * Never moves the node: what its outcome means for the node is the caller's.
 */
export const examine = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
): Promise<ExaminationOutcome> => {
  const requirement = requirementOf(input.session, input.job);
  if (!requirement.required) return { kind: "not_required" };
  const services = environment.examination;
  if (services === undefined) {
    return {
      kind: "examiner_failed",
      reason:
        "examiner_failed: this run's policy requires an examiner, and this execution environment has none",
    };
  }
  const builder = await builderOf(environment, input);
  if (builder === undefined) {
    return {
      kind: "examiner_failed",
      reason: "examiner_failed: the work's own route and agent are not on the record",
    };
  }

  const checkout = await examinationCheckout(environment, input);
  try {
    const gathered = await gatherEvidence(environment, input, checkout, requirement);
    if ("kind" in gathered) return gathered;

    let route: RouteChoice;
    try {
      route = services.examinerRoute({
        job: input.job,
        implementer: builder.route,
        mustDifferModel: requirement.mustDifferModel,
        mustDifferProvider: requirement.mustDifferProvider,
      });
    } catch (error) {
      return {
        kind: "examiner_failed",
        reason: `examiner_failed: no examiner could be routed: ${messageOf(error)}`,
      };
    }

    const frame: Omit<ExaminationContext, "round" | "questions"> = {
      examinationId: environment.ids.next("exam"),
      verificationId: gathered.verification.verificationId,
      commitSha: input.commitSha,
      patchId: gathered.patchId,
      implementerAgentId: builder.agent.agentId,
      examinerRoute: route.target,
      requiredByRisk: input.job.risk,
      blocking: requirement.blockOnMaterialFindings,
      fixAttempt: gathered.evidence.fixAttempt,
      ...(gathered.evidence.rulings === undefined
        ? {}
        : { followsRulings: gathered.evidence.rulings }),
    };
    const examination = await runExaminer(environment, services, input, {
      checkout,
      route,
      evidence: gathered.evidence,
      frame,
      implementer: builder.agent,
    });
    if (typeof examination === "string") return { kind: "examiner_failed", reason: examination };
    announceVerdict(environment, input, examination);
    // Awaited here, not returned as a promise: the `finally` below removes the
    // checkout, and an arbiter `verdictOf` starts works in it. Returned
    // unawaited, the checkout went while the arbiter was being handed it, and
    // the job failed on a missing directory (P15's run, 2026-10-07).
    return await verdictOf(environment, services, input, examination, {
      checkout,
      diff: gathered.evidence.diff,
    });
  } finally {
    await removeCheckout(environment, input, checkout);
  }
};

/** The builder's agent and the route its attempt ran on. */
const builderOf = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
): Promise<{ readonly agent: Agent; readonly route: RoutingDecision["chosen"] } | undefined> => {
  const decisions = await environment.stores.routingDecisions.listByNode(
    input.session.scope,
    input.node.executionNodeId,
  );
  const last = decisions
    .filter((decision) => decision.purpose === undefined)
    .sort((a, b) => a.attempt - b.attempt)
    .at(-1);
  const agent = await implementerOf(environment, input);
  return last === undefined || agent === undefined ? undefined : { agent, route: last.chosen };
};

/**
 * What the examiner is given (D-P8-11): the diff and its patch id, the checks,
 * and on a fix what the last examination found. Or why there is nothing to
 * examine yet: a check waits on a human, or the candidate check failed.
 */
const gatherEvidence = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  checkout: string,
  requirement: ReturnType<typeof requirementOf>,
): Promise<
  | {
      readonly evidence: ExaminationEvidence;
      readonly verification: Verification;
      readonly patchId: string;
    }
  | Extract<ExaminationOutcome, { kind: "postponed" | "candidate_failed" }>
> => {
  const diff = await git(
    environment.git,
    ["diff", "--no-color", "--no-ext-diff", input.base, input.commitSha],
    { cwd: checkout },
  );
  let verification = input.verification;
  if (verification !== undefined) {
    // No candidate check runs here to set the checkout up, and the examiner works in it.
    await prepareCheckout(environment, {
      session: input.session,
      nodeId: input.node.executionNodeId,
      checkout,
      purpose: "examiner",
    });
  } else {
    const checked = await candidateVerification(environment, input, checkout);
    if (checked === "postponed") return { kind: "postponed" };
    if (checked.outcome === "failed") return { kind: "candidate_failed", verification: checked };
    verification = checked;
  }
  const examinations = await environment.stores.examinations.listByNode(
    input.session.scope,
    input.node.executionNodeId,
  );
  const paths = await changedPaths(environment.git, checkout, input.base, input.commitSha);
  const fixAttempt = fixAttemptOf(examinations);
  const previous = latestOf(examinations);
  const patchId = patchIdOf(diff);
  // This job's own rulings; otherwise any made on the very work it carries,
  // re-landed or replayed, which follow that work here (rulings.ts).
  const rulings =
    rulingsToCheck(examinations) ?? (await rulingsFollowingTheWork(environment, input, patchId));
  return {
    verification,
    patchId,
    evidence: {
      diff: diff.slice(0, MAX_DIFF_CHARS),
      diffTruncated: diff.length > MAX_DIFF_CHARS,
      changedTests: paths.filter(looksLikeTest),
      verification: await verificationEvidence(environment, verification),
      risk: input.job.risk,
      blocking: requirement.blockOnMaterialFindings,
      fixAttempt,
      ...(previous !== undefined && fixAttempt > 0 ? { previousFindings: previous.findings } : {}),
      ...(rulings === undefined ? {} : { rulings }),
    },
  };
};

/** Rulings made elsewhere in the program on the work this change carries, or `undefined`. */
const rulingsFollowingTheWork = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  patchId: string,
): Promise<readonly ExaminationRuling[] | undefined> => {
  const { projectId, programId } = input.session.scope;
  const carried = await rulingsCarriedBy(environment.git, {
    repoPath: input.session.repoPath,
    base: input.base,
    commitSha: input.commitSha,
    patchId,
    rulings: await programRulings(environment.stores, { projectId, programId }),
  });
  return carried.length === 0 ? undefined : carried;
};

const announceVerdict = (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  examination: Examination,
): void => {
  environment.outbox.emit({
    type: "examination.completed",
    source: "control-plane",
    payload: {
      examinationId: examination.examinationId,
      outcome: examination.outcome,
      blocking: examination.blocking,
      findings: examination.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
      })),
      examiner: examination.examinerRoute.model,
    },
    executionNodeId: input.node.executionNodeId,
    agentId: examination.examinerAgentId,
  });
};

/**
 * What the verdict means (D-P8-13): cleared; blocked while a fix may still be
 * tried; after two fixes, whatever the arbiter rules; and on an attempt that
 * carried out a ruling, only whether it did. An upheld ruling is carried out by
 * the next attempt, which the engine starts itself (as amended 2026-09-25).
 */
const verdictOf = (
  environment: ExecutionEnvironment,
  services: ExaminationServices,
  input: ExamineInput,
  examination: Examination,
  context: { readonly checkout: string; readonly diff: string },
): Promise<ExaminationOutcome> | ExaminationOutcome => {
  if (!examinationBlocks(examination)) return { kind: "cleared", examination };
  // A ruling not carried out is the work's failure: the ruling is final, and is
  // not argued again (D-P8-13, as amended 2026-09-25).
  if (examination.followsRulings !== undefined || examination.fixAttempt < MAX_FIX_ATTEMPTS) {
    return { kind: "blocked", examination, reason: describeBlocking(examination) };
  }
  return arbitrateAll(environment, services, input, examination, {
    ...context,
    dispute: "Two fixes have not resolved this finding; it goes to an arbiter without a dispute.",
  });
};

/** The worker whose work this is: the node's last worker agent. */
const implementerOf = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
): Promise<Agent | undefined> =>
  [...(await environment.stores.agents.listByNode(input.session.scope, input.node.executionNodeId))]
    .filter((agent) => agent.role === "worker")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);

/**
 * Removes an examination's checkout and nothing else: not the job's branch, and
 * not its base ref, which the job's own worktree still needs.
 */
const removeCheckout = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  path: string,
): Promise<void> => {
  // The examiner was granted its checkout (D-P10-25); the engine takes it back first.
  await environment.reclaim?.(path).catch(() => {});
  await git(environment.git, ["worktree", "remove", "--force", path], {
    cwd: input.session.repoPath,
  }).catch((error: unknown) => {
    console.error(
      `examination checkout ${path}: ${error instanceof Error ? error.message : error}`,
    );
  });
  await discardScratch(environment.paths, path);
  await pruneWorktrees(environment.git, input.session.repoPath).catch(() => {});
};

/** A detached checkout of exactly the commit, under the state directory, that nothing kept. */
const examinationCheckout = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
): Promise<string> => {
  const worktree = environment.paths.worktree(
    input.session.scope.runId,
    input.node.executionNodeId,
  );
  const path = `${worktree}-examined-${environment.ids.next("exam").slice(-8).toLowerCase()}`;
  await mkdir(dirname(path), { recursive: true });
  await pruneWorktrees(environment.git, input.session.repoPath);
  await addDetachedWorktree(environment.git, {
    repo: input.session.repoPath,
    path,
    base: input.commitSha,
  });
  return path;
};

/** A new examination checkout with the program's setup already run in it, for an agent that works there. */
const preparedCheckout = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  purpose: string,
): Promise<string> => {
  const checkout = await examinationCheckout(environment, input);
  await prepareCheckout(environment, {
    session: input.session,
    nodeId: input.node.executionNodeId,
    checkout,
    purpose,
  });
  return checkout;
};

/**
 * The snapshot checked on its own base, as evidence for the examiner (D-P8-09).
 * `postponed` when a step needs a human prerequisite nobody has met: that work
 * is examined at resume, once its checks pass (D-P8-14).
 */
const candidateVerification = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  checkout: string,
): Promise<Verification | "postponed"> => {
  const gates = await gateDefinitions(environment, input.session);
  const steps: readonly VerificationStep[] = gates.verification;
  if (steps.some((step) => (step.requires ?? []).length > 0)) {
    const current =
      environment.prerequisites === undefined
        ? []
        : await environment.prerequisites.prerequisites({
            projectId: input.session.program.projectId,
            programId: input.session.program.programId,
          });
    const unmet = new Set(
      current.filter((prerequisite) => prerequisite.status !== "satisfied").map((p) => p.id),
    );
    if (steps.some((step) => (step.requires ?? []).some((id) => unmet.has(id)))) return "postponed";
  }

  const startedAt = nowIso(environment.clock);
  // The checkout is new and holds only what is committed, so setup comes first;
  // it also leaves the checkout usable for the examiner who works in it. The
  // checks get a fresh scratch (scratch.ts), which the examiner then inherits.
  // On a machine, in the project environment, as the queue's are (D-10).
  const scratch = await freshScratch(environment.paths, checkout);
  const timeoutMs = environment.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const ran = await runCheckoutSteps({
    setup: gates.setup,
    steps,
    cwd: checkout,
    reference: input.session.repoPath,
    timeoutMs,
    env: projectStepEnv(environment.projectEnv, scratch),
  });
  const results = [...ran.setup, ...ran.checks];
  const logs = new Map<string, Verification["commands"][number]["logArtifactId"]>();
  for (const result of results) {
    const artifactId = await recordArtifact(environment, {
      scope: input.session.scope,
      nodeId: input.node.executionNodeId,
      kind: "verification-log",
      contentType: "text/plain; charset=utf-8",
      bytes: result.output,
    });
    logs.set(result.stepId, artifactId as never);
  }
  // A failed check runs once more here too, exactly as in the queue (D-P15-06,
  // flaky.ts): a flake is recorded as passed and goes on to the examiner,
  // never ending the job as verification_failed. The examiner inherits the
  // rerun's scratch.
  const reruns = await rerunFailures({
    steps,
    first: ran.checks,
    cwd: checkout,
    paths: environment.paths,
    timeoutMs,
    keepScratch: true,
    ...(environment.projectEnv === undefined ? {} : { projectEnv: environment.projectEnv }),
  });
  const commands = await withFlakes(
    environment,
    { scope: input.session.scope, nodeId: input.node.executionNodeId },
    toVerificationCommands(results, logs as never),
    reruns,
  );
  const workerId = (await implementerOf(environment, input))?.agentId;
  const verification = VerificationSchema.parse({
    schemaVersion: 1,
    ...input.session.scope,
    verificationId: environment.ids.next("ver"),
    executionNodeId: input.node.executionNodeId,
    jobContractId: input.job.jobContractId,
    agentId: workerId,
    commitSha: input.commitSha,
    phase: "candidate",
    commands,
    outcome: outcomeOfCommands(commands),
    startedAt,
    endedAt: nowIso(environment.clock),
  }) as Verification;
  await environment.stores.verifications.put(verification);
  announceFlakes(environment, verification, workerId);
  return verification;
};

/** Each step, with the tail of what it printed, for the examiner. */
/** Each step of a verification with the tail of its log: what an examiner, or a retry, is shown. */
export const verificationEvidence = async (
  environment: ExecutionEnvironment,
  verification: Verification,
): Promise<ExaminationEvidence["verification"]> => {
  const steps: ExaminationEvidence["verification"][number][] = [];
  for (const command of verification.commands) {
    let logTail: string | undefined;
    if (command.logArtifactId !== undefined) {
      const body = await environment.bodies
        .get(verification, command.logArtifactId)
        .catch(() => undefined);
      if (body !== undefined) logTail = new TextDecoder().decode(body).slice(-MAX_LOG_TAIL_CHARS);
    }
    steps.push({
      stepId: command.stepId,
      command: command.command,
      ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
      ...(logTail === undefined ? {} : { logTail }),
    });
  }
  return steps;
};

// ---------------------------------------------------------------------------
// Agents that are not the job's own
// ---------------------------------------------------------------------------

interface HelperAgent {
  readonly agent: Agent;
  readonly decision: RoutingDecision;
  readonly token: string | undefined;
}

/** An agent on the job's node for an examiner, an answerer or an arbiter: record, route, token. */
const createHelper = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  role: "examiner" | "answerer" | "arbiter",
  route: RouteChoice,
): Promise<HelperAgent> => {
  const { stores, clock, ids, outbox } = environment;
  const scope = input.session.scope;
  const nodeId = input.node.executionNodeId;
  const agent: Agent = {
    schemaVersion: 1,
    ...scope,
    agentId: ids.next("agent"),
    executionNodeId: nodeId,
    role,
    harness: route.target.harness,
    provider: route.target.provider,
    model: route.target.model,
    status: "created",
    createdAt: nowIso(clock),
  };
  await stores.agents.put(agent);
  outbox.emit({
    type: "agent.created",
    source: "control-plane",
    payload: { role, ...route.target },
    executionNodeId: nodeId,
    agentId: agent.agentId,
  });
  // An answerer reaches no Nightshift tool, so it is given no credential.
  const token =
    role === "answerer" ? undefined : (await environment.tokens.mint(scope, agent.agentId)).token;
  const purpose = role === "examiner" ? "examine" : role === "answerer" ? "answer" : "arbitrate";
  const decision: RoutingDecision = {
    schemaVersion: 1,
    ...scope,
    routingDecisionId: ids.next("route"),
    executionNodeId: nodeId,
    attempt: 1,
    eligibleOptions: [...route.eligibleOptions],
    chosen: route.target,
    ruleId: route.ruleId,
    wasOverride: route.wasOverride,
    usage: {},
    outcome: "pending",
    previousRouteId: null,
    ...(route.ladder === undefined ? {} : { ladder: route.ladder }),
    ...(route.rung === undefined ? {} : { rung: route.rung }),
    ...(route.policyVersion === undefined ? {} : { policyVersion: route.policyVersion }),
    purpose,
    createdAt: nowIso(clock),
  };
  await stores.routingDecisions.put(decision);
  outbox.emit({
    type: "routing.decided",
    source: "control-plane",
    payload: { purpose, ruleId: decision.ruleId, chosen: decision.chosen },
    executionNodeId: nodeId,
  });
  const started = transitionAgent(agent, "start", { at: nowIso(clock) });
  await stores.agents.put(started);
  return { agent: started, decision, token };
};

/** One run of a helper's harness process. */
const runHelper = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  helper: HelperAgent,
  launch: {
    readonly worktree: string;
    readonly task: AgentTask;
    readonly mcp?: McpLaunch | undefined;
    readonly resume?: string | undefined;
  },
): Promise<HarnessExit> => {
  const transcript = environment.paths.transcript(input.session.scope.runId, helper.agent.agentId);
  await mkdir(dirname(transcript), { recursive: true });
  // The helper's checkout is its own from here on (D-P10-25).
  const { runAs } = runAsOf(environment, helper.agent);
  const tmpDir = await ensureScratch(environment.paths, launch.worktree);
  if (runAs !== undefined) {
    await runAs.grant(launch.worktree);
    await runAs.grant(tmpDir);
  }
  try {
    const handle = await environment.harness.start({
      agent: helper.agent,
      node: input.node,
      job: input.job,
      program: withGateDefinitions(
        input.session.program,
        await gateDefinitions(environment, input.session),
      ),
      worktree: launch.worktree,
      tmpDir,
      // The program's rulings so far: an examiner holds the change to them (rulings.ts).
      rulings: await programRulings(environment.stores, {
        projectId: input.session.scope.projectId,
        programId: input.session.scope.programId,
      }),
      model: helper.decision.chosen,
      ...(launch.mcp === undefined ? {} : { mcp: launch.mcp }),
      tools: refusingWorkerTools(
        "an examiner, an arbiter or an answerer reaches Nightshift through its MCP launch",
      ),
      sink: createHookSink({
        outbox: environment.outbox,
        executionNodeId: input.node.executionNodeId,
        agentId: helper.agent.agentId,
      }),
      transcriptPath: transcript,
      ...runAsOf(environment, helper.agent),
      task: launch.task,
      ...(launch.resume === undefined ? {} : { resume: { sessionId: launch.resume } }),
    });
    return await handle.exit;
  } catch {
    // The adapter could not even attempt a launch: the helper did not run.
    return { kind: "failed", exitCode: 127 };
  }
};

/** What every run of a helper cost, added up: an examiner can run twice (D-P8-15). */
const sumUsage = (exits: readonly HarnessExit[]): RoutingDecision["usage"] => {
  const add = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return exits.reduce<RoutingDecision["usage"]>((total, exit) => {
    if (exit.kind !== "completed" && exit.kind !== "failed") return total;
    const reported = exit.usage ?? {};
    const sum = {
      inputTokens: add(total.inputTokens, reported.inputTokens),
      outputTokens: add(total.outputTokens, reported.outputTokens),
      cacheReadTokens: add(total.cacheReadTokens, reported.cacheReadTokens),
      cacheWriteTokens: add(total.cacheWriteTokens, reported.cacheWriteTokens),
      actualCostUsd: add(total.actualCostUsd, reported.actualCostUsd),
    };
    return Object.fromEntries(Object.entries(sum).filter(([, value]) => value !== undefined));
  }, {});
};

/** A helper agent's ending, with the session it kept, once. */
const endAgent = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  helper: HelperAgent,
  last: HarnessExit | undefined,
  succeeded: boolean,
): Promise<void> => {
  const { stores, clock } = environment;
  const current = await stores.agents.get(input.session.scope, helper.agent.agentId);
  if (current === undefined || current.status !== "started") return;
  const failedReason = last === undefined ? "it never ran" : `its harness ended ${last.kind}`;
  const ended = transitionAgent(current, succeeded ? "complete" : "fail", {
    at: nowIso(clock),
    ...(succeeded
      ? {}
      : { outcomeReason: `the ${helper.agent.role} did not finish: ${failedReason}` }),
    ...(last?.kind === "failed" ? { exitCode: last.exitCode } : {}),
  });
  const sessionId =
    last?.kind === "completed" || last?.kind === "failed" ? last.sessionId : undefined;
  await stores.agents
    .put(sessionId === undefined ? ended : { ...ended, sessionId })
    .catch(() => {});
};

/** A helper's ending, its usage and its route's outcome, once, however it went. */
const endHelper = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  helper: HelperAgent,
  exits: readonly HarnessExit[],
  succeeded: boolean,
): Promise<void> => {
  await endAgent(environment, input, helper, exits.at(-1), succeeded);
  const prices = input.session.run?.policy?.routingPolicy.prices ?? {};
  await environment.stores.routingDecisions
    .put({
      ...helper.decision,
      usage: labelCost(sumUsage(exits), prices[helper.decision.chosen.model]),
      outcome: succeeded ? "succeeded" : "failed",
    })
    .catch(() => {});
};

// ---------------------------------------------------------------------------
// The examiner, its questions, and the builder's answers
// ---------------------------------------------------------------------------

interface ExaminerRun {
  readonly checkout: string;
  readonly route: RouteChoice;
  readonly evidence: ExaminationEvidence;
  readonly frame: Omit<ExaminationContext, "round" | "questions">;
  readonly implementer: Agent;
}

/** The examiner's verdict as it recorded it, or why there is none. */
const runExaminer = async (
  environment: ExecutionEnvironment,
  services: ExaminationServices,
  input: ExamineInput,
  run: ExaminerRun,
): Promise<Examination | string> => {
  const helper = await createHelper(environment, input, "examiner", run.route);
  const launchFor = (round: 1 | 2, questions: readonly ExaminationQuestion[]): McpLaunch =>
    services.mcp({
      projectId: input.session.scope.projectId,
      programId: input.session.scope.programId,
      runId: input.session.scope.runId,
      nodeId: input.node.executionNodeId,
      agentId: helper.agent.agentId,
      jobContractId: input.job.jobContractId,
      worktree: run.checkout,
      role: "examiner",
      executionToken: helper.token ?? "",
      extraEnv: {
        [EXAMINATION_CONTEXT_ENV]: JSON.stringify({
          ...run.frame,
          round,
          questions,
        } satisfies ExaminationContext),
      },
    });
  environment.outbox.emit({
    type: "examination.requested",
    source: "control-plane",
    payload: {
      examinationId: run.frame.examinationId,
      examiner: run.route.target,
      risk: input.job.risk,
      blocking: run.frame.blocking,
      fixAttempt: run.frame.fixAttempt,
    },
    executionNodeId: input.node.executionNodeId,
    agentId: helper.agent.agentId,
  });

  const exits: HarnessExit[] = [];
  const first = await runHelper(environment, input, helper, {
    worktree: run.checkout,
    task: { kind: "examine", evidence: run.evidence, round: 1 },
    mcp: launchFor(1, []),
  });
  exits.push(first);
  let examination = await environment.stores.examinations.get(
    input.session.scope,
    run.frame.examinationId,
  );

  if (examination === undefined) {
    const questions = await askedBy(environment, input, helper.agent.agentId);
    const session =
      first.kind === "completed" || first.kind === "failed" ? first.sessionId : undefined;
    if (questions.length > 0 && session !== undefined) {
      const answers = await answer(environment, input, run, questions);
      environment.outbox.emit({
        type: "examination.answered",
        source: "control-plane",
        payload: { examinationId: run.frame.examinationId, answers },
        executionNodeId: input.node.executionNodeId,
        agentId: helper.agent.agentId,
      });
      const second = await runHelper(environment, input, helper, {
        worktree: run.checkout,
        task: { kind: "examine", evidence: run.evidence, round: 2, answers },
        mcp: launchFor(2, answers),
        resume: session,
      });
      exits.push(second);
      examination = await environment.stores.examinations.get(
        input.session.scope,
        run.frame.examinationId,
      );
    }
  }

  await endHelper(environment, input, helper, exits, examination !== undefined);
  return examination ?? "examiner_failed: the examiner ended without submitting a verdict";
};

/** The questions an `examination.asked` payload carries. */
const questionsIn = (payload: Readonly<Record<string, unknown>>): readonly string[] => {
  const questions = payload.questions;
  return Array.isArray(questions)
    ? questions.filter((question): question is string => typeof question === "string")
    : [];
};

/** The questions an examiner put, from the event its server wrote. */
const askedBy = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  agentId: AgentId,
): Promise<readonly string[]> => {
  // The examiner's server flushed its event before its process ended.
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await environment.stores.events.listByRun(
      input.session.scope,
      cursor === undefined ? {} : { cursor },
    );
    for (const event of page.items) {
      if (event.type === "examination.asked" && event.agentId === agentId) {
        found.push(...questionsIn(event.payload));
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found.slice(0, MAX_EXAMINATION_QUESTIONS);
};

/**
 * The builder's answers (D-P8-15): its own session resumed in the examiner's
 * read-only checkout; when that cannot be done or gives nothing usable, its route
 * started fresh with its transcript. The answer says which.
 */
const answer = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  run: ExaminerRun,
  questions: readonly string[],
): Promise<readonly ExaminationQuestion[]> => {
  const builder = run.implementer;
  const route: RouteChoice = {
    target: { harness: builder.harness, provider: builder.provider, model: builder.model },
    eligibleOptions: [
      {
        target: { harness: builder.harness, provider: builder.provider, model: builder.model },
        eligible: true,
      },
    ],
    ruleId: "the builder's own route",
    wasOverride: false,
  };

  if (builder.sessionId !== undefined) {
    const helper = await createHelper(environment, input, "answerer", route);
    const exit = await runHelper(environment, input, helper, {
      worktree: run.checkout,
      task: { kind: "answer", questions },
      resume: builder.sessionId,
    });
    const answers = parseAnswers(
      exit.kind === "completed" ? exit.result : undefined,
      questions,
      "resumed_session",
    );
    await endHelper(environment, input, helper, [exit], answers !== undefined);
    if (answers !== undefined) return answers;
  }

  const transcript = await readTranscript(environment, input, builder.agentId);
  const helper = await createHelper(environment, input, "answerer", route);
  const exit = await runHelper(environment, input, helper, {
    worktree: run.checkout,
    task: { kind: "answer", questions, transcript },
  });
  const answers = parseAnswers(
    exit.kind === "completed" ? exit.result : undefined,
    questions,
    "transcript",
  );
  await endHelper(environment, input, helper, [exit], answers !== undefined);
  return (
    answers ??
    questions.map((question) => ({
      question,
      answer:
        "The builder could not be reached to answer this: neither its session nor its transcript gave an answer.",
      answeredBy: "transcript" as const,
    }))
  );
};

const readTranscript = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  agentId: AgentId,
): Promise<string> => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(
    environment.paths.transcript(input.session.scope.runId, agentId),
    "utf8",
  ).catch(() => "(no transcript was kept)");
  return text.slice(-MAX_TRANSCRIPT_CHARS);
};

// ---------------------------------------------------------------------------
// The arbiter
// ---------------------------------------------------------------------------

/**
 * Rules on every open material finding of `examination`, one arbiter each
 * (D-P8-13). All overturned: the work may land. Any upheld, or any not ruled
 * on: the job fails, naming them.
 */
export const arbitrateAll = async (
  environment: ExecutionEnvironment,
  services: ExaminationServices,
  input: ExamineInput,
  examination: Examination,
  context: { readonly checkout?: string; readonly diff: string; readonly dispute: string },
): Promise<ExaminationOutcome> => {
  const { stores, clock } = environment;
  const scope = input.session.scope;
  let current = examination;
  const open = blockingFindings(current);
  // Mark each disputed first, on the orchestrator's (or the two fixes') say-so.
  const disputedAt = nowIso(clock);
  current = {
    ...current,
    findings: current.findings.map((finding) =>
      finding.resolution === "unresolved" && open.some((candidate) => candidate.id === finding.id)
        ? {
            ...finding,
            resolution: "disputed",
            resolvedBy: { authority: "agent", reason: context.dispute, at: disputedAt },
          }
        : finding,
    ),
  };
  await stores.examinations.put(current);

  const checkout = context.checkout ?? (await preparedCheckout(environment, input, "arbiter"));
  const checkpointBefore = await checkpointHead(environment, input);
  const implementer = await stores.agents.get(scope, current.implementerAgentId);
  const upheld: string[] = [];
  try {
    for (const finding of open) {
      const ruling = await rule(environment, services, input, {
        examination: current,
        finding,
        checkout,
        diff: context.diff,
        dispute: context.dispute,
        checkpointBefore,
        implementer,
      });
      const resolution =
        ruling?.choice === RULING_CHOICES.overturn
          ? "overturned"
          : ruling === undefined
            ? undefined
            : "upheld";
      if (ruling === undefined || resolution === undefined) {
        upheld.push(`${finding.id} (the arbiter did not rule)`);
        continue;
      }
      current = {
        ...current,
        findings: current.findings.map((candidate) =>
          candidate.id === finding.id
            ? {
                ...candidate,
                resolution,
                resolvedBy: {
                  authority: "agent",
                  decisionId: ruling.decisionId,
                  reason: ruling.rationale,
                  at: nowIso(clock),
                },
              }
            : candidate,
        ),
      };
      await stores.examinations.put(current);
      environment.outbox.emit({
        type: "finding.ruled",
        source: "control-plane",
        payload: {
          examinationId: current.examinationId,
          findingId: finding.id,
          ruling: resolution,
          decisionId: ruling.decisionId,
          checkpointBefore,
        },
        executionNodeId: input.node.executionNodeId,
      });
      if (resolution === "upheld") upheld.push(`${finding.id} ${finding.summary}`);
    }
  } finally {
    if (context.checkout === undefined) await removeCheckout(environment, input, checkout);
  }
  if (upheld.length === 0) return { kind: "cleared", examination: current };
  return {
    kind: "upheld",
    examination: current,
    reason: `examination_upheld: an arbiter upheld ${upheld.join("; ")}`.slice(0, 1_900),
  };
};

/** A checkpoint at the program head the ruling is made against: the rollback point (D-P8-13). */
const checkpointHead = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
): Promise<Decision["checkpointBefore"]> => {
  const { head } = await effectiveHead(
    environment.git,
    input.session.repoPath,
    input.session.program.repository.programBranch,
    input.session.scope.runId,
  );
  const checkpointId = environment.ids.next("ckpt");
  const ref = checkpointRef(checkpointId);
  await updateRef(environment.git, input.session.repoPath, ref, head);
  await environment.stores.checkpoints.put({
    schemaVersion: 1,
    ...input.session.scope,
    checkpointId,
    executionNodeId: input.node.executionNodeId,
    commitSha: head,
    ref,
    label: `before an arbiter's ruling on ${input.node.executionNodeId}`,
    createdAt: nowIso(environment.clock),
  });
  environment.outbox.emit({
    type: "checkpoint.created",
    source: "control-plane",
    payload: { checkpointId, ref, commitSha: head, purpose: "ruling" },
    executionNodeId: input.node.executionNodeId,
  });
  return checkpointId;
};

/** One arbiter on one finding: its decision, or `undefined` when it did not rule. */
const rule = async (
  environment: ExecutionEnvironment,
  services: ExaminationServices,
  input: ExamineInput,
  ruling: {
    readonly examination: Examination;
    readonly finding: ExaminationFinding;
    readonly checkout: string;
    readonly diff: string;
    readonly dispute: string;
    readonly checkpointBefore: Decision["checkpointBefore"];
    readonly implementer: Agent | undefined;
  },
): Promise<Decision | undefined> => {
  let route: RouteChoice;
  try {
    route = services.arbiterRoute({
      job: input.job,
      implementer:
        ruling.implementer === undefined
          ? ruling.examination.examinerRoute
          : {
              harness: ruling.implementer.harness,
              provider: ruling.implementer.provider,
              model: ruling.implementer.model,
            },
      examiner: ruling.examination.examinerRoute,
    });
  } catch {
    return undefined;
  }
  const helper = await createHelper(environment, input, "arbiter", route);
  const exit = await runHelper(environment, input, helper, {
    worktree: ruling.checkout,
    task: {
      kind: "arbitrate",
      finding: ruling.finding,
      dispute: ruling.dispute,
      questions: ruling.examination.questions,
      diff: ruling.diff,
    },
    mcp: services.mcp({
      projectId: input.session.scope.projectId,
      programId: input.session.scope.programId,
      runId: input.session.scope.runId,
      nodeId: input.node.executionNodeId,
      agentId: helper.agent.agentId,
      jobContractId: input.job.jobContractId,
      worktree: ruling.checkout,
      role: "arbiter",
      executionToken: helper.token ?? "",
      extraEnv: {
        [RULING_CONTEXT_ENV]: JSON.stringify({
          examinationId: ruling.examination.examinationId,
          findingId: ruling.finding.id,
          checkpointBefore: ruling.checkpointBefore,
        } satisfies RulingContext),
      },
    }),
  });
  const decision = [...(await environment.stores.decisions.listByRun(input.session.scope)).items]
    .filter((candidate) => candidate.agentId === helper.agent.agentId)
    .at(-1);
  await endHelper(environment, input, helper, [exit], decision !== undefined);
  return decision;
};

/** The rest of a ruled-on decision, once the work it let land has a checkpoint (D-P8-13). */
export const recordRulingLanded = async (
  environment: Pick<ExecutionEnvironment, "stores">,
  scope: RunSession["scope"],
  examination: Examination,
  checkpointAfter: Decision["checkpointBefore"],
): Promise<void> => {
  for (const finding of examination.findings) {
    const decisionId =
      finding.resolution === "overturned" ? finding.resolvedBy?.decisionId : undefined;
    if (decisionId === undefined) continue;
    const decision = await environment.stores.decisions.get(scope, decisionId);
    if (decision === undefined || decision.checkpointAfter !== undefined) continue;
    await environment.stores.decisions.put({ ...decision, checkpointAfter }).catch(() => {});
  }
};

/**
 * What a retry after the node's examinations is (D-P8-13, as amended
 * 2026-09-25): an attempt carrying out an arbiter's upheld ruling; a fix with
 * the findings; a refusal; or neither.
 */
export const fixOf = (
  examinations: readonly Examination[],
): { readonly task?: AgentTask; readonly refused?: string } => {
  const last = latestOf(examinations);
  if (last === undefined) return {};
  const rulings = rulingsInForce(examinations);
  if (rulings !== undefined) {
    const attempts = rulingAttemptsOf(examinations);
    if (attempts >= MAX_RULING_ATTEMPTS) {
      return {
        refused:
          `${attempts} attempts have not carried out the arbiter's ruling on ` +
          `${rulings.map((ruling) => ruling.findingId).join(", ")}; the builder could not make ` +
          "the change it was ruled to make. Delegate it differently, or a human may reverse the ruling.",
      };
    }
    const ruled = new Set(rulings.map((ruling) => ruling.findingId));
    const findings = examinations
      .flatMap((examination) => examination.findings)
      .filter((finding) => ruled.has(finding.id) && finding.resolution === "upheld");
    return { task: { kind: "fix", findings, rulings } };
  }
  if (!examinationBlocks(last)) return {};
  if (last.fixAttempt >= MAX_FIX_ATTEMPTS) {
    return {
      refused: `this job has had ${MAX_FIX_ATTEMPTS} fixes of its blocking findings; a third is not tried. Dispute a finding to send it to an arbiter.`,
    };
  }
  return { task: { kind: "fix", findings: blockingFindings(last) } };
};

/**
 * Why Nightshift itself is still taking a stopped job further, or `undefined`
 * when nothing more will happen to it without its orchestrator. From the
 * records alone, so the root's server and a strand's, which holds no engine,
 * answer alike. A job reported settled while an arbiter was ruling on it, or
 * while the engine was about to carry out an upheld ruling, looked finished to
 * its orchestrator, which delegated the same work again; that job landed the
 * work without the ruling (P15's run, 2026-10-07).
 */
export const continuedByNightshift = (
  status: ExecutionNode["status"],
  examinations: readonly Examination[],
): string | undefined => {
  if (status !== "failed" && status !== "examination_failed") return undefined;
  const latest = latestOf(examinations);
  if (latest?.findings.some((finding) => finding.resolution === "disputed") === true) {
    return "an arbiter is ruling on its disputed finding; Nightshift continues the job itself";
  }
  if (rulingDue(examinations)) {
    return "an arbiter upheld a finding; Nightshift starts the attempt that carries the ruling out";
  }
  return undefined;
};

/** Whether a retry after these examinations carries out an arbiter's ruling: the engine's to start. */
export const rulingDue = (examinations: readonly Examination[]): boolean => {
  const fix = fixOf(examinations);
  return fix.task?.kind === "fix" && fix.task.rulings !== undefined;
};

/** Where an examined job's node stands: its latest examination. */
export const latestExamination = async (
  environment: Pick<ExecutionEnvironment, "stores">,
  scope: RunSession["scope"],
  nodeId: ExecutionNodeId,
): Promise<Examination | undefined> =>
  [...(await environment.stores.examinations.listByNode(scope, nodeId))]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The examination gate in the merge queue (D-P8-09), after the node is
 * `verified` on the program head: nothing to do when the policy asks for no
 * examination; the examination of the same change when there is one that lets
 * it land; otherwise an examination here, now, against the commit that would
 * land. `stopped` when that one stops it, with the node ended `examination_failed`.
 */
export const examineInQueue = async (
  environment: ExecutionEnvironment,
  input: Omit<ExamineInput, "phase"> & { readonly verification: Verification },
): Promise<
  { readonly kind: "land"; readonly examination?: Examination } | { readonly kind: "stopped" }
> => {
  if (!requirementOf(input.session, input.job).required) return { kind: "land" };
  const diff = await git(
    environment.git,
    ["diff", "--no-color", "--no-ext-diff", input.base, input.commitSha],
    { cwd: input.session.repoPath },
  );
  const examinations = await environment.stores.examinations.listByNode(
    input.session.scope,
    input.node.executionNodeId,
  );
  const carried = carriedExamination(examinations, patchIdOf(diff));
  if (carried !== undefined) return { kind: "land", examination: carried };

  const outcome = await examine(environment, { ...input, phase: "queue" });
  switch (outcome.kind) {
    case "not_required":
    case "postponed":
      return { kind: "land" };
    case "cleared":
      return { kind: "land", examination: outcome.examination };
    case "candidate_failed":
    case "blocked":
    case "upheld":
    case "examiner_failed": {
      const reason =
        outcome.kind === "candidate_failed"
          ? "examination_failed: its checks failed"
          : outcome.reason;
      const { stores, clock, outbox } = environment;
      const node = await stores.executionNodes.get(input.session.scope, input.node.executionNodeId);
      if (node !== undefined && node.status === "verified") {
        const examining = transition(node, "begin_examination", nowIso(clock));
        await stores.executionNodes.put(examining);
        await stores.executionNodes.put({
          ...transition(examining, "examination_failed", nowIso(clock)),
          outcomeReason: reason,
        });
        outbox.emit({
          type: "node.failed",
          source: "control-plane",
          payload: { reason, examined: "in the merge queue" },
          executionNodeId: input.node.executionNodeId,
        });
      }
      return { kind: "stopped" };
    }
  }
};
