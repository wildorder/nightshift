/**
 * Deterministic verification, and the only place a `Verification` is written
 * (D-P3-06, A-05).
 *
 * ## Why this is not reachable from a worker
 *
 * A worker can move a node to `implemented` and no further. Verification runs
 * here, in the execution layer, after the worker's process has exited, on a
 * **clean checkout** of the commit the worker produced. So a worker cannot run
 * the verification itself and report the result, cannot leave a dirty worktree
 * that makes the tests pass, and cannot write the record that would make its own
 * work `verified`. The MCP server registers no tool that creates one, in either
 * role.
 *
 * The clean checkout matters more than it looks. `reset --hard` and
 * `clean -fdx` discard everything the worker left that is not in the commit,
 * ignored files included, so what is verified is exactly what would integrate.
 * Ignored files are not spared: a worker's own install, a build cache from an
 * earlier verification's other mode, or a generated file no command
 * reproduces would otherwise decide the result without being in the commit.
 * The program's `setup` then runs, every time, and is recorded under
 * `setup:<id>`; a setup that fails fails the verification without the checks
 * running. What is verified is the tracked tree plus what setup produced from
 * it, which is what a developer who cloned the commit and ran the same
 * commands would get.
 *
 * ## A check that fails is run once more
 *
 * Each check that ran and failed (not a declared deferral, not one waiting on
 * a prerequisite; never setup) is rerun exactly once, on the same checkout of
 * the same commit, as the same worker, in a fresh scratch, with no setup and
 * no reset in between (D-P15-06, `flaky.ts`). A rerun that passes makes the
 * check **flaky**: recorded with the rerun's evidence and the first run under
 * `flaky`, it counts as passed, so the node goes on exactly as a pass does and
 * nothing climbs the route. That keeps the run fast, since a flake no longer
 * costs a whole new attempt, and the flake is still seen: `gate.flaked` names
 * it, and the root repairs the gate off the blocking path. A rerun that fails
 * is the failure it always was, recorded as its first run.
 *
 * ## Order
 *
 * Node to `verifying`, run the steps, upload each step's output as an artifact,
 * rerun the failed checks, write the `Verification`, announce any flake
 * (`gate.flaked`), and only then transition. The record exists before
 * the status that depends on it, so a reader can never find a `verified` node
 * with no evidence — and `core`'s `markVerified` would refuse anyway.
 */
import type {
  AgentId,
  ArtifactId,
  CommitSha,
  ExecutionNode,
  ExecutionNodeId,
  JobContract,
  JobContractId,
  Verification,
  VerificationStep,
} from "@nightshift/contracts";
import { outcomeOfCommands, VerificationSchema } from "@nightshift/contracts";
import {
  markVerificationFailed,
  markVerified,
  nowIso,
  prerequisitesOf,
  transition,
  unmetPrerequisitesAt,
} from "@nightshift/core";
import {
  type DeferSignal,
  deferSignalOf,
  runCheckoutSteps,
  type StepEvent,
  setupAsStep,
  toVerificationCommands,
  verificationFacts,
} from "@nightshift/verification";
import type { ExecutionEnvironment, LandingEnvironment, RunSession } from "./environment.js";
import { announceFlakes, rerunFailures, withFlakes } from "./flaky.js";
import { type GateDefinitions, gateDefinitions, landingSteps } from "./gate-repair.js";
import { pristineCheckout, provisionalRef, tryRevParse, updateRef } from "./git/index.js";
import { unmetWhereThisRuns } from "./prerequisites-here.js";
import { recordArtifact, stepsAs } from "./runner.js";
import { discardScratch, freshScratch, projectStepEnv } from "./scratch.js";

export interface VerifyInput {
  readonly session: RunSession;
  readonly node: ExecutionNode;
  readonly job: JobContract;
  readonly agentId: AgentId;
  readonly worktree: string;
  /**
   * True when the commit under verification sits on the run's provisional line
   * (P7, D-P7-10): on top of work whose own checks are still deferred. Such a
   * commit is not yet known to be the one that will land, so even when every
   * step runs and passes, the node is deferred rather than verified.
   */
  readonly onProvisionalLine?: boolean;
  /** `nightshift resume`: the node is `deferred`, not `implemented`, and every step now runs. */
  readonly resuming?: boolean;
}

export type VerifyResult =
  | { readonly passed: true; readonly commitSha: CommitSha; readonly verification: Verification }
  | {
      readonly passed: false;
      readonly verification?: Verification;
      /**
       * Set when nothing failed and the node is `deferred`: the commit belongs on
       * the provisional line, with the prerequisites its checks wait on.
       */
      readonly deferred?: { readonly commitSha: CommitSha; readonly waitingOn: readonly string[] };
    };

/**
 * The commit on the run's provisional line, then the node `deferred` by
 * `markDeferred`, in that order (provisional-line.ts). A resume's node is on
 * the line already, under the commit it is replaying, and only becomes
 * `deferred` again.
 */
const deferOnTheLine = async (
  environment: LandingEnvironment,
  input: VerifyInput,
  commitSha: CommitSha,
  waitingOn: readonly string[],
  markDeferred: () => Promise<void>,
): Promise<void> => {
  if (input.resuming === true) {
    await markDeferred();
    return;
  }
  const line = provisionalRef(input.session.scope.runId);
  await updateRef(environment.git, input.session.repoPath, line, commitSha);
  await markDeferred();
  environment.outbox.emit({
    type: "node.deferred",
    source: "control-plane",
    payload: { commitSha, provisionalRef: line, waitingOn },
    executionNodeId: input.node.executionNodeId,
    agentId: input.agentId,
  });
};

/**
 * The prerequisites that are unmet **now**, from the control plane when this
 * environment can ask it, and from the run's own contract when it cannot.
 */
const unmetPrerequisites = async (
  environment: LandingEnvironment,
  session: RunSession,
  steps: readonly VerificationStep[],
): Promise<ReadonlySet<string>> => {
  const { program } = session;
  if (steps.every((step) => (step.requires ?? []).length === 0)) {
    return new Set();
  }
  // Without a control plane to ask, the contract's own copy is all there is.
  if (environment.prerequisites === undefined) {
    return unmetPrerequisitesAt(prerequisitesOf(program), { where: "laptop" });
  }
  // Met where this engine runs: on a machine, by that machine's own check,
  // made now when it has none (prerequisites-here.ts).
  return unmetWhereThisRuns(environment, session, steps);
};

/**
 * A hurdle a command declared, written to the control plane once. A second step
 * declaring the same id is the same hurdle; the API confirms rather than
 * duplicates, and without a book to write to the deferral still holds locally.
 */
const recordDiscovered = async (
  environment: LandingEnvironment,
  session: RunSession,
  steps: readonly VerificationStep[],
  stepId: string,
  signal: DeferSignal,
): Promise<void> => {
  if (environment.prerequisites === undefined) return;
  const { program, scope } = session;
  const step = steps.find((candidate) => candidate.id === stepId);
  await environment.prerequisites
    .recordDiscovered(
      { projectId: program.projectId, programId: program.programId },
      signal.prerequisiteId,
      {
        runId: scope.runId,
        description: signal.description,
        remediation: signal.remediation,
        // The command that declared it is, until a human writes a better one,
        // the check that it is done: it exits 0 once the hurdle is gone.
        verifyCommand: step?.command ?? "",
      },
    )
    .catch(() => {
      // A prerequisite that already exists (planned, or discovered by another
      // step) is a 409 the book turns into an error. The deferral stands.
    });
};

/**
 * A verification's progress as it happens, on the node's record: each step as
 * it starts and as it ends, with its exit code and time. Without it a long
 * verification was silent until its last step finished, and two queued ones
 * that sat for an hour could not be told from stuck ones (keki-backend,
 * 2026-10-13). Its own event type: `node.progress` is the worker's.
 */
export const announceSteps =
  (
    environment: Pick<ExecutionEnvironment, "outbox">,
    at: { readonly nodeId: ExecutionNodeId; readonly label: string },
  ) =>
  (event: StepEvent): void => {
    const message =
      event.phase === "started"
        ? `${at.label}: ${event.stepId} started`
        : `${at.label}: ${event.stepId} ${event.timedOut ? "timed out" : `exited ${event.exitCode}`} after ${(event.durationMs / 1000).toFixed(1)} s`;
    environment.outbox.emit({
      type: "verification.progress",
      source: "control-plane",
      payload: { message, ...event },
      executionNodeId: at.nodeId,
    });
  };

export interface RunVerificationInput {
  readonly session: RunSession;
  /** The node the record and its artifacts belong to: a job's, or the program node's for the run's end gates. */
  readonly nodeId: ExecutionNodeId;
  /** `null` for the run's end gates: the program node has no job (A-57). */
  readonly jobContractId: JobContractId | null;
  /** The agent whose work is under verification, and who the steps run as on a machine. */
  readonly agentId: AgentId;
  /** A clean checkout of `commitSha`, ready for setup. */
  readonly checkout: string;
  readonly commitSha: CommitSha;
  /**
   * The commit `commitSha` is being landed onto, told to every step as
   * `NIGHTSHIFT_BASE_SHA` (D-P17-06). Absent where there is none: the end gates
   * verify a head, not a change.
   */
  readonly baseSha?: CommitSha | undefined;
  readonly gates: GateDefinitions;
  /** The steps to run, from `gates.verification`: a job's landing steps, or the run's end gates. */
  readonly steps: readonly VerificationStep[];
  /** Absent for the queue's own verification, as the record has always read it. */
  readonly phase?: "run";
  /** How progress lines name this verification. */
  readonly label: string;
  /** `nightshift resume`: the preflight has passed, and every step now runs. */
  readonly resuming?: boolean;
}

export interface RunVerificationResult {
  readonly verification: Verification;
  /** The prerequisites the deferred steps wait on, planned and discovered. */
  readonly waitingOn: readonly string[];
  /** What `announceFlakes` said, for the completion event. */
  readonly flakyPayload: ReturnType<typeof announceFlakes>;
}

/**
 * Runs `steps` on `checkout` and writes the `Verification`: setup first, each
 * step's output as an artifact, the failed checks once more (D-P15-06), the
 * deferrals planned and declared (D-P7-10), the record in the contract's own
 * order. The one way a verification is made, whatever is being verified: a
 * job's commit in the queue, or the program head at the run's end (A-57).
 * What the record then means for a node is the caller's.
 */
export const runVerification = async (
  environment: LandingEnvironment,
  input: RunVerificationInput,
): Promise<RunVerificationResult> => {
  const { stores, clock } = environment;
  const { session, gates, steps } = input;
  const startedAt = nowIso(clock);
  const announce = announceSteps(environment, { nodeId: input.nodeId, label: input.label });
  // The record's id is minted first, so every step can be told it (D-P17-06):
  // a project's script names what it keeps per verification by it.
  const verificationId = environment.ids.next("ver");
  const projectEnv = {
    ...(environment.projectEnv ?? {}),
    ...verificationFacts({ verificationId, headSha: input.commitSha, baseSha: input.baseSha }),
  };

  // A step that needs a human prerequisite nobody has met **cannot run**, and is
  // deferred; every other step runs (D-P7-10). When resuming, the preflight has
  // already passed, and every step runs.
  const unmet =
    input.resuming === true
      ? new Set<string>()
      : await unmetPrerequisites(environment, session, steps);
  const waitingOf = (step: VerificationStep): readonly string[] =>
    (step.requires ?? []).filter((id) => unmet.has(id));
  const runnable = steps.filter((step) => waitingOf(step).length === 0);

  // Setup first: the checkout holds only what is committed, so setup is what
  // makes it usable, from what this commit declares. When setup
  // fails, nothing is checked, and the record says so with setup's own output.
  // As the worker the worktree belongs to (D-P10-25), never as the engine, and
  // with a temp directory of its own that nothing before it wrote into and
  // nothing after it inherits (scratch.ts). On a machine, in the project
  // environment (P16, D-10), given here rather than inherited.
  const as = stepsAs(environment, { agentId: input.agentId, role: "worker" });
  const scratch = await freshScratch(environment.paths, input.checkout, environment.reclaim);
  const checkout = await runCheckoutSteps({
    setup: gates.setup,
    steps: runnable,
    cwd: input.checkout,
    reference: session.repoPath,
    env: projectStepEnv(projectEnv, scratch),
    onStep: announce,
    ...as,
  }).finally(() => discardScratch(environment.paths, input.checkout, environment.reclaim));
  const results = checkout.checks;

  // Each step's whole output, in S3 and referenced — never inline (A-08).
  const logArtifactIds = new Map<string, ArtifactId>();
  for (const result of [...checkout.setup, ...results]) {
    const artifactId = await recordArtifact(environment, {
      scope: session.scope,
      nodeId: input.nodeId,
      kind: "verification-log",
      contentType: "text/plain; charset=utf-8",
      bytes: result.output,
    });
    logArtifactIds.set(result.stepId, artifactId as ArtifactId);
  }

  // A step that ran and *declared* it could not (exit 75 and a NIGHTSHIFT_DEFER
  // line) is a hurdle nobody planned: recorded as a discovered prerequisite, and
  // deferred exactly as a planned one is. Anything else non-zero is a failure.
  const discovered = new Map<string, string>();
  for (const result of results) {
    const signal = deferSignalOf(result.exitCode, new TextDecoder().decode(result.output));
    if (signal === undefined) continue;
    await recordDiscovered(environment, session, steps, result.stepId, signal);
    discovered.set(result.stepId, signal.prerequisiteId);
  }

  // Each check that failed, and did not declare a deferral, runs once more on
  // this same checkout as the same worker, in the same project environment
  // (D-P15-06, flaky.ts). One whose rerun passes is a flake: recorded as
  // passed, with its first run beside it.
  const reruns = await rerunFailures({
    steps: runnable,
    first: results,
    cwd: input.checkout,
    paths: environment.paths,
    projectEnv,
    ...(environment.reclaim === undefined ? {} : { reclaim: environment.reclaim }),
    ...as,
  });
  const checkCommands = await withFlakes(
    environment,
    { scope: session.scope, nodeId: input.nodeId },
    toVerificationCommands(results, logArtifactIds),
    reruns,
  );

  // In the contract's own order, so a record reads like the contract it ran.
  const ran = new Map(checkCommands.map((command) => [command.stepId, command]));
  const checked = checkout.setupFailed ? [] : steps;
  const commands = [
    ...toVerificationCommands(checkout.setup, logArtifactIds),
    ...checked.map((step) => {
      const found = ran.get(step.id);
      const declared = discovered.get(step.id);
      if (found !== undefined && declared === undefined) return found;
      return {
        stepId: step.id,
        command: step.command,
        durationMs: found?.durationMs ?? 0,
        ...(found?.logArtifactId === undefined ? {} : { logArtifactId: found.logArtifactId }),
        // The first unmet one: a record names what it waits on, the node's reason names them all.
        deferred: { prerequisiteId: declared ?? (waitingOf(step)[0] as string) },
      };
    }),
  ];
  const waitingOn = [...new Set([...checked.flatMap(waitingOf), ...discovered.values()])];

  const verification = VerificationSchema.parse({
    schemaVersion: 1,
    ...session.scope,
    verificationId,
    executionNodeId: input.nodeId,
    jobContractId: input.jobContractId,
    // The agent whose work is under verification, not a verifying agent: nothing
    // verifies, in the sense of an agent. A command does.
    agentId: input.agentId,
    commitSha: input.commitSha,
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    commands,
    outcome: outcomeOfCommands(commands),
    startedAt,
    endedAt: nowIso(clock),
  } satisfies Record<string, unknown>) as Verification;
  await stores.verifications.put(verification);
  // A flake lands the work, and is still seen: the root repairs it off the path.
  const flakyPayload = announceFlakes(environment, verification, input.agentId);
  return { verification, waitingOn, flakyPayload };
};

export const verifyNode = async (
  environment: LandingEnvironment,
  input: VerifyInput,
): Promise<VerifyResult> => {
  const { stores, clock, outbox } = environment;
  const commitSha = input.node.commitSha;
  if (commitSha === null) {
    // `markImplemented` records the commit, so an implemented node without one
    // is a defect rather than a state to handle gracefully.
    throw new Error(`node ${input.node.executionNodeId} is implemented but carries no commit`);
  }

  // The run's gates as they stand now: a repair that lands while this runs
  // changes the next verification, never this one (D-P15-04). A job's
  // verification is the landing steps; the end gates are the run's (A-57).
  const gates: GateDefinitions = await gateDefinitions(environment, input.session);
  const steps = landingSteps(gates);
  // A fenced engine may have died while running these checks. Restart the
  // commands on the same clean commit, not the worker that produced it.
  const verifying =
    input.node.status === "verifying"
      ? input.node
      : transition(
          input.node,
          input.resuming === true ? "resume_verification" : "begin_verification",
          nowIso(clock),
        );
  await stores.executionNodes.put(verifying);
  outbox.emit({
    type: "verification.requested",
    source: "control-plane",
    payload: {
      commitSha,
      steps: [...gates.setup.map((step) => setupAsStep(step).id), ...steps.map((step) => step.id)],
    },
    executionNodeId: input.node.executionNodeId,
    agentId: input.agentId,
  });

  // Exactly what would integrate, and nothing the worker or an earlier
  // verification left behind, ignored files included.
  outbox.emit({
    type: "verification.progress",
    source: "control-plane",
    payload: { message: "verification: cleaning the checkout" },
    executionNodeId: input.node.executionNodeId,
  });
  await pristineCheckout(environment.git, input.worktree, commitSha);

  // What the commit is landing onto: its parent, since a snapshot has one and
  // the queue replayed it onto the program head (D-P17-06).
  const baseSha = (await tryRevParse(environment.git, input.session.repoPath, `${commitSha}^`)) as
    | CommitSha
    | undefined;
  const { verification, waitingOn, flakyPayload } = await runVerification(environment, {
    session: input.session,
    nodeId: input.node.executionNodeId,
    jobContractId: input.job.jobContractId,
    agentId: input.agentId,
    checkout: input.worktree,
    commitSha,
    baseSha,
    gates,
    steps,
    label: "verification",
    ...(input.resuming === undefined ? {} : { resuming: input.resuming }),
  });

  const at = nowIso(clock);
  const nothingFailed = verification.outcome !== "failed";
  if (nothingFailed && (waitingOn.length > 0 || input.onProvisionalLine === true)) {
    // Not a verdict. A step that ran and failed never gets here: that is a
    // failure, below, whatever else was deferred.
    // No `outcomeReason`: a deferral is not an outcome, and a node's reason is
    // written once. Why it waits is in the Verification (each deferred command
    // names its prerequisite) and on the `node.deferred` event.
    // On the provisional line first, so `deferred` always means "on the line".
    await deferOnTheLine(environment, input, commitSha, waitingOn, () =>
      stores.executionNodes.put(transition(verifying, "defer", at)),
    );
    outbox.emit({
      type: "verification.completed",
      source: "control-plane",
      payload: {
        verificationId: verification.verificationId,
        outcome: verification.outcome,
        commitSha,
        deferredSteps: verification.commands
          .filter((command) => command.deferred !== undefined)
          .map((command) => command.stepId),
        waitingOn,
        ...flakyPayload,
      },
      executionNodeId: input.node.executionNodeId,
      agentId: input.agentId,
    });
    return { passed: false, verification, deferred: { commitSha, waitingOn } };
  }

  if (verification.outcome === "passed") {
    // `markVerified` refuses evidence that does not match the work: a different
    // commit, a different job, a different run. It is the rule, not this module.
    await stores.executionNodes.put(markVerified(verifying, verification, at));
    outbox.emit({
      type: "verification.completed",
      source: "control-plane",
      payload: {
        verificationId: verification.verificationId,
        outcome: "passed",
        commitSha,
        commands: verification.commands.map((command) => ({
          stepId: command.stepId,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
        })),
        ...flakyPayload,
      },
      executionNodeId: input.node.executionNodeId,
      agentId: input.agentId,
    });
    return { passed: true, commitSha, verification };
  }

  const failing = verification.commands.filter(
    (command) => command.deferred === undefined && command.exitCode !== 0,
  );
  await stores.executionNodes.put({
    ...markVerificationFailed(verifying, verification, at),
    outcomeReason: `verification failed: ${failing
      .map((command) => `${command.stepId} exited ${command.exitCode}`)
      .join(", ")}`,
  });
  outbox.emit({
    type: "verification.completed",
    source: "control-plane",
    payload: {
      verificationId: verification.verificationId,
      outcome: "failed",
      commitSha,
      failingSteps: failing.map((command) => command.stepId),
      // Nothing is sealed and nothing integrates; the worktree is kept so a
      // human can look at what the commands saw.
      worktree: input.worktree,
      ...flakyPayload,
    },
    executionNodeId: input.node.executionNodeId,
    agentId: input.agentId,
  });
  return { passed: false, verification };
};
