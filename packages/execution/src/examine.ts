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
  ExaminationRequirement,
  ExaminationRuling,
  ExecutionNode,
  ExecutionNodeId,
  JobContract,
  LaunchRef,
  LifecycleObservation,
  MeasurementCounters,
  MeasurementSummary,
  RouteChoice,
  RouteTarget,
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
  MeasurementObservationSchema,
  outcomeOfCommands,
  VerificationSchema,
} from "@nightshift/contracts";
import {
  baselineFor,
  examinationBlocks,
  examinationRequirementFor,
  labelCost,
  nowIso,
  policyOfRun,
  routeUsageFromCounters,
  transition,
  transitionAgent,
} from "@nightshift/core";
import {
  type AgentTask,
  describeExit,
  type ExaminationEvidence,
  type HarnessExit,
  type McpLaunch,
  refusingWorkerTools,
} from "@nightshift/harness";
import {
  deferSignalOf,
  runCheckoutSteps,
  toVerificationCommands,
  verificationFacts,
} from "@nightshift/verification";
import type { ExaminationServices, ExecutionEnvironment, RunSession } from "./environment.js";
import { announceFlakes, rerunFailures, withFlakes } from "./flaky.js";
import { gateDefinitions, landingSteps, withGateDefinitions } from "./gate-repair.js";
import {
  addDetachedWorktree,
  changedPaths,
  checkpointRef,
  effectiveHead,
  git,
  pruneWorktrees,
  tryRevParse,
  updateRef,
} from "./git/index.js";
import { createHookSink } from "./hook-sink.js";
import {
  createMeasurementRecorder,
  type MeasurementRecorder,
  publishedSummaryFor,
} from "./measurement/recorder.js";
import { unmetWhereThisRuns } from "./prerequisites-here.js";
import { unavailableUntil } from "./route-availability.js";
import { programRulings, rulingsCarriedBy } from "./rulings.js";
import { recordArtifact, runAsOf, stepsAs } from "./runner.js";
import { discardScratch, ensureScratch, freshScratch, projectStepEnv } from "./scratch.js";
import { prepareCheckout } from "./setup.js";
import { limitsOf, resolveSteps } from "./step-adjustments.js";
import { announceSteps, skippedStepsPayload } from "./verify.js";

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
  /** The routing decision of the attempt examined, when known (P20). */
  readonly implementerRoutingDecisionId?: RoutingDecision["routingDecisionId"];
  readonly examinerRoute: RoutingDecision["chosen"];
  readonly requiredByRisk: JobContract["risk"];
  readonly blocking: boolean;
  readonly fixAttempt: number;
  readonly round: 1 | 2;
  readonly questions: readonly ExaminationQuestion[];
  /** The arbiter's rulings the attempt carried out: the examination checks only these. */
  readonly followsRulings?: readonly ExaminationRuling[];
  /** Why this examiner is less independent than the policy asks, when the policy let it be. */
  readonly independenceWaived?: { readonly reason: string };
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
  /**
   * Nothing to judge with: no examiner could be routed, or every one that ran
   * gave no verdict. Not the work's failure: it goes on unreviewed, for a human
   * (the owner's ruling, 2026-10-13). `patchId` names the change, when known.
   */
  | {
      readonly kind: "examiner_failed";
      readonly reason: string;
      readonly patchId?: string;
      /**
       * True when examiners were tried and none could review (a limit, a
       * login, a launch, no verdict): the work goes on unreviewed. False when
       * this engine cannot examine at all (no examination services, the
       * builder not on record): a fault to see, which fails as it always did.
       */
      readonly skippable: boolean;
    };

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
  /**
   * True once the job has been asked to stop. Beside the queue, an examination
   * that waits for a limited examiner (D-P8-10, as amended 2026-10-12) stops
   * waiting on it; in the queue nothing waits.
   */
  readonly stopped?: () => boolean;
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

/**
 * The examination whose verdict this very change still carries, when that
 * verdict stops it: the latest examination of the same patch, if it blocks. A
 * finding overturned by an arbiter no longer blocks, so the change then lands
 * on the examination it has (`carriedExamination`).
 */
export const standingBlock = (
  examinations: readonly Examination[],
  patchId: string,
): Examination | undefined => {
  const same = [...examinations]
    .filter((examination) => examination.patchId === patchId && examination.outcome !== "failed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  return same !== undefined && examinationBlocks(same) ? same : undefined;
};

/**
 * Every examination of the work this node is doing: its own, and, for a
 * strand, every node of the same strand in the run, so a strand delegated
 * again on a new node still carries the verdicts its earlier nodes were given
 * (PIP-30). A retry on the node and a re-delegation are the same strand's work.
 */
const examinationsOfTheWork = async (
  environment: Pick<ExecutionEnvironment, "stores">,
  input: Pick<ExamineInput, "session" | "node" | "job">,
): Promise<readonly Examination[]> => {
  const { stores } = environment;
  const scope = input.session.scope;
  const strandId = input.job.strandId;
  if (strandId === undefined)
    return stores.examinations.listByNode(scope, input.node.executionNodeId);
  const pages = async <T>(
    list: (page: {
      cursor?: string;
    }) => Promise<{ items: readonly T[]; cursor?: string | undefined }>,
  ): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(cursor === undefined ? {} : { cursor });
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return items;
  };
  const [nodes, jobs] = await Promise.all([
    pages((page) => stores.executionNodes.listByRun(scope, page)),
    pages((page) => stores.jobContracts.listByRun(scope, page)),
  ]);
  const ofStrand = new Set(
    jobs.filter((job) => job.strandId === strandId).map((job) => job.jobContractId as string),
  );
  const strandNodes = nodes.filter(
    (node) =>
      node.executionNodeId === input.node.executionNodeId ||
      (node.kind === input.node.kind &&
        node.jobContractId !== null &&
        ofStrand.has(node.jobContractId)),
  );
  return (
    await Promise.all(
      strandNodes.map((node) => stores.examinations.listByNode(scope, node.executionNodeId)),
    )
  ).flat();
};

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
 * How many examiner routes one examination tries when limits stop them, before
 * it gives up as it always did. More than any examiner list is long in practice.
 */
const MAX_EXAMINER_ROUTES = 4;

/** How often a wait for a limited examiner looks at the clock and at whether the job was stopped. */
const LIMIT_WAIT_POLL_MS = 60_000;

const progress = (
  environment: ExecutionEnvironment,
  input: Pick<ExamineInput, "node">,
  message: string,
): void => {
  environment.outbox.emit({
    type: "node.progress",
    source: "control-plane",
    payload: { message },
    executionNodeId: input.node.executionNodeId,
  });
};

/** Whether a helper's last exit says its route cannot serve now, and until when. */
const limitOf = (
  exit: HarnessExit | undefined,
  environment: ExecutionEnvironment,
): { readonly reason: string; readonly until?: string } | undefined => {
  if (exit?.kind !== "failed" || exit.unavailable === undefined) return undefined;
  const until = unavailableUntil(exit, environment.clock);
  return { reason: exit.unavailable, ...(until === undefined ? {} : { until }) };
};

const sameRoute = (
  a: Pick<RouteTarget, "harness" | "model">,
  b: Pick<RouteTarget, "harness" | "model">,
): boolean => a.harness === b.harness && a.model === b.model;

/**
 * The examiner's route (D-P8-10), or why there is none. When the independence
 * the policy asks for is only out of reach because limited routes are out
 * (amending D-P8-10, 2026-10-12), the requirement's `whenIndependentUnavailable`
 * decides: `strongest` examines now on the strongest route that can run;
 * `wait`, or nothing said, holds the examination until the first of those
 * routes resets. Only beside the queue: the queue is the one serial path, and
 * nothing waits in it.
 */
const examinerFor = async (
  environment: ExecutionEnvironment,
  services: ExaminationServices,
  input: ExamineInput,
  implementer: RouteTarget,
  requirement: ExaminationRequirement,
  passedOver: readonly Pick<RouteTarget, "harness" | "model">[] = [],
): Promise<RoutedExaminer | string> => {
  for (;;) {
    const unavailable = [...(environment.routes?.unavailable() ?? []), ...passedOver];
    const independent = (out: readonly Pick<RouteTarget, "harness" | "model">[]) =>
      services.examinerRoute({
        job: input.job,
        implementer,
        mustDifferModel: requirement.mustDifferModel,
        mustDifferProvider: requirement.mustDifferProvider,
        unavailable: out,
      });
    let refused: string;
    try {
      return { route: independent(unavailable) };
    } catch (error) {
      refused = `examiner_failed: no examiner could be routed: ${messageOf(error)}`;
    }
    const until = independentReturn(environment.routes, unavailable, independent);
    if (until === undefined) return refused;
    if (requirement.whenIndependentUnavailable === "strongest") {
      return strongestExaminer(environment, services, input, implementer, unavailable, until);
    }
    if (input.phase === "queue" || input.stopped === undefined) {
      return `${refused}; an independent examiner returns at ${until}`;
    }
    const stopped = await waitUntil(environment, input, until, input.stopped);
    if (stopped) return `${refused}; stopped while waiting until ${until}`;
  }
};

interface RoutedExaminer {
  readonly route: RouteChoice;
  /** Why it is less independent than the policy asks, when the policy let it be. */
  readonly waived?: { readonly reason: string };
}

/**
 * When an independent examiner could run again, if only limits stand in its
 * way: the earliest reset among the limited routes, each of which would let
 * one run. `undefined` when none would, or none is coming back.
 */
const independentReturn = (
  routes: ExecutionEnvironment["routes"],
  unavailable: readonly Pick<RouteTarget, "harness" | "model">[],
  independent: (out: readonly Pick<RouteTarget, "harness" | "model">[]) => RouteChoice,
): string | undefined => {
  if (routes === undefined) return undefined;
  const wouldServe = (route: Pick<RouteTarget, "harness" | "model">): boolean => {
    try {
      independent(unavailable.filter((other) => !sameRoute(other, route)));
      return true;
    } catch {
      return false;
    }
  };
  const blocking = unavailable.filter(
    (route) => routes.earliestReturn([route]) !== undefined && wouldServe(route),
  );
  return blocking.length === 0 ? undefined : routes.earliestReturn(blocking);
};

/** The strongest route that can run now, as `strongest` allows, and why it is not independent. */
const strongestExaminer = (
  environment: ExecutionEnvironment,
  services: ExaminationServices,
  input: ExamineInput,
  implementer: RouteTarget,
  unavailable: readonly Pick<RouteTarget, "harness" | "model">[],
  until: string,
): RoutedExaminer | string => {
  let route: RouteChoice;
  try {
    route = services.strongestExaminerRoute({ job: input.job, implementer, unavailable });
  } catch (error) {
    return `examiner_failed: no examiner could be routed: ${messageOf(error)}`;
  }
  const limits = `no examiner independent enough could run until ${until} (usage limits)`;
  progress(
    environment,
    input,
    `${limits}; examining now on the strongest route, ${route.target.model}, as the policy allows`,
  );
  return {
    route,
    waived: {
      reason: `${limits}; examined on the strongest route, ${route.target.model}, as the policy allows`,
    },
  };
};

/** Waits until `until`, as `wait` says. True when the job was stopped first. */
const waitUntil = async (
  environment: ExecutionEnvironment,
  input: ExamineInput,
  until: string,
  stopped: () => boolean,
): Promise<boolean> => {
  progress(
    environment,
    input,
    `no examiner independent enough can run until ${until} (usage limits); waiting for it, as the policy says`,
  );
  const sleep =
    environment.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const at = Date.parse(until);
  while (environment.clock.now() < at) {
    if (stopped()) return true;
    await sleep(Math.min(LIMIT_WAIT_POLL_MS, at - environment.clock.now()));
  }
  return false;
};

/**
 * The examiner's verdict, from the first route that gives one. A limit that
 * stops an examiner (D-P8-06, as amended 2026-10-12) puts its route out until
 * it resets, and the next one examines; any other ending is the examination's.
 */
const examineOnSomeRoute = async (
  environment: ExecutionEnvironment,
  services: ExaminationServices,
  input: ExamineInput,
  work: {
    readonly checkout: string;
    readonly gathered: Exclude<Awaited<ReturnType<typeof gatherEvidence>>, { kind: string }>;
    readonly builder: NonNullable<Awaited<ReturnType<typeof builderOf>>>;
    readonly requirement: ExaminationRequirement;
  },
): Promise<Examination | string> => {
  const { gathered, builder, requirement } = work;
  // Every examiner that could not review, and why: passed over for this
  // examination, the next on the list tries (the owner's ruling, 2026-10-13).
  const passedOver: RouteTarget[] = [];
  const why: string[] = [];
  const noneCould = (last: string) =>
    why.length === 0 ? last : `examiner_failed: no examiner could review it: ${why.join("; ")}`;
  for (let attempt = 1; ; attempt += 1) {
    const routed = await examinerFor(
      environment,
      services,
      input,
      builder.route,
      requirement,
      passedOver,
    );
    if (typeof routed === "string") return noneCould(routed);
    const { route } = routed;
    const frame: Omit<ExaminationContext, "round" | "questions"> = {
      examinationId: environment.ids.next("exam"),
      verificationId: gathered.verification.verificationId,
      commitSha: input.commitSha,
      patchId: gathered.patchId,
      implementerAgentId: builder.agent.agentId,
      implementerRoutingDecisionId: builder.routingDecisionId,
      examinerRoute: route.target,
      requiredByRisk: input.job.risk,
      blocking: requirement.blockOnMaterialFindings,
      fixAttempt: gathered.evidence.fixAttempt,
      ...(gathered.evidence.rulings === undefined
        ? {}
        : { followsRulings: gathered.evidence.rulings }),
      ...(routed.waived === undefined ? {} : { independenceWaived: routed.waived }),
    };
    const ran = await runExaminer(environment, services, input, {
      checkout: work.checkout,
      route,
      evidence: gathered.evidence,
      frame,
      implementer: builder.agent,
    });
    if ("examination" in ran) return ran.examination;
    // A limit puts the route out for the run, until it resets (D-P8-06); any
    // other ending passes it over for this examination only.
    if (ran.limited !== undefined && environment.routes !== undefined) {
      environment.routes.markUnavailable(route.target, ran.limited.until);
    } else {
      passedOver.push(route.target);
    }
    const because = ran.limited?.reason ?? ran.ended;
    why.push(`${route.target.model} (${because})`);
    if (attempt >= MAX_EXAMINER_ROUTES) return noneCould(ran.reason);
    progress(
      environment,
      input,
      `the examiner on ${route.target.model} could not review (${because}); trying the next`,
    );
  }
};

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
      skippable: false,
      reason:
        "examiner_failed: this run's policy requires an examiner, and this execution environment has none",
    };
  }
  const builder = await builderOf(environment, input);
  if (builder === undefined) {
    return {
      kind: "examiner_failed",
      skippable: false,
      reason: "examiner_failed: the work's own route and agent are not on the record",
    };
  }

  const checkout = await examinationCheckout(environment, input);
  try {
    const gathered = await gatherEvidence(environment, input, checkout, requirement);
    if ("kind" in gathered) return gathered;

    const examination = await examineOnSomeRoute(environment, services, input, {
      checkout,
      gathered,
      builder,
      requirement,
    });
    if (typeof examination === "string") {
      return {
        kind: "examiner_failed",
        reason: examination,
        patchId: gathered.patchId,
        skippable: true,
      };
    }
    announceVerdict(environment, input, examination);
    await closeFixedFindings(environment, input, examination);
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
): Promise<
  | {
      readonly agent: Agent;
      readonly route: RoutingDecision["chosen"];
      readonly routingDecisionId: RoutingDecision["routingDecisionId"];
    }
  | undefined
> => {
  const decisions = await environment.stores.routingDecisions.listByNode(
    input.session.scope,
    input.node.executionNodeId,
  );
  const last = decisions
    .filter((decision) => decision.purpose === undefined)
    .sort((a, b) => a.attempt - b.attempt)
    .at(-1);
  const agent = await implementerOf(environment, input);
  return last === undefined || agent === undefined
    ? undefined
    : { agent, route: last.chosen, routingDecisionId: last.routingDecisionId };
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
  | Extract<ExaminationOutcome, { kind: "postponed" | "candidate_failed" | "blocked" }>
> => {
  const diff = await git(
    environment.git,
    ["diff", "--no-color", "--no-ext-diff", input.base, input.commitSha],
    { cwd: checkout },
  );
  // A change keeps its verdict (PIP-30). Examined again unchanged, a blocked
  // change was once let land by a second examiner who saw it otherwise, an
  // arbiter's ruling and all.
  const standing = standingBlock(await examinationsOfTheWork(environment, input), patchIdOf(diff));
  if (standing !== undefined) {
    return {
      kind: "blocked",
      examination: standing,
      reason:
        `${describeBlocking(standing)} (unchanged since examination ${standing.examinationId}: the same change is not examined again)`.slice(
          0,
          1_900,
        ),
    };
  }
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
      ...(previous !== undefined && fixAttempt > 0
        ? {
            previousFindings: previous.findings.map((finding) => ({
              ...finding,
              examinationId: previous.examinationId,
            })),
          }
        : {}),
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

const findingKey = (examinationId: string, findingId: string): string =>
  `${examinationId}:${findingId}`;

/**
 * Closes, as `fixed`, the earlier findings a later examination of the node did
 * not raise again. `fixed` means only that: reassessed by a later examination
 * of a later attempt and not raised again, following `repeats` chains. A
 * `failed` examination, one of the same attempt, and a ruling-only check (which
 * may close only the findings its rulings name) do not close anything. Never
 * touches a finding that is not `unresolved` and material. Never throws.
 */
export const closeFixedFindings = async (
  environment: ExecutionEnvironment,
  input: Pick<ExamineInput, "session" | "node">,
  recorded: Examination,
): Promise<void> => {
  try {
    if (recorded.outcome === "failed") return;
    const scope = input.session.scope;
    const all = await environment.stores.examinations.listByNode(scope, input.node.executionNodeId);
    const latest = all.find((examination) => examination.examinationId === recorded.examinationId);
    const current = latest ?? recorded;
    const byKey = new Map<string, ExaminationFinding>();
    for (const examination of all) {
      for (const finding of examination.findings) {
        byKey.set(findingKey(examination.examinationId, finding.id), finding);
      }
    }
    // Every finding some finding of the current examination is a later occurrence of.
    const reached = new Set<string>();
    for (const finding of current.findings) {
      let next = finding.repeats;
      while (next !== undefined) {
        const key = findingKey(next.examinationId, next.findingId);
        if (reached.has(key)) break;
        reached.add(key);
        next = byKey.get(key)?.repeats;
      }
    }
    const rulingIds =
      current.followsRulings === undefined
        ? undefined
        : new Set(current.followsRulings.map((ruling) => ruling.findingId));
    const at = nowIso(environment.clock);
    for (const earlier of all) {
      if (earlier.examinationId === current.examinationId) continue;
      if (earlier.createdAt >= current.createdAt) continue;
      // The same patch is the same work, whoever handed it in (PIP-30): an
      // examination of it is no reassessment of a later attempt.
      const laterAttempt =
        current.patchId !== earlier.patchId &&
        (current.fixAttempt > earlier.fixAttempt ||
          current.implementerAgentId !== earlier.implementerAgentId);
      if (!laterAttempt) continue;
      let changed = false;
      const findings = earlier.findings.map((finding) => {
        if (finding.severity !== "material" || finding.resolution !== "unresolved") return finding;
        if (rulingIds !== undefined && !rulingIds.has(finding.id)) return finding;
        if (reached.has(findingKey(earlier.examinationId, finding.id))) return finding;
        changed = true;
        return {
          ...finding,
          resolution: "fixed" as const,
          resolvedBy: {
            authority: "agent" as const,
            examinationId: current.examinationId,
            reason: `not raised again by ${current.examinationId}`,
            at,
          },
        };
      });
      if (changed) await environment.stores.examinations.put({ ...earlier, findings });
    }
  } catch {
    progress(environment, input, "could not mark earlier findings fixed; they stay unresolved");
  }
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
    // A job's builder is its worker. A strand's is its orchestrator (P18): it
    // authored the job plan and briefed every job, and it is the agent on the
    // strand's node the examination is held independent of.
    .filter(
      (agent) => agent.role === (input.node.kind === "sub-program" ? "orchestrator" : "worker"),
    )
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
  await discardScratch(environment.paths, path, environment.reclaim);
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
  // The job's gates, as the queue's verification has them; the run's end gates
  // are the run's to pass, once its work has landed (A-57).
  const resolved = await resolveSteps(
    environment.stores,
    input.session.scope,
    landingSteps(gates),
    limitsOf(input.session.program),
  );
  const steps: readonly VerificationStep[] = resolved.runnable;
  if (steps.some((step) => (step.requires ?? []).length > 0)) {
    // Met where this engine runs: on a machine, by that machine's own check,
    // made now when it has none (prerequisites-here.ts).
    const unmet = await unmetWhereThisRuns(environment, input.session, steps);
    if (steps.some((step) => (step.requires ?? []).some((id) => unmet.has(id)))) return "postponed";
  }

  const startedAt = nowIso(environment.clock);
  // The checkout is new and holds only what is committed, so setup comes first;
  // it also leaves the checkout usable for the examiner who works in it. The
  // checks get a fresh scratch (scratch.ts), which the examiner then inherits.
  // On a machine, in the project environment, and **as the project's user**,
  // exactly as the queue's are (D-10, D-P10-30): run as the engine, a check
  // could not reach what only the project user can, its rootless Docker
  // socket first (keki-backend, 2026-10-13: every Docker-backed gate failed).
  const worker = await implementerOf(environment, input);
  const runAs = environment.runAs?.({ agentId: worker?.agentId ?? "", role: "worker" });
  const as = stepsAs(environment, { agentId: worker?.agentId ?? "", role: "worker" });
  const scratch = await freshScratch(environment.paths, checkout, environment.reclaim);
  if (runAs !== undefined) {
    await runAs.grant(checkout);
    await runAs.grant(scratch);
  }
  // Told to every step (D-P17-06): the record's id, minted first, the commit,
  // and the job's base it was cut from.
  const verificationId = environment.ids.next("ver");
  const baseSha = await tryRevParse(environment.git, input.session.repoPath, `${input.commitSha}^`);
  const projectEnv = {
    ...(environment.secretEnv ?? {}),
    ...(environment.projectEnv ?? {}),
    ...verificationFacts({ verificationId, headSha: input.commitSha, baseSha }),
  };
  const ran = await runCheckoutSteps({
    setup: gates.setup,
    steps,
    cwd: checkout,
    reference: input.session.repoPath,
    env: projectStepEnv(projectEnv, scratch),
    onStep: announceSteps(environment, {
      nodeId: input.node.executionNodeId,
      label: "candidate verification",
    }),
    ...as,
  });
  // A check that declared it could not run (exit 75 and a NIGHTSHIFT_DEFER
  // line) is a hurdle, not a failure of the work: the job goes on to the queue,
  // whose verification records the prerequisite and defers the check, and it
  // is examined at resume once that check passes (D-P8-14), as a planned one is.
  if (
    ran.checks.some(
      (result) =>
        deferSignalOf(result.exitCode, new TextDecoder().decode(result.output)) !== undefined,
    )
  ) {
    return "postponed";
  }
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
    keepScratch: true,
    ...(as.as === undefined ? {} : { as: as.as }),
    ...(environment.reclaim === undefined ? {} : { reclaim: environment.reclaim }),
    projectEnv,
  });
  const checkCommands = await withFlakes(
    environment,
    { scope: input.session.scope, nodeId: input.node.executionNodeId },
    toVerificationCommands(results, logs as never),
    reruns,
  );
  // The contract's order, a skipped step recorded as skipped (P19 S-02).
  const recorded = new Map(checkCommands.map((command) => [command.stepId, command]));
  const setupIds = new Set(ran.setup.map((result) => result.stepId));
  const commands = [
    ...checkCommands.filter((command) => setupIds.has(command.stepId)),
    ...resolved.steps.flatMap((step) => {
      const skippedBy = resolved.skipped.get(step.id);
      if (skippedBy !== undefined) {
        return [
          {
            stepId: step.id,
            command: step.command,
            durationMs: 0,
            skipped: { decisionId: skippedBy },
          },
        ];
      }
      const found = recorded.get(step.id);
      return found === undefined ? [] : [found];
    }),
  ];
  const workerId = worker?.agentId;
  const attemptDecisionId = (await builderOf(environment, input).catch(() => undefined))
    ?.routingDecisionId;
  const verification = VerificationSchema.parse({
    schemaVersion: 1,
    ...input.session.scope,
    verificationId,
    executionNodeId: input.node.executionNodeId,
    jobContractId: input.job.jobContractId,
    agentId: workerId,
    ...(attemptDecisionId === undefined ? {} : { routingDecisionId: attemptDecisionId }),
    commitSha: input.commitSha,
    phase: "candidate",
    commands,
    outcome: outcomeOfCommands(commands),
    startedAt,
    endedAt: nowIso(environment.clock),
  }) as Verification;
  await environment.stores.verifications.put(verification);
  announceFlakes(environment, verification, workerId);
  const failingSteps = verification.commands
    .filter((command) => command.exitCode !== undefined && command.exitCode !== 0)
    .map((command) => command.stepId);
  environment.outbox.emit({
    type: "verification.completed",
    source: "control-plane",
    payload: {
      verificationId: verification.verificationId,
      outcome: verification.outcome,
      commitSha: input.commitSha,
      phase: "candidate",
      ...(failingSteps.length === 0 ? {} : { failingSteps }),
      ...skippedStepsPayload(verification),
    },
    executionNodeId: input.node.executionNodeId,
    ...(workerId === undefined ? {} : { agentId: workerId }),
  });
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
      ...(command.rerun === undefined ? {} : { rerunExitCode: command.rerun.exitCode }),
    });
  }
  return steps;
};

// ---------------------------------------------------------------------------
// Agents that are not the job's own
// ---------------------------------------------------------------------------

export interface HelperAgent {
  readonly agent: Agent;
  readonly decision: RoutingDecision;
  readonly token: string | undefined;
  /** This agent's measurement recorder, spanning every launch of it. */
  readonly recorder: MeasurementRecorder;
  /** Whether the recorder has a segment open to take a lifecycle observation, and which launch it is. */
  readonly segment: { open: boolean; launch?: LaunchRef; agentMs?: number };
}

/** What a helper's lifecycle observation says; the rest is stamped from the helper and the clock. */
export interface LifecycleSpec {
  readonly operationId: string;
  readonly phase: string;
  readonly transition: "start" | "end" | "note";
  readonly reason?: string;
  readonly blockers?: LifecycleObservation["blockers"];
  readonly refs?: LifecycleObservation["refs"];
  readonly parentOperationId?: string;
}

const lifecycleCounters = new WeakMap<object, Map<string, number>>();

/**
 * Observes a transition of an examination-side operation: a complete
 * `LifecycleObservation` through the S-01 seam, as a `lifecycle.observed` event
 * and, while the helper's recorder segment is open, into its ledger. Never
 * throws; `undefined` when the observation could not be built.
 */
export const observeLifecycle = (
  environment: ExecutionEnvironment,
  input: Pick<HelperInput, "session" | "node">,
  helper: HelperAgent,
  spec: LifecycleSpec,
): LifecycleObservation | undefined => {
  try {
    const at = nowIso(environment.clock);
    const base = `${spec.operationId}:${spec.transition}:${at}`;
    // The same transition of the same operation in one instant is another
    // occurrence (a note, or a rerun on a frozen clock), not a redelivery.
    const counts = lifecycleCounters.get(environment.outbox) ?? new Map<string, number>();
    lifecycleCounters.set(environment.outbox, counts);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    const scope = input.session.scope;
    const candidate = {
      kind: "lifecycle",
      observationId: seen === 0 ? base : `${base}:${seen}`,
      schemaVersion: 1,
      projectId: scope.projectId,
      programId: scope.programId,
      runId: scope.runId,
      executionNodeId: input.node.executionNodeId,
      agentId: helper.agent.agentId,
      ...(helper.segment.launch === undefined ? {} : { launch: helper.segment.launch }),
      source: "engine",
      provenance: { adapter: "execution" },
      occurredAt: at,
      receivedAt: at,
      inclusion: "self",
      operationId: spec.operationId,
      phase: spec.phase,
      transition: spec.transition,
      ...(spec.reason === undefined ? {} : { reason: spec.reason.slice(0, 400) }),
      blockers: spec.blockers ?? [],
      ...(spec.refs === undefined ? {} : { refs: spec.refs }),
      ...(spec.parentOperationId === undefined
        ? {}
        : { parentOperationId: spec.parentOperationId }),
    };
    const parsed = MeasurementObservationSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.kind !== "lifecycle") return undefined;
    const observation = parsed.data;
    environment.outbox.emit({
      type: "lifecycle.observed",
      source: "control-plane",
      payload: observation,
      executionNodeId: input.node.executionNodeId,
      agentId: helper.agent.agentId,
      occurredAt: at,
    });
    if (helper.segment.open) helper.recorder.lifecycle(observation);
    return observation;
  } catch {
    return undefined;
  }
};

/** The operation id of one examination of a node. */
const examinationOperation = (nodeId: string, examinationId: string): string =>
  `examination:${nodeId}:${examinationId}`;

/** The part of an examination's input a helper agent needs: where, and for which job. */
export type HelperInput = Pick<ExamineInput, "session" | "node" | "job">;

/** An agent on the job's node for an examiner, an answerer or an arbiter: record, route, token. */
export const createHelper = async (
  environment: ExecutionEnvironment,
  input: HelperInput,
  role: "examiner" | "answerer" | "arbiter",
  route: RouteChoice,
  /** What the helper is for, written on its routing decision. */
  concerning: NonNullable<RoutingDecision["concerning"]>,
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
    ...(route.role === undefined ? {} : { role: route.role }),
    ...(route.position === undefined ? {} : { position: route.position }),
    ...(route.policyVersion === undefined ? {} : { policyVersion: route.policyVersion }),
    purpose,
    concerning,
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
  const prices = input.session.run?.policy?.routingPolicy.prices;
  const price = prices?.[route.target.model];
  const recorder = createMeasurementRecorder(environment, {
    scope,
    executionNodeId: nodeId,
    agent: started,
    route: route.target,
    routingDecisionId: decision.routingDecisionId,
    ...(price === undefined ? {} : { price }),
    ...(prices === undefined ? {} : { prices }),
  });
  return { agent: started, decision, token, recorder, segment: { open: false } };
};

/**
 * What the helper's own session had consumed before it is resumed. Its first
 * launch learned the session id only from its exit, so its segment carries none:
 * the segments that started without one are the session being resumed.
 */
const ownSessionBaseline = (
  summary: MeasurementSummary,
  sessionId: string,
): MeasurementCounters | undefined =>
  baselineFor(
    {
      ...summary,
      segments: summary.segments.map((segment) =>
        segment.sessionId === undefined ? { ...segment, sessionId } : segment,
      ),
    },
    sessionId,
  );

/** One run of a helper's harness process. */
export const runHelper = async (
  environment: ExecutionEnvironment,
  input: HelperInput,
  helper: HelperAgent,
  launch: {
    readonly worktree: string;
    readonly task: AgentTask;
    readonly mcp?: McpLaunch | undefined;
    readonly resume?: string | undefined;
    /** The session's counters before this launch, when it is another agent's session. */
    readonly baseline?: MeasurementCounters | undefined;
    /** Lifecycle observations made as this launch begins, handed to the ledger once its segment is open. */
    readonly opening?: readonly (LifecycleObservation | undefined)[];
  },
): Promise<HarnessExit> => {
  const { recorder } = helper;
  const transcript = environment.paths.transcript(input.session.scope.runId, helper.agent.agentId);
  await mkdir(dirname(transcript), { recursive: true });
  // The helper's checkout is its own from here on (D-P10-25).
  const { runAs } = runAsOf(environment, helper.agent);
  const tmpDir = await ensureScratch(environment.paths, launch.worktree);
  if (runAs !== undefined) {
    await runAs.grant(launch.worktree);
    await runAs.grant(tmpDir);
  }
  let exit: HarnessExit;
  let launchedAtMs: number | undefined;
  try {
    const ref = await recorder.startSegment({
      ...(launch.resume === undefined ? {} : { sessionId: launch.resume }),
      resumedSession: launch.resume !== undefined,
      ...(launch.baseline === undefined ? {} : { baseline: launch.baseline }),
    });
    helper.segment.open = true;
    helper.segment.launch = ref;
    for (const observation of launch.opening ?? []) {
      if (observation !== undefined) recorder.lifecycle(observation);
    }
    launchedAtMs = environment.clock.now();
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
      launch: ref,
      measurements: recorder.sink,
    });
    exit = await handle.exit;
  } catch {
    // The adapter could not even attempt a launch: the helper did not run.
    exit = { kind: "failed", exitCode: 127 };
  }
  // Agent time: this launch's own interval, summed over a helper's launches (P20).
  if (launchedAtMs !== undefined) {
    helper.segment.agentMs =
      (helper.segment.agentMs ?? 0) + Math.max(0, environment.clock.now() - launchedAtMs);
  }
  recorder.recordExit(exit);
  // A resume's baseline is read from what this launch left in the summary.
  await recorder.drain();
  return exit;
};

/** A helper agent's ending, with the session it kept, once. */
const endAgent = async (
  environment: ExecutionEnvironment,
  input: HelperInput,
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
export const endHelper = async (
  environment: ExecutionEnvironment,
  input: HelperInput,
  helper: HelperAgent,
  exits: readonly HarnessExit[],
  succeeded: boolean,
): Promise<void> => {
  await endAgent(environment, input, helper, exits.at(-1), succeeded);
  const price = input.session.run?.policy?.routingPolicy.prices[helper.decision.chosen.model];
  const { summary } = await helper.recorder.close();
  helper.segment.open = false;
  await environment.stores.routingDecisions
    .put({
      ...helper.decision,
      usage: labelCost(
        routeUsageFromCounters(summary.totals, {
          ...(summary.valuation.reportedUsd === undefined
            ? {}
            : { reportedUsd: summary.valuation.reportedUsd }),
          ...(helper.segment.agentMs === undefined
            ? {}
            : { agentMs: Math.round(helper.segment.agentMs) }),
        }),
        price,
      ),
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
): Promise<
  | { readonly examination: Examination }
  | {
      readonly reason: string;
      /** How its process ended, for the record of why it was passed over. */
      readonly ended: string;
      readonly limited?: { readonly reason: string; readonly until?: string } | undefined;
    }
> => {
  const helper = await createHelper(environment, input, "examiner", run.route, {
    kind: "examination",
    examinationId: run.frame.examinationId,
  });
  const operationId = examinationOperation(input.node.executionNodeId, run.frame.examinationId);
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
  const started = observeLifecycle(environment, input, helper, {
    operationId,
    phase: "examination",
    transition: "start",
    refs: [
      { kind: "commit", ref: run.frame.commitSha },
      { kind: "verification", ref: run.frame.verificationId },
      { kind: "routing_decision", ref: helper.decision.routingDecisionId },
    ],
  });
  const first = await runHelper(environment, input, helper, {
    worktree: run.checkout,
    task: { kind: "examine", evidence: run.evidence, round: 1 },
    mcp: launchFor(1, []),
    opening: [started],
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
        baseline: ownSessionBaseline(helper.recorder.summary(), session),
      });
      exits.push(second);
      examination = await environment.stores.examinations.get(
        input.session.scope,
        run.frame.examinationId,
      );
    }
  }

  const last = exits.at(-1);
  observeLifecycle(environment, input, helper, {
    operationId,
    phase: "examination",
    transition: "end",
    reason:
      examination !== undefined
        ? `verdict: ${examination.outcome}`
        : last?.kind === "completed"
          ? "no_verdict"
          : "examiner_failed",
  });
  await endHelper(environment, input, helper, exits, examination !== undefined);
  if (examination !== undefined) return { examination };
  return {
    reason: "examiner_failed: the examiner ended without submitting a verdict",
    ended:
      last === undefined
        ? "it never ran"
        : last.kind === "completed"
          ? "it ended without a verdict"
          : describeExit(last),
    limited: limitOf(last, environment),
  };
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
  // The examiner's server flushed its event before its process ended, on the
  // node its token is bound to, the examined one: that node's questions alone,
  // not the run's whole log (2026-10-22).
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await environment.stores.events.listByNode(
      input.session.scope,
      input.node.executionNodeId,
      cursor === undefined ? { type: "examination.asked" } : { type: "examination.asked", cursor },
    );
    for (const event of page.items) {
      if (event.agentId === agentId) found.push(...questionsIn(event.payload));
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

  const concerning = { kind: "examination", examinationId: run.frame.examinationId } as const;
  const examinationOp = examinationOperation(input.node.executionNodeId, run.frame.examinationId);
  let launches = 0;
  /** One answerer launch, as an operation of its own under the examination's. */
  const launchAnswerer = async (
    helper: HelperAgent,
    launch: Parameters<typeof runHelper>[3],
  ): Promise<{ readonly exit: HarnessExit; readonly finish: (answered: boolean) => void }> => {
    launches += 1;
    const operationId = `answer:${run.frame.examinationId}:${launches}`;
    const opening = observeLifecycle(environment, input, helper, {
      operationId,
      phase: "answer",
      transition: "start",
      parentOperationId: examinationOp,
      refs: [{ kind: "routing_decision", ref: helper.decision.routingDecisionId }],
    });
    const exit = await runHelper(environment, input, helper, { ...launch, opening: [opening] });
    return {
      exit,
      finish: (answered) => {
        observeLifecycle(environment, input, helper, {
          operationId,
          phase: "answer",
          transition: "end",
          parentOperationId: examinationOp,
          reason: answered ? "answered" : exit.kind === "completed" ? "no_answer" : "answer_failed",
        });
      },
    };
  };

  if (builder.sessionId !== undefined) {
    const helper = await createHelper(environment, input, "answerer", route, concerning);
    // Another agent's session: its tokens so far are the builder's, not this answerer's.
    const builderSummary = await publishedSummaryFor(
      environment.stores,
      input.session.scope,
      input.node.executionNodeId,
      builder.agentId,
    ).catch(() => undefined);
    const baseline =
      builderSummary === undefined ? undefined : baselineFor(builderSummary, builder.sessionId);
    const { exit, finish } = await launchAnswerer(helper, {
      worktree: run.checkout,
      task: { kind: "answer", questions },
      resume: builder.sessionId,
      baseline,
    });
    const answers = parseAnswers(
      exit.kind === "completed" ? exit.result : undefined,
      questions,
      "resumed_session",
    );
    finish(answers !== undefined);
    await endHelper(environment, input, helper, [exit], answers !== undefined);
    if (answers !== undefined) return answers;
  }

  const transcript = await readTranscript(environment, input, builder.agentId);
  const helper = await createHelper(environment, input, "answerer", route, concerning);
  const { exit, finish } = await launchAnswerer(helper, {
    worktree: run.checkout,
    task: { kind: "answer", questions, transcript },
  });
  const answers = parseAnswers(
    exit.kind === "completed" ? exit.result : undefined,
    questions,
    "transcript",
  );
  finish(answers !== undefined);
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
  const implementer =
    ruling.implementer === undefined
      ? ruling.examination.examinerRoute
      : {
          harness: ruling.implementer.harness,
          provider: ruling.implementer.provider,
          model: ruling.implementer.model,
        };
  // A limit that stops an arbiter sends the ruling to the next route (D-P8-06,
  // as amended 2026-10-12). An arbiter that did not rule for any other reason
  // is not replaced.
  for (let attempt = 1; attempt <= MAX_EXAMINER_ROUTES; attempt += 1) {
    let route: RouteChoice;
    try {
      route = services.arbiterRoute({
        job: input.job,
        implementer,
        examiner: ruling.examination.examinerRoute,
        unavailable: environment.routes?.unavailable() ?? [],
      });
    } catch {
      return undefined;
    }
    const helper = await createHelper(environment, input, "arbiter", route, {
      kind: "examination",
      examinationId: ruling.examination.examinationId,
      findingId: ruling.finding.id,
    });
    const operationId = `arbitration:${ruling.examination.examinationId}:${ruling.finding.id}`;
    const parentOperationId = examinationOperation(
      input.node.executionNodeId,
      ruling.examination.examinationId,
    );
    const opening = observeLifecycle(environment, input, helper, {
      operationId,
      phase: "arbitration",
      transition: "start",
      parentOperationId,
      refs: [
        { kind: "examination", ref: ruling.examination.examinationId },
        { kind: "finding", ref: ruling.finding.id },
        { kind: "routing_decision", ref: helper.decision.routingDecisionId },
      ],
    });
    const exit = await runHelper(environment, input, helper, {
      opening: [opening],
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
    observeLifecycle(environment, input, helper, {
      operationId,
      phase: "arbitration",
      transition: "end",
      parentOperationId,
      reason:
        decision === undefined
          ? "no_ruling"
          : decision.choice === RULING_CHOICES.overturn
            ? "overturned"
            : "upheld",
      ...(decision === undefined ? {} : { refs: [{ kind: "decision", ref: decision.decisionId }] }),
    });
    await endHelper(environment, input, helper, [exit], decision !== undefined);
    const limited = decision === undefined ? limitOf(exit, environment) : undefined;
    if (limited === undefined || environment.routes === undefined) return decision;
    environment.routes.markUnavailable(route.target, limited.until);
    progress(
      environment,
      input,
      `the arbiter on ${route.target.model} could not serve (${limited.reason}); routing another`,
    );
  }
  return undefined;
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
 * What the next attempt after the node's examinations must answer (D-P8-13,
 * as amended 2026-09-25): an arbiter's upheld rulings, with the findings they
 * uphold, which are final; otherwise the latest examination's open blocking
 * findings; otherwise nothing. An upheld finding is no longer open, so it is
 * never among the blocking ones: the rulings are where it is. One rule for a
 * job's fix and a strand's fix round alike.
 */
export const findingsToAnswer = (
  examinations: readonly Examination[],
):
  | {
      readonly findings: readonly ExaminationFinding[];
      readonly rulings?: readonly ExaminationRuling[];
    }
  | undefined => {
  const last = latestOf(examinations);
  if (last === undefined) return undefined;
  const rulings = rulingsInForce(examinations);
  if (rulings !== undefined) {
    const ruled = new Set(rulings.map((ruling) => ruling.findingId));
    const findings = examinations
      .flatMap((examination) => examination.findings)
      .filter((finding) => ruled.has(finding.id) && finding.resolution === "upheld");
    return { findings, rulings };
  }
  return examinationBlocks(last) ? { findings: blockingFindings(last) } : undefined;
};

/**
 * What a retry after the node's examinations is (D-P8-13, as amended
 * 2026-09-25): an attempt carrying out an arbiter's upheld ruling; a fix with
 * the findings; a refusal; or neither.
 */
export const fixOf = (
  examinations: readonly Examination[],
): { readonly task?: AgentTask; readonly refused?: string } => {
  const answer = findingsToAnswer(examinations);
  if (answer === undefined) return {};
  if (answer.rulings !== undefined) {
    const attempts = rulingAttemptsOf(examinations);
    if (attempts >= MAX_RULING_ATTEMPTS) {
      return {
        refused:
          `${attempts} attempts have not carried out the arbiter's ruling on ` +
          `${answer.rulings.map((ruling) => ruling.findingId).join(", ")}; the builder could not make ` +
          "the change it was ruled to make. Delegate it differently, or a human may reverse the ruling.",
      };
    }
    return { task: { kind: "fix", findings: answer.findings, rulings: answer.rulings } };
  }
  if ((latestOf(examinations)?.fixAttempt ?? 0) >= MAX_FIX_ATTEMPTS) {
    return {
      refused: `this job has had ${MAX_FIX_ATTEMPTS} fixes of its blocking findings; a third is not tried. Dispute a finding to send it to an arbiter.`,
    };
  }
  return { task: { kind: "fix", findings: answer.findings } };
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
 * Work no examiner could review goes on unreviewed, its checks having passed,
 * and says so: the owner reviews it when the work is done (the owner's ruling,
 * 2026-10-13: a review that cannot happen never holds the build up, fails a
 * job or throws its work away). Remembered by patch id, so the queue does not
 * try again on the serial path.
 */
export const skipReview = (
  environment: ExecutionEnvironment,
  input: Pick<ExamineInput, "node" | "job" | "commitSha">,
  outcome: { readonly reason: string; readonly patchId?: string },
  where: string,
): void => {
  if (outcome.patchId !== undefined) {
    environment.skippedReviews?.set(input.node.executionNodeId, outcome.patchId);
  }
  environment.outbox.emit({
    type: "examination.skipped",
    source: "control-plane",
    payload: {
      reason: outcome.reason,
      risk: input.job.risk,
      commitSha: input.commitSha,
      ...(outcome.patchId === undefined ? {} : { patchId: outcome.patchId }),
      where,
    },
    executionNodeId: input.node.executionNodeId,
  });
};

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
  const patchId = patchIdOf(diff);
  const carried = carriedExamination(examinations, patchId);
  if (carried !== undefined) return { kind: "land", examination: carried };
  // Its review was skipped beside the queue: no second round on the serial path.
  if (environment.skippedReviews?.get(input.node.executionNodeId) === patchId) {
    return { kind: "land" };
  }

  const outcome = await examine(environment, { ...input, phase: "queue" });
  switch (outcome.kind) {
    case "not_required":
    case "postponed":
      return { kind: "land" };
    case "cleared":
      return { kind: "land", examination: outcome.examination };
    case "examiner_failed":
      if (outcome.skippable) {
        skipReview(environment, input, outcome, "in the merge queue");
        return { kind: "land" };
      }
      return stopInQueue(environment, input, outcome.reason);
    case "candidate_failed":
      return stopInQueue(environment, input, "examination_failed: its checks failed");
    case "blocked":
    case "upheld":
      return stopInQueue(environment, input, outcome.reason);
  }
};

/** A node the queue's examination stopped, ended `examination_failed` through P1's table. */
const stopInQueue = async (
  environment: ExecutionEnvironment,
  input: Pick<ExamineInput, "session" | "node">,
  reason: string,
): Promise<{ readonly kind: "stopped" }> => {
  const { stores, clock, outbox } = environment;
  const node = await stores.executionNodes.get(input.session.scope, input.node.executionNodeId);
  if (node !== undefined && (node.status === "verified" || node.status === "examining")) {
    const examining =
      node.status === "examining" ? node : transition(node, "begin_examination", nowIso(clock));
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
};
