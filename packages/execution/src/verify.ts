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
 * ## Order
 *
 * Node to `verifying`, run the steps, upload each step's output as an artifact,
 * write the `Verification`, and only then transition. The record exists before
 * the status that depends on it, so a reader can never find a `verified` node
 * with no evidence — and `core`'s `markVerified` would refuse anyway.
 */
import type {
  AgentId,
  ArtifactId,
  CommitSha,
  ExecutionNode,
  JobContract,
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
} from "@nightshift/core";
import {
  type DeferSignal,
  deferSignalOf,
  runCheckoutSteps,
  setupAsStep,
  toVerificationCommands,
} from "@nightshift/verification";
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type LandingEnvironment,
  type RunSession,
} from "./environment.js";
import { pristineCheckout } from "./git/index.js";
import { recordArtifact, stepsAs } from "./runner.js";

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
 * The prerequisites that are unmet **now**, from the control plane when this
 * environment can ask it, and from the run's own contract when it cannot.
 */
const unmetPrerequisites = async (
  environment: LandingEnvironment,
  input: VerifyInput,
): Promise<ReadonlySet<string>> => {
  const { program } = input.session;
  if ((program.verification ?? []).every((step) => (step.requires ?? []).length === 0)) {
    return new Set();
  }
  const current =
    environment.prerequisites === undefined
      ? prerequisitesOf(program)
      : await environment.prerequisites.prerequisites({
          projectId: program.projectId,
          programId: program.programId,
        });
  return new Set(
    current.filter((prerequisite) => prerequisite.status !== "satisfied").map((p) => p.id),
  );
};

/**
 * A hurdle a command declared, written to the control plane once. A second step
 * declaring the same id is the same hurdle; the API confirms rather than
 * duplicates, and without a book to write to the deferral still holds locally.
 */
const recordDiscovered = async (
  environment: LandingEnvironment,
  input: VerifyInput,
  stepId: string,
  signal: DeferSignal,
): Promise<void> => {
  if (environment.prerequisites === undefined) return;
  const { program, scope } = input.session;
  const step = program.verification.find((candidate) => candidate.id === stepId);
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

  const verifying = transition(
    input.node,
    input.resuming === true ? "resume_verification" : "begin_verification",
    nowIso(clock),
  );
  await stores.executionNodes.put(verifying);
  const startedAt = nowIso(clock);
  outbox.emit({
    type: "verification.requested",
    source: "control-plane",
    payload: {
      commitSha,
      steps: [
        ...(input.session.program.setup ?? []).map((step) => setupAsStep(step).id),
        ...input.session.program.verification.map((step) => step.id),
      ],
    },
    executionNodeId: input.node.executionNodeId,
    agentId: input.agentId,
  });

  // Exactly what would integrate, and nothing the worker or an earlier
  // verification left behind, ignored files included.
  await pristineCheckout(environment.git, input.worktree, commitSha);

  // A step that needs a human prerequisite nobody has met **cannot run**, and is
  // deferred; every other step runs (D-P7-10). When resuming, the preflight has
  // already passed, and every step runs.
  const unmet =
    input.resuming === true ? new Set<string>() : await unmetPrerequisites(environment, input);
  const waitingOf = (step: VerificationStep): readonly string[] =>
    (step.requires ?? []).filter((id) => unmet.has(id));
  const steps = input.session.program.verification;
  const runnable = steps.filter((step) => waitingOf(step).length === 0);

  // Setup first: the checkout holds only what is committed, so setup is what
  // makes it usable, from what this commit declares. When setup
  // fails, nothing is checked, and the record says so with setup's own output.
  // As the worker the worktree belongs to (D-P10-25), never as the engine.
  const checkout = await runCheckoutSteps({
    setup: input.session.program.setup ?? [],
    steps: runnable,
    cwd: input.worktree,
    reference: input.session.repoPath,
    timeoutMs: environment.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
    ...stepsAs(environment, { agentId: input.agentId, role: "worker" }),
  });
  const results = checkout.checks;

  // Each step's whole output, in S3 and referenced — never inline (A-08).
  const logArtifactIds = new Map<string, ArtifactId>();
  for (const result of [...checkout.setup, ...results]) {
    const artifactId = await recordArtifact(environment, {
      scope: input.session.scope,
      nodeId: input.node.executionNodeId,
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
    await recordDiscovered(environment, input, result.stepId, signal);
    discovered.set(result.stepId, signal.prerequisiteId);
  }

  // In the contract's own order, so a record reads like the contract it ran.
  const ran = new Map(
    toVerificationCommands(results, logArtifactIds).map((command) => [command.stepId, command]),
  );
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
    ...input.session.scope,
    verificationId: environment.ids.next("ver"),
    executionNodeId: input.node.executionNodeId,
    jobContractId: input.job.jobContractId,
    // The agent whose work is under verification, not a verifying agent: nothing
    // verifies, in the sense of an agent. A command does.
    agentId: input.agentId,
    commitSha,
    commands,
    outcome: outcomeOfCommands(commands),
    startedAt,
    endedAt: nowIso(clock),
  } satisfies Record<string, unknown>) as Verification;
  await stores.verifications.put(verification);

  const at = nowIso(clock);
  const nothingFailed = verification.outcome !== "failed";
  if (nothingFailed && (waitingOn.length > 0 || input.onProvisionalLine === true)) {
    // Not a verdict. A step that ran and failed never gets here: that is a
    // failure, below, whatever else was deferred.
    // No `outcomeReason`: a deferral is not an outcome, and a node's reason is
    // written once. Why it waits is in the Verification (each deferred command
    // names its prerequisite) and on the `node.deferred` event.
    await stores.executionNodes.put(transition(verifying, "defer", at));
    outbox.emit({
      type: "verification.completed",
      source: "control-plane",
      payload: {
        verificationId: verification.verificationId,
        outcome: verification.outcome,
        commitSha,
        deferredSteps: commands
          .filter((command) => command.deferred !== undefined)
          .map((command) => command.stepId),
        waitingOn,
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
    },
    executionNodeId: input.node.executionNodeId,
    agentId: input.agentId,
  });
  return { passed: false, verification };
};
