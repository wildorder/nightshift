/**
 * The orchestrator role's tools (contract §4.5).
 *
 * This is the surface a frontier model drives Nightshift through. Three things
 * shape it:
 *
 * 1. **Every tool result carries the identifiers it created.** An orchestrator
 *    that has to go looking for the node it just made will sometimes guess.
 * 2. **`job.wait` polls the control plane, not process memory.** The answer it
 *    gives is the answer `GET …/state` would give, which means an orchestrator
 *    and a human reading the API never disagree about what happened.
 * 3. **`delegate` returns when the worker has started**, not when it has
 *    finished (D-P3-04). The job runs in the background of this process; the
 *    orchestrator stays responsive and asks with `job.wait`.
 *
 * What is deliberately absent: nothing here creates a `Verification`, and no
 * tool moves a node past `implemented` by asking. Verification is automatic and
 * belongs to the execution layer (D-P3-06); examination does not exist yet
 * (D-P3-07) and a delegation that would need it is refused up front.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Checkpoint,
  DecisionId,
  ExecutionNode,
  JobContract,
  Repair,
  RepairCause,
  RouteChoice,
  Scope,
} from "@nightshift/contracts";
import {
  type Effort,
  EffortSchema,
  ExecutionNodeIdSchema,
  inheritFromConfig,
  JobContractSchema,
  type JobKind,
  NIGHTSHIFT_CONFIG_FILE,
  NightshiftConfigSchema,
  RepairCauseSchema,
  type Reversibility,
  ReversibilitySchema,
  ScopeRequestSchema,
  StrandIdSchema,
  type Testability,
  type Tier,
  TierSchema,
} from "@nightshift/contracts";
import {
  buildTree,
  checkAuthority,
  conservativeDefaults,
  type DelegationRejection,
  gatherReport,
  highestSequence,
  isDoneForNow,
  nowIso,
  type ProjectStores,
  pendingCount,
  renderReport,
  type StrandBrief,
  StrandBriefError,
  strandBrief,
  strandsOf,
} from "@nightshift/core";
import {
  endProgramNode,
  FixLimitError,
  type RoutePins,
  StrandBlockedError,
  StrandDelegationError,
} from "@nightshift/execution";
import { RoutingRefusedError } from "@nightshift/routing";
import { z } from "zod";
import { type ActivityFeed, createActivityFeed, renderActivity } from "./activity.js";
import { CLASSIFICATION_INPUTS } from "./classification.js";
import type { RefusalCode } from "./results.js";
import { guarded, ok, ToolRefusal, waitForFirstSettled } from "./results.js";
import { routeJob } from "./routing.js";
import type { AttachedRun, OrchestratorSession } from "./session.js";
import {
  attachRun,
  createCheckpointAt,
  describeNodeLine,
  programDirectoryOf,
  startNewRun,
} from "./session.js";

/**
 * How long `job.wait` will block before answering `timedOut: true`.
 *
 * It must never hit the harness's own tool timeout, because a tool call the
 * harness abandons gives the orchestrator *nothing* — not a timeout, not a
 * status, just a dead call. Claude Code's per-server timeout
 * (`MCP_TOOL_TIMEOUT`, or `mcpToolTimeoutSec` in a server's configuration) is
 * documented in the installed 2.1.273 as "a hard wall-clock limit per call;
 * progress notifications do not extend it", and its configurable range is
 * bounded at **60 seconds minimum**. So the cap sits below the lowest value an
 * operator could configure, rather than below the default — which makes it
 * correct for every setting rather than for the common one.
 *
 * The cost of a low cap is one extra round trip, not correctness: `job.wait`
 * answers with the job's real status and `timedOut: true`, and the orchestrator
 * calls it again. An operator who has raised `MCP_TOOL_TIMEOUT` can raise this
 * with `NIGHTSHIFT_JOB_WAIT_CAP_SECONDS`.
 */
export const DEFAULT_JOB_WAIT_CAP_SECONDS = 55;
export const JOB_WAIT_CAP_ENV = "NIGHTSHIFT_JOB_WAIT_CAP_SECONDS";
const JOB_WAIT_POLL_MS = 500;
/** How long a process may outlive its node's ending before `run.finish` stops it. */
const SETTLED_PROCESS_GRACE_MS = 15_000;

export interface OrchestratorDeps {
  readonly state: OrchestratorSession;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const readIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const requireAttached = (state: OrchestratorSession) => {
  const attached = state.current;
  if (attached === undefined) {
    throw new ToolRefusal(
      "not_attached",
      "this server is not bound to a run. Call run.start with a program contract, or run.attach " +
        "to join the run `nightshift run` created.",
    );
  }
  return attached;
};

export const jobWaitCap = (env: OrchestratorDeps["env"]): number => {
  const raw = env[JOB_WAIT_CAP_ENV];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JOB_WAIT_CAP_SECONDS;
};

/** Everything `job.get` answers: the node, its agent, and what came of the work. */
const jobReport = async (
  deps: OrchestratorDeps,
  jobContractId: string,
): Promise<Readonly<Record<string, unknown>>> => {
  const attached = requireAttached(deps.state);
  const { stores } = deps.state.runtime;
  const scope = attached.session.scope;

  const nodes = await stores.executionNodes.listByRun(scope);
  const node = nodes.items.find((candidate) => candidate.jobContractId === jobContractId);
  if (node === undefined) {
    throw new ToolRefusal("not_found", `no node in this run carries job ${jobContractId}`);
  }

  const agents = await stores.agents.listByNode(scope, node.executionNodeId);
  const agent = agents.at(-1);
  const verifications = await stores.verifications.listByNode(scope, node.executionNodeId);
  const verification = verifications.at(-1);
  const checkpoints = await stores.checkpoints.listByRun(scope);
  const checkpoint = checkpoints.items.find(
    (candidate) => candidate.commitSha === node.commitSha && node.commitSha !== null,
  );
  const running = attached.engine.running(jobContractId as never);
  const waiting = attached.engine.waiting(jobContractId as never);

  return {
    jobContractId,
    nodeId: node.executionNodeId,
    status: node.status,
    // `core`'s own list, so a status added there (`succeeded`, for a sub-program)
    // is settled here too rather than waited on for ever.
    // Done for now: settled, or deferred for a human (D-P7-10). Nothing to wait for either way.
    settled: isDoneForNow(node.status),
    commitSha: node.commitSha,
    outcomeReason: node.outcomeReason ?? null,
    worktree: running?.worktree ?? null,
    pid: running?.pid ?? null,
    // Why a queued job is not running yet: a full parent, or a spent wall clock.
    waitingFor: node.status === "queued" ? (waiting ?? null) : null,
    agent:
      agent === undefined
        ? null
        : {
            agentId: agent.agentId,
            status: agent.status,
            model: agent.model,
            exitCode: agent.exitCode ?? null,
            outcomeReason: agent.outcomeReason ?? null,
          },
    verification:
      verification === undefined
        ? null
        : {
            verificationId: verification.verificationId,
            outcome: verification.outcome,
            commands: verification.commands.map((command) => ({
              stepId: command.stepId,
              exitCode: command.exitCode,
              durationMs: command.durationMs,
              logArtifactId: command.logArtifactId ?? null,
            })),
          },
    checkpointId: checkpoint?.checkpointId ?? null,
  };
};

/** The sentence a model reads first. */
const describeJob = (report: Readonly<Record<string, unknown>>): string => {
  const status = String(report.status);
  const reason = report.outcomeReason === null ? "" : ` Reason: ${String(report.outcomeReason)}.`;
  const commit = report.commitSha === null ? "" : ` Commit ${String(report.commitSha)}.`;
  const verification = report.verification as { outcome?: string } | null;
  const verified =
    verification === null ? "" : ` Verification ${verification.outcome ?? "unknown"}.`;
  return `Job ${String(report.jobContractId)} is ${status}.${commit}${verified}${reason}${nextStepFor(report)}`;
};

/**
 * What an orchestrator can do about a job an examination stopped (P8, D-P8-13):
 * fix it, which is a retry with the findings, or dispute it before an arbiter.
 */
const nextStepFor = (report: Readonly<Record<string, unknown>>): string => {
  const reason = typeof report.outcomeReason === "string" ? report.outcomeReason : "";
  if (reason.startsWith("examination_failed:")) {
    return (
      " An independent examiner stopped it. Fix it with job.retry (the findings go into the " +
      "worker's brief, and it climbs a rung; at most two fixes), or, if the examiner is wrong, " +
      "dispute it with finding.dispute and an arbiter rules."
    );
  }
  if (reason.startsWith("examination_upheld:")) {
    return (
      " An arbiter upheld the finding, and the ruling is final: Nightshift is starting the next " +
      "attempt to carry it out. Wait for it with job.wait; there is nothing to retry or dispute."
    );
  }
  if (reason.startsWith("examination_ruling_unmet:")) {
    return (
      " The attempt did not carry out the arbiter's ruling. Nightshift tries it again, at most " +
      "twice; after that it is the work's failure, and it is yours to delegate differently."
    );
  }
  return "";
};

/** The jobs a `job.wait` named, one way or the other, without repeats. */
const jobsNamed = (jobId: string | undefined, jobIds: readonly string[] | undefined): string[] => {
  const wanted = [...new Set([...(jobIds ?? []), ...(jobId === undefined ? [] : [jobId])])];
  if (wanted.length === 0) {
    throw new ToolRefusal("validation_failed", "name a job with jobId, or several with jobIds");
  }
  return wanted;
};

/** The run's tree, one line a node, indented by depth: read at a glance. */
const renderTree = (nodes: readonly ExecutionNode[]): readonly string[] => {
  const children = new Map<string | null, ExecutionNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentNodeId) ?? [];
    siblings.push(node);
    children.set(node.parentNodeId, siblings);
  }
  const lines: string[] = [];
  const walk = (parent: string | null): void => {
    const level = [...(children.get(parent) ?? [])].sort((a, b) =>
      a.executionNodeId < b.executionNodeId ? -1 : 1,
    );
    for (const node of level) {
      const reason =
        node.outcomeReason === undefined ? "" : ` — ${node.outcomeReason.slice(0, 120)}`;
      lines.push(
        `${"  ".repeat(node.depth)}${node.kind} ${node.executionNodeId} ${node.status}${reason}`,
      );
      walk(node.executionNodeId);
    }
  };
  walk(null);
  return lines;
};

/** A run does not end while its work is still going (D-P6-08). */
const assertNoJobRunning = async (
  _deps: OrchestratorDeps,
  attached: AttachedRun,
): Promise<void> => {
  if (attached.engine.idle()) return;
  // A process whose node has already settled is not work in flight: it is a
  // model finishing its sentence. It gets a moment, and then it is stopped.
  await attached.engine.releaseSettled(SETTLED_PROCESS_GRACE_MS);
  if (attached.engine.idle()) return;
  const { running, queued } = attached.engine.snapshot();
  throw new ToolRefusal(
    "job_running",
    `${running.length} job${running.length === 1 ? " is" : "s are"} running and ${queued.length} queued. ` +
      "Wait for them with job.wait, or stop them with job.cancel, before finishing the run.",
    { running, queued },
  );
};

/** A run that ended badly says why. Killing work must never leave silence. */
/**
 * A planned run succeeded when every strand of its plan did (D-P7-09). Parked
 * and never-delegated strands are settled, so nothing else would refuse this;
 * and "succeeded" with half the plan parked is the lie the report must not tell.
 */
/** The run's ending, its program node's, and the event that says so. */
const endRun = async (
  state: OrchestratorSession,
  attached: AttachedRun,
  outcome: "succeeded" | "failed" | "cancelled" | "deferred",
  reason: string | undefined,
): Promise<void> => {
  // The run table has no `deferred`, and P7 was not authorised to give it one.
  // `interrupted` is the honest fit: stopped short, durably, to be taken up again.
  const status = outcome === "deferred" ? "interrupted" : outcome;
  const { stores, clock } = state.runtime;
  const run = await stores.runs.get(attached.session.scope, attached.session.scope.runId);
  if (run === undefined) throw new ToolRefusal("not_found", "this run no longer exists");
  const why = reason === undefined ? {} : { outcomeReason: reason };
  await stores.runs.put({ ...run, status, endedAt: nowIso(clock), ...why });
  // The program node follows its run (D-P5-06): `succeeded`, never
  // `integrated`, because a program node integrates nothing.
  await endProgramNode(state.runtime, attached.session, status, reason);
  attached.outbox.emit({
    type: status === "succeeded" ? "run.completed" : `run.${status}`,
    source: "control-plane",
    payload: reason === undefined ? {} : { reason },
    executionNodeId: attached.session.rootNodeId,
  });
  await attached.outbox.flush(5_000);
};

/** `docs/programs/{id}/report.md` for a planned run; nothing for any other. */
const writeReport = async (
  state: OrchestratorSession,
  attached: AttachedRun,
): Promise<string | undefined> => {
  if (attached.planSections === undefined) return undefined;
  const directory = await programDirectoryOf(state, attached.session.scope.programId);
  if (directory === undefined) return undefined;
  const path = resolve(directory, "report.md");
  await writeFile(
    path,
    renderReport(await gatherReport(state.runtime.stores, attached.session.scope)),
  );
  return path;
};

/** One feed per attached run, so each call answers "since the last one". */
const feeds = new WeakMap<AttachedRun, ActivityFeed>();

const feedFor = (attached: AttachedRun, stores: ProjectStores): ActivityFeed => {
  let feed = feeds.get(attached);
  if (feed === undefined) {
    feed = createActivityFeed(stores, attached.session.scope);
    feeds.set(attached, feed);
  }
  return feed;
};

/** At most this many lines per wait; the rest are a `run.activity` away. */
const ACTIVITY_PER_WAIT = 40;

const activitySince = async (attached: AttachedRun, stores: ProjectStores): Promise<string[]> => {
  const lines = renderActivity(
    await feedFor(attached, stores)
      .since()
      .catch(() => []),
  );
  if (lines.length <= ACTIVITY_PER_WAIT) return lines;
  return [
    `(${lines.length - ACTIVITY_PER_WAIT} earlier lines left out; run.activity has them all)`,
    ...lines.slice(-ACTIVITY_PER_WAIT),
  ];
};

const assertEveryStrandSucceeded = async (attached: AttachedRun): Promise<void> => {
  if (attached.planSections === undefined) return;
  const outcomes = await attached.engine.strands();
  const unfinished = strandsOf(attached.session.program)
    .filter((strand) => outcomes[strand.id] !== "succeeded")
    .map((strand) => `${strand.id} (${outcomes[strand.id] ?? "never delegated"})`);
  if (unfinished.length === 0) return;
  throw new ToolRefusal(
    "validation_failed",
    `this run follows a plan, and these strands have not succeeded: ${unfinished.join(", ")}. ` +
      'Delegate what was never delegated, or finish the run as "failed" with a reason that names them.',
    { unfinished },
  );
};

/** What a planned run says of itself has to be what its records say. */
const assertEndingIsTrue = async (attached: AttachedRun, outcome: string): Promise<void> => {
  if (outcome === "succeeded") await assertEveryStrandSucceeded(attached);
  if (outcome === "deferred") await assertSomethingIsDeferred(attached);
};

/** `deferred` is a claim about the run's records, so the records have to agree. */
const assertSomethingIsDeferred = async (attached: AttachedRun): Promise<void> => {
  const outcomes = await attached.engine.strands();
  if (Object.values(outcomes).includes("provisional")) return;
  throw new ToolRefusal(
    "validation_failed",
    "nothing in this run is deferred: no strand has work on the provisional line. Finish it as " +
      '"succeeded" or "failed".',
  );
};

const assertEndingExplained = (outcome: string, reason: string | undefined): void => {
  if (outcome === "succeeded") return;
  if (reason !== undefined && reason !== "") return;
  throw new ToolRefusal(
    "validation_failed",
    `a run ending as ${outcome} must say why: pass a reason.`,
  );
};

export const registerOrchestratorTools = (server: McpServer, deps: OrchestratorDeps): void => {
  const { state } = deps;

  // --- Runs -------------------------------------------------------------------

  server.registerTool(
    "run.start",
    {
      title: "Start a run",
      description:
        "Validate an authored Program Contract, persist it with its run, root node and initial " +
        "checkpoint, and bind this server to it. The same function `nightshift run` calls.",
      inputSchema: {
        programContractPath: z.string().min(1),
        model: z.string().min(1),
        repoPath: z.string().min(1).optional(),
      },
    },
    async ({ programContractPath, model, repoPath }) =>
      guarded(async () => {
        const repo = resolve(repoPath ?? process.cwd());
        const path = resolve(repo, programContractPath);
        const authored: unknown = JSON.parse(await readFile(path, "utf8"));
        // A planned program's two files sit together (D-P7-03), and its contract
        // inherits the project's defaults, exactly as `nightshift run {id}` reads it.
        const planText = await readIfPresent(resolve(dirname(path), "plan.md"));
        const configText = await readIfPresent(resolve(repo, NIGHTSHIFT_CONFIG_FILE));
        const contract =
          configText === undefined
            ? authored
            : inheritFromConfig(authored, NightshiftConfigSchema.parse(JSON.parse(configText)));
        const started = await startNewRun(state, {
          program: contract,
          repoPath: repo,
          model,
          ...(planText === undefined ? {} : { planText }),
        });
        return ok(
          `Run ${started.session.scope.runId} started for program ${started.session.scope.programId}, ` +
            `on branch ${started.session.program.repository.programBranch} at ${started.baseCommit}. ` +
            "Delegate a job with `delegate`.",
          {
            runId: started.session.scope.runId,
            programId: started.session.scope.programId,
            projectId: started.session.scope.projectId,
            rootNodeId: started.session.rootNodeId,
            agentId: started.session.orchestratorAgentId,
            baseCommit: started.baseCommit,
          },
        );
      }),
  );

  server.registerTool(
    "run.attach",
    {
      title: "Attach to a run",
      description:
        "Bind this server to a run `nightshift run` created: the one named, or the single " +
        "pending run for this repository's program. Replays any spooled events first.",
      inputSchema: { model: z.string().min(1), runId: z.string().min(1).optional() },
    },
    async ({ model, runId }) =>
      guarded(async () => {
        const attached = await attachRun(state, {
          model,
          ...(runId === undefined ? {} : { runId }),
        });
        const carried = attached.session.run.carriedStrands ?? [];
        return ok(
          `Attached to run ${attached.session.scope.runId}. ` +
            (attached.replayed > 0
              ? `Replayed ${attached.replayed} spooled events from an earlier session. `
              : "") +
            (carried.length === 0
              ? ""
              : `Carried over, already built by an earlier run of this plan and on the program ` +
                `branch, so not to be delegated: ${carried
                  .map((strand) => `${strand.strandId} (run ${strand.fromRunId})`)
                  .join(", ")}. `) +
            "Delegate a job with `delegate`.",
          {
            runId: attached.session.scope.runId,
            rootNodeId: attached.session.rootNodeId,
            agentId: attached.session.orchestratorAgentId,
            replayedEvents: attached.replayed,
            carriedStrands: carried,
          },
        );
      }),
  );

  server.registerTool(
    "run.finish",
    {
      title: "Finish the run",
      description:
        "Give the run a terminal status. Refused while a job is running. `deferred` is for a " +
        "planned run whose remaining work waits on a human prerequisite: the run is recorded as " +
        "interrupted, its provisional work is kept, and `nightshift resume` takes it from there.",
      inputSchema: {
        outcome: z.enum(["succeeded", "failed", "cancelled", "deferred"]),
        reason: z.string().min(1).optional(),
      },
    },
    async ({ outcome, reason }) =>
      guarded(async () => {
        const attached = requireAttached(state);
        await assertNoJobRunning(deps, attached);
        assertEndingExplained(outcome, reason);
        await assertEndingIsTrue(attached, outcome);
        await endRun(state, attached, outcome, reason);
        // A planned run's report, beside its plan, as `nightshift run` writes it
        // for a run nobody watched: written from the control plane alone.
        const reportPath = await writeReport(state, attached);
        return ok(
          `Run ${attached.session.scope.runId} is ${outcome}.` +
            (reportPath === undefined ? "" : ` The report is at ${reportPath}.`),
          {
            ...(reportPath === undefined ? {} : { reportPath }),
            runId: attached.session.scope.runId,
            outcome,
          },
        );
      }),
  );

  // --- Reading ----------------------------------------------------------------

  server.registerTool(
    "program.get",
    {
      title: "Read the Program Contract",
      description:
        "The contract as the control plane stores it — which is the authority, not the file.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const attached = requireAttached(state);
        return ok(
          `Program ${attached.session.scope.programId}: ${attached.session.program.objective}`,
          { program: attached.session.program },
        );
      }),
  );

  server.registerTool(
    "program.status",
    {
      title: "The run's current state",
      description:
        "The run, its nodes, the latest checkpoint, and how far event numbering trails durability.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const attached = requireAttached(state);
        const { stores } = state.runtime;
        const scope = attached.session.scope;
        const run = await stores.runs.get(scope, scope.runId);
        const nodes = await stores.executionNodes.listByRun(scope);
        const checkpoints = await stores.checkpoints.listByRun(scope);
        const events = await stores.events.listByRun(scope);
        const latest: Checkpoint | undefined = checkpoints.items.at(-1);

        return ok(
          `Run ${scope.runId} is ${run?.status ?? "unknown"} with ${nodes.items.length} nodes. ` +
            `Latest checkpoint ${latest?.checkpointId ?? "none"}. ` +
            `${pendingCount(events.items)} events are durable but not yet numbered.`,
          {
            run,
            nodes: nodes.items,
            // What the engine holds (D-P6-09): what is running, what waits for a
            // slot and in which order, what the merge queue is on, and how much
            // wall clock is left.
            engine: attached.engine.snapshot(),
            tree: renderTree(nodes.items),
            latestCheckpoint: latest ?? null,
            highestSequence: highestSequence(events.items) ?? null,
            pendingEvents: pendingCount(events.items),
          },
        );
      }),
  );

  server.registerTool(
    "execution.status",
    {
      title: "The execution tree",
      description: "Every node with its status and its agent, one line each.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const attached = requireAttached(state);
        const { stores } = state.runtime;
        const scope = attached.session.scope;
        const nodes = await stores.executionNodes.listByRun(scope);
        const lines: string[] = [];
        for (const node of nodes.items) {
          const agents = await stores.agents.listByNode(scope, node.executionNodeId);
          lines.push(describeNodeLine(node, agents.at(-1)));
        }
        return ok(lines.join("\n"), { nodes: nodes.items.length, lines });
      }),
  );

  // --- Delegation --------------------------------------------------------------

  server.registerTool(
    "strand.delegate",
    {
      title: "Delegate one strand of the ratified plan",
      description:
        "Hand a strand of the ratified plan to an orchestrator of its own. You name the strand " +
        "and nothing else: its objective is its section of the plan verbatim, with the human's " +
        "decisions that touch it and the other strands' scopes, and its scope and acceptance are " +
        "the contract's. It stays queued until the strands it depends on have succeeded.",
      inputSchema: {
        strandId: StrandIdSchema,
        // `job` when the strand is one bounded change and an orchestrator would
        // have a single thing to do (D-P7-04). The plan is handed over either way.
        kind: z.enum(["job", "sub-program"]).optional(),
        ...PIN_INPUTS,
      },
    },
    async (input) =>
      guarded(async () => {
        const attached = requireAttached(state);
        const carried = attached.session.run.carriedStrands?.find(
          (strand) => strand.strandId === input.strandId,
        );
        if (carried !== undefined) {
          // Built by an earlier run of this plan, and on the branch: done here too.
          throw new ToolRefusal(
            "strand_carried",
            `${input.strandId} was built by run ${carried.fromRunId} under this same plan, and ` +
              "everything it landed is on the program branch this run started from, so it has " +
              "succeeded in this run already. Do not delegate it; delegate the strands that remain.",
            { strandId: input.strandId, fromRunId: carried.fromRunId, landed: carried.landed },
          );
        }
        const kind = input.kind ?? "sub-program";
        const job = buildStrandJob(state, attached, input.strandId, kind);
        const check = await checkDelegationOrRefuse(state, attached, job.scope);
        const pins = pinsOf(input);
        const route = chooseRoute(attached, job, pins);
        const submitted = await submitStrand(attached, {
          job,
          scope: check.scope,
          depth: check.depth,
          parentNodeId: attached.session.rootNodeId,
          route,
          pins,
          kind,
        });

        const waiting = attached.engine.waiting(job.jobContractId);
        return ok(describeStrandSubmission(input.strandId, submitted, waiting), {
          strandId: input.strandId,
          jobId: job.jobContractId,
          nodeId: submitted.nodeId,
          status: submitted.status,
          waitingFor: waiting?.kind === "strands" ? waiting.waitingFor : [],
          harness: route.target.harness,
          model: route.target.model,
        });
      }),
  );

  server.registerTool(
    "delegate",
    {
      title: "Delegate one bounded job",
      description:
        "Validate a Job Contract, persist it with its node, agent and routing decision, and start " +
        "a worker in an isolated worktree. Returns once the worker is running; wait with job.wait. " +
        "With `repair`, it opens a repair of a red or flaky gate (P15): the one job a planned run " +
        "adds outside its strands. A repair carries its `decision`, recorded in the same call; its " +
        "scope is the program's whole scope and its risk is high, whatever you ask for.",
      inputSchema: {
        objective: z.string().min(1),
        // Required for every job but a repair, whose scope is the program's (D-P15-10).
        scope: ScopeRequestSchema.optional(),
        acceptance: z.array(z.string().min(1)).min(1),
        dependencies: z.array(z.string().min(1)).optional(),
        // P8 (D-P8-01): what the job says about itself, so routing can place it.
        // Unset is the conservative choice, not the cheap one.
        ...CLASSIFICATION_INPUTS,
        // `sub-program` hands a bounded region of the program to an orchestrator
        // of its own, which delegates within it (D-P6-03).
        kind: z.enum(["job", "sub-program"]).optional(),
        ...PIN_INPUTS,
        repair: REPAIR_INPUT.optional(),
      },
    },
    async (input) =>
      guarded(async () => {
        const attached = requireAttached(state);
        // P15 (D-P15-04): a repair is the one job a planned run adds outside its
        // strands, so it is admitted before the plan's refusal below.
        if (input.repair !== undefined) {
          return await delegateRepair(state, attached, input, input.repair);
        }
        const scope = scopeOfOrdinaryDelegation(attached, input.scope);

        // 1. A valid Job Contract before anything else (A-03). An invalid one
        //    never becomes a node, so nothing is persisted on this path.
        const job = buildJobContract(state, attached, { ...input, scope, repair: undefined });

        // 2. Depth, concurrency and scope narrowing, all from `core` (A-11).
        const check = await checkDelegationOrRefuse(state, attached, scope);

        // 3. Where it runs, and why: the run's rules over its ladders (D-P8-04).
        const pins = pinsOf(input);
        const route = chooseRoute(attached, job, pins);

        // 4. The delegation is recorded, and the engine starts it when its parent
        //    has a free slot: at once, usually (D-P6-01, D-P6-02). The lifecycle
        //    continues in the background of this process (D-P3-04).
        const submitted = await attached.engine.submit({
          job,
          scope: check.scope,
          depth: check.depth,
          parentNodeId: attached.session.rootNodeId,
          route,
          pins,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
        });
        const started = submitted.started;

        return ok(
          started === undefined
            ? `Delegated job ${job.jobContractId} as node ${submitted.nodeId}. It is queued: its ` +
                "parent's concurrency limit is full, and it starts when a slot frees. Wait for it " +
                "with job.wait."
            : `Delegated job ${job.jobContractId} as node ${submitted.nodeId}. A ${route.target.model} ` +
                `worker on the ${route.target.harness} harness is running in ${started.worktree}. ` +
                "Wait for it with job.wait.",
          {
            jobId: job.jobContractId,
            nodeId: submitted.nodeId,
            status: submitted.status,
            agentId: started?.agentId ?? null,
            worktree: started?.worktree ?? null,
            harness: route.target.harness,
            provider: route.target.provider,
            model: route.target.model,
            wasOverride: route.wasOverride,
            ruleId: route.ruleId,
            ladder: route.ladder ?? null,
            tier: route.rung?.tier ?? null,
          },
        );
      }),
  );

  server.registerTool(
    "job.get",
    {
      title: "Read a job's state",
      description: "Node status, agent, commit, verification, checkpoint and outcome reason.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const report = await jobReport(deps, jobId);
        return ok(describeJob(report), report);
      }),
  );

  server.registerTool(
    "job.wait",
    {
      title: "Wait for a job",
      description:
        "Block until the job settles or the cap elapses, then answer exactly what job.get would. " +
        "Always returns: `timedOut` says whether the job settled or the wait did.",
      inputSchema: {
        jobId: z.string().min(1).optional(),
        // Several at once (D-P6-09): an orchestrator that can only wait on one
        // job serialises itself, whatever the engine can do.
        jobIds: z.array(z.string().min(1)).min(1).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
      },
    },
    async ({ jobId, jobIds, timeoutSeconds }) =>
      guarded(async () => {
        const wanted = jobsNamed(jobId, jobIds);
        const cap = jobWaitCap(deps.env);
        const limit = Math.min(timeoutSeconds ?? cap, cap);

        // Polls the control plane, not this process's memory: the answer must be
        // the one `GET …/state` would give.
        const { reports, first, timedOut } = await waitForFirstSettled(
          () => Promise.all(wanted.map((id) => jobReport(deps, id))),
          limit,
          JOB_WAIT_POLL_MS,
        );
        // The first to settle, or the first named when none has. One job in,
        // exactly what `job.get` would answer out, as it always was.
        const report = first ?? reports[0];
        if (report === undefined) throw new ToolRefusal("not_found", "no such job");
        // What everything under the root did meanwhile, so the session can keep
        // a human in the loop instead of going quiet until the wait returns.
        const activity = await activitySince(requireAttached(state), state.runtime.stores);
        const said = timedOut
          ? `${describeJob(report)} Still running after ${limit}s — this wait is capped below ` +
            "the harness's own tool timeout, so call job.wait again."
          : describeJob(report);
        return ok(activity.length === 0 ? said : `${said}\n\nMeanwhile:\n${activity.join("\n")}`, {
          ...report,
          timedOut,
          waitedSeconds: limit,
          ...(wanted.length > 1 ? { jobs: reports } : {}),
          activity,
        });
      }),
  );

  server.registerTool(
    "run.activity",
    {
      title: "What is happening in the run",
      description:
        "What every strand's orchestrator and every worker has done, as short lines labelled by " +
        "strand and job: delegations, their own progress notes and decisions, verification, " +
        "landings, failures, and a tool-call count as a heartbeat. job.wait already returns what " +
        "happened since the last call; this replays the last `limit` lines of the whole run.",
      inputSchema: { limit: z.number().int().min(1).max(500).optional() },
    },
    async ({ limit }) =>
      guarded(async () => {
        const attached = requireAttached(state);
        const lines = renderActivity(
          await feedFor(attached, state.runtime.stores).all(limit ?? 100),
        );
        return ok(lines.length === 0 ? "Nothing has happened yet." : lines.join("\n"), {
          activity: lines,
        });
      }),
  );

  server.registerTool(
    "job.retry",
    {
      title: "Retry a job that failed",
      description:
        "Runs it again from the current program head as a new attempt: fresh worktree, new agent. " +
        "For a job that ended failed (an integration_conflict, say), verification_failed or " +
        "interrupted. Read its outcomeReason first: a retry repeats the delegation as written. " +
        "Where it runs is Nightshift's: after a failure of the work (verification, a worker's " +
        "own failure, an examination) it climbs one rung of its ladder; after a conflict, a stale " +
        "base or an interrupt it keeps the model it had, because those say nothing about the model.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const attached = requireAttached(state);
        const retried = await attached.engine.retry(jobId as never).catch((error: unknown) => {
          // Two fixes of blocking findings, or an upheld one (D-P8-13): not a third.
          if (error instanceof FixLimitError)
            throw new ToolRefusal("validation_failed", error.message);
          throw error;
        });
        if (!retried) {
          const report = await jobReport(deps, jobId);
          throw new ToolRefusal(
            "validation_failed",
            `job ${jobId} is ${String(report.status)}, and only a job this session delegated that ` +
              "ended failed, verification_failed or interrupted can be retried.",
            { status: report.status },
          );
        }
        const report = await jobReport(deps, jobId);
        return ok(`Job ${jobId} is going round again. ${describeJob(report)}`, report);
      }),
  );

  server.registerTool(
    "finding.dispute",
    {
      title: "Dispute an examiner's finding",
      description:
        "For a job an independent examiner stopped: say why its blocking findings are wrong, and " +
        "an arbiter (a fresh invocation of the strongest model available) rules on them. Overturned, " +
        "the work that was examined lands as it is; upheld, the ruling is final and the next attempt " +
        "carries it out, which Nightshift starts itself. Either way the " +
        "ruling is recorded as a decision a human can reverse. Fix it instead with job.retry when " +
        "the examiner is right.",
      inputSchema: { jobId: z.string().min(1), reason: z.string().min(1) },
    },
    async ({ jobId, reason }) =>
      guarded(async () => {
        const attached = requireAttached(state);
        const result = await attached.engine.dispute(jobId as never, reason);
        if (result.kind === "refused") throw new ToolRefusal("validation_failed", result.reason);
        return ok(
          result.kind === "overturned"
            ? `The arbiter overturned the findings. Job ${jobId}'s examined work is going to the merge queue; wait for it with job.wait.`
            : `The arbiter upheld the finding: ${result.reason}. The ruling is final: Nightshift is starting the next attempt to carry it out; wait for it with job.wait.`,
          { ruling: result.kind },
        );
      }),
  );

  server.registerTool(
    "job.cancel",
    {
      title: "Cancel a running job",
      description: "Stop the worker and leave the node durably cancelled.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const attached = requireAttached(state);
        if (!(await attached.engine.cancel(jobId as never))) {
          throw new ToolRefusal(
            "not_found",
            `job ${jobId} is neither running nor queued in this session. Only a job this server ` +
              "holds can be cancelled by it.",
          );
        }
        const report = await jobReport(deps, jobId);
        return ok(`Cancelled job ${jobId}. ${describeJob(report)}`, report);
      }),
  );

  // --- Decisions and checkpoints -------------------------------------------------

  server.registerTool(
    "decision.record",
    {
      title: "Record a decision",
      description:
        "A choice a later reader would want the reasoning for, with the alternatives you rejected.",
      inputSchema: {
        ...DECISION_FIELDS,
        affectedNodes: z.array(z.string().min(1)).optional(),
      },
    },
    async (input) =>
      guarded(async () => {
        const attached = requireAttached(state);
        const { decisionId, checkpointBefore } = await recordDecision(
          state,
          attached,
          input,
          state.runtime.ids.next("dec"),
        );
        return ok(`Recorded decision ${decisionId}: ${input.choice}`, {
          decisionId,
          checkpointBefore,
        });
      }),
  );

  server.registerTool(
    "checkpoint.create",
    {
      title: "Checkpoint the program branch",
      description: "A durably addressable ref at the program branch head, so replay can return.",
      inputSchema: { label: z.string().min(1).optional() },
    },
    async ({ label }) =>
      guarded(async () => {
        const attached = requireAttached(state);
        const checkpoint = await createCheckpointAt(state, attached, label);
        return ok(
          `Checkpoint ${checkpoint.checkpointId} at ${checkpoint.commitSha} (${checkpoint.ref}).`,
          {
            checkpointId: checkpoint.checkpointId,
            commitSha: checkpoint.commitSha,
            ref: checkpoint.ref,
          },
        );
      }),
  );
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** What a decision says, as `decision.record` takes it and a repair carries it. */
const DECISION_FIELDS = {
  context: z.string().min(1),
  alternatives: z
    .array(z.object({ summary: z.string().min(1), rejectedBecause: z.string().optional() }))
    .min(1),
  choice: z.string().min(1),
  rationale: z.string().min(1),
  reversibility: ReversibilitySchema,
};

interface DecisionInput {
  readonly context: string;
  readonly alternatives: readonly {
    readonly summary: string;
    readonly rejectedBecause?: string | undefined;
  }[];
  readonly choice: string;
  readonly rationale: string;
  readonly reversibility: Reversibility;
  readonly affectedNodes?: readonly string[] | undefined;
}

/**
 * Records a decision of the root's, as `decision.record` always has: the same
 * store, the same event. Nothing is written when the run has no checkpoint.
 */
const recordDecision = async (
  state: OrchestratorSession,
  attached: AttachedRun,
  input: DecisionInput,
  decisionId: DecisionId,
): Promise<{ readonly decisionId: DecisionId; readonly checkpointBefore: string }> => {
  const { stores, clock } = state.runtime;
  const scope = attached.session.scope;
  const checkpoints = await stores.checkpoints.listByRun(scope);
  const latest = checkpoints.items.at(-1);
  if (latest === undefined) {
    throw new ToolRefusal(
      "not_found",
      "this run has no checkpoint yet, and a decision must point at the state it was made " +
        "from. That should not happen: `nightshift run` creates one.",
    );
  }

  await stores.decisions.put({
    schemaVersion: 1,
    ...scope,
    decisionId,
    executionNodeId: attached.session.rootNodeId,
    agentId: attached.session.orchestratorAgentId,
    context: input.context,
    alternatives: input.alternatives.map((alternative) =>
      alternative.rejectedBecause === undefined
        ? { summary: alternative.summary }
        : { summary: alternative.summary, rejectedBecause: alternative.rejectedBecause },
    ),
    choice: input.choice,
    rationale: input.rationale,
    reversibility: input.reversibility,
    checkpointBefore: latest.checkpointId,
    affectedNodes: (input.affectedNodes ?? []).map((id) => ExecutionNodeIdSchema.parse(id)),
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: nowIso(clock),
  });
  attached.outbox.emit({
    type: "decision.recorded",
    source: "mcp",
    payload: { decisionId, choice: input.choice, reversibility: input.reversibility },
    executionNodeId: attached.session.rootNodeId,
    agentId: attached.session.orchestratorAgentId,
  });
  return { decisionId, checkpointBefore: latest.checkpointId };
};

// ---------------------------------------------------------------------------
// Repairs (P15, D-P15-04, D-P15-06, D-P15-10)
// ---------------------------------------------------------------------------

/** What `delegate` takes to open a repair: the gates, why, and the decision that records it. */
const REPAIR_INPUT = z
  .object({
    cause: RepairCauseSchema,
    gates: z.array(z.string().min(1)).min(1),
    decision: z.object(DECISION_FIELDS).optional(),
  })
  .describe(
    "Open a repair of red or flaky gates (setup or verification step ids). `decision` is " +
      "required: every repair records one, as decision.record takes it.",
  );

type RepairInput = z.infer<typeof REPAIR_INPUT>;

const CAUSE_SENTENCE: Readonly<Record<RepairCause, string>> = {
  red_base:
    "These gates were red on the base this run started from. The strands wait on this repair " +
    "alone: fix them first.",
  flaky:
    "These gates failed and then passed when verification reran them on the same commit: they " +
    "are flaky. The work that met the flake landed; this repair runs off the blocking path.",
};

/** The paragraph Nightshift appends to every repair's objective, and the decision behind it. */
const repairObjective = (objective: string, repair: Repair, decision: DecisionInput): string =>
  [
    objective.trim(),
    "",
    `REPAIR (${repair.cause}) — the gates: ${repair.gates.join(", ")}.`,
    `${CAUSE_SENTENCE[repair.cause]} The gate standard holds: the fix must keep each gate at ` +
      "least as strong as it was. Weakening a gate (a retry wrapper, a looser assertion, a " +
      "deleted or skipped test, a removed check) is a blocking finding unless the decision below " +
      "says why. A repair may change anything it needs to, setup and gate commands included " +
      "(nightshift.config.json, the contract's setup and verification); a changed gate definition " +
      "applies to verifications after the repair lands. Its scope is the program's whole scope, " +
      "and it is examined at high risk.",
    "",
    `THE DECISION RECORDED WITH THIS REPAIR (${repair.decisionId})`,
    `Context: ${decision.context}`,
    `Choice: ${decision.choice}`,
    `Rationale: ${decision.rationale}`,
    ...decision.alternatives.map(
      (alternative) =>
        `Rejected: ${alternative.summary}` +
        (alternative.rejectedBecause === undefined ? "" : ` — ${alternative.rejectedBecause}`),
    ),
    `Reversibility: ${decision.reversibility}`,
  ].join("\n");

/**
 * A repair job (D-P15-04): the root's alone, with its decision recorded in the
 * same call; the program's whole scope (D-P15-10); examined at high risk,
 * whatever was asked for. Admitted on a planned run, outside every strand.
 */
const delegateRepair = async (
  state: OrchestratorSession,
  attached: AttachedRun,
  input: DelegateRequest,
  repairInput: RepairInput,
) => {
  const decision = repairInput.decision;
  if (decision === undefined) {
    // Refused before anything is written: no decision, no repair.
    throw new ToolRefusal(
      "repair_needs_decision",
      "every repair records a decision (D-P15-04), in the same call: pass repair.decision " +
        "{ context, alternatives, choice, rationale, reversibility } saying which gates broke, " +
        "how, and what the repair will do about them.",
      { cause: repairInput.cause, gates: repairInput.gates },
    );
  }
  if (input.kind === "sub-program") {
    throw new ToolRefusal(
      "validation_failed",
      "a repair is one job, not a sub-program: leave kind unset or pass job.",
    );
  }
  const { program } = attached.session;
  // The id first, so the contract that carries it is validated before anything is written.
  const decisionId = state.runtime.ids.next("dec");
  const repair: Repair = { cause: repairInput.cause, gates: repairInput.gates, decisionId };
  const scope: Scope = program.scope;
  const job = buildJobContract(state, attached, {
    ...input,
    objective: repairObjective(input.objective, repair, decision),
    scope,
    // High whatever was asked, so an independent examiner sees it (D-P15-04).
    risk: "high",
    kind: "job",
    repair,
  });
  const check = await checkDelegationOrRefuse(state, attached, scope);
  const pins = pinsOf(input);
  const route = chooseRoute(attached, job, pins);

  // The decision is recorded first, exactly as decision.record records one;
  // then the job that carries its id is submitted like any other.
  await recordDecision(state, attached, decision, decisionId);
  const submitted = await attached.engine.submit({
    job,
    scope: check.scope,
    depth: check.depth,
    parentNodeId: attached.session.rootNodeId,
    route,
    pins,
  });
  const started = submitted.started;
  return ok(
    `Delegated repair ${job.jobContractId} (${repair.cause}: ${repair.gates.join(", ")}) as node ` +
      `${submitted.nodeId}, with decision ${decisionId}. It has the program's whole scope and is ` +
      "examined at high risk. " +
      (repair.cause === "red_base"
        ? "The strands wait on it: wait for it with job.wait before anything else."
        : "It is off the blocking path: carry on with the strands, and do not finish the run " +
          "while it is in flight.") +
      (started === undefined ? " It is queued until its parent has a free slot." : ""),
    {
      jobId: job.jobContractId,
      nodeId: submitted.nodeId,
      status: submitted.status,
      decisionId,
      repair,
      agentId: started?.agentId ?? null,
      worktree: started?.worktree ?? null,
      harness: route.target.harness,
      provider: route.target.provider,
      model: route.target.model,
      wasOverride: route.wasOverride,
      ruleId: route.ruleId,
      ladder: route.ladder ?? null,
      tier: route.rung?.tier ?? null,
    },
  );
};

// ---------------------------------------------------------------------------
// `delegate`, one step at a time
// ---------------------------------------------------------------------------

/** What `delegate` was called with: a scope is optional only for a repair. */
type DelegateRequest = Omit<DelegateInput, "scope" | "repair"> & {
  readonly scope?: DelegateInput["scope"] | undefined;
  readonly ladder?: string | undefined;
  readonly tier?: Tier | undefined;
  readonly harness?: string | undefined;
  readonly effort?: Effort | undefined;
};

interface DelegateInput {
  readonly objective: string;
  readonly scope: Parameters<typeof checkAuthority>[3] & object;
  readonly acceptance: readonly string[];
  readonly dependencies?: readonly string[] | undefined;
  readonly risk?: "low" | "medium" | "high" | undefined;
  readonly ambiguity?: "low" | "medium" | "high" | undefined;
  readonly testability?: Testability | undefined;
  readonly jobKind?: JobKind | undefined;
  readonly model?: string | undefined;
  readonly kind?: "job" | "sub-program" | undefined;
  /** P15: set for a repair job alone, by `delegateRepair`. */
  readonly repair?: Repair | undefined;
}

/**
 * What a delegation may pin (D-P8-05): a ladder, a tier, a harness, a model, an
 * effort. Each is honoured only within the run's policy, and recorded as an
 * override. A pin never skips examination or escalation.
 */
const PIN_INPUTS = {
  ladder: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Pin a ladder of the org's (a provider's): only when you know better than the rules.",
    ),
  tier: TierSchema.optional().describe(
    "Pin where on the ladder to start: cheap, standard or frontier.",
  ),
  harness: z
    .string()
    .min(1)
    .optional()
    .describe("Pin a harness. Must be one the org's ladders use."),
  model: z.string().min(1).optional().describe("Pin a model. Must be on the org's ladders."),
  effort: EffortSchema.optional().describe("Pin a reasoning effort for the route."),
};

const pinsOf = (input: {
  readonly ladder?: string | undefined;
  readonly tier?: Tier | undefined;
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
}): RoutePins => ({
  ladder: input.ladder,
  tier: input.tier,
  harness: input.harness,
  model: input.model,
  effort: input.effort,
});

/**
 * A delegation that is not a repair: refused on a planned run, whose plan fixed
 * the seams (D-P7-04), and it must name its scope.
 */
const scopeOfOrdinaryDelegation = (
  attached: AttachedRun,
  scope: DelegateInput["scope"] | undefined,
): DelegateInput["scope"] => {
  if (attached.planSections !== undefined) {
    // The root of a planned run delegates strands and nothing else: how a
    // strand divides is its own orchestrator's, one level down.
    throw new ToolRefusal(
      "plan_fixes_strands",
      "this run follows a ratified plan, so the program node delegates its strands and " +
        "nothing else. Use strand.delegate { strandId }; a strand's own orchestrator " +
        "decides its jobs. A strand cannot be added or dropped without ratifying the plan again. " +
        "The one exception is a repair of a red or flaky gate: delegate with `repair` and its decision.",
      { strands: strandsOf(attached.session.program).map((strand) => strand.id) },
    );
  }
  if (scope === undefined) {
    throw new ToolRefusal(
      "validation_failed",
      "name the job's scope: only a repair takes the program's whole scope without one.",
    );
  }
  return scope;
};

/** The contract, validated. An invalid one never becomes a node. */
/**
 * A strand's Job Contract, built from the ratified plan and from nothing the
 * caller says but the strand's id (SC-P7-10): its objective is `strandBrief`'s.
 */
const buildStrandJob = (
  state: OrchestratorSession,
  attached: AttachedRun,
  strandId: string,
  kind: "job" | "sub-program",
): JobContract => {
  const { program } = attached.session;
  if (attached.planSections === undefined) {
    throw new ToolRefusal(
      "validation_failed",
      "this run has no ratified plan, so it has no strands. Use delegate.",
    );
  }
  let brief: StrandBrief;
  try {
    brief = strandBrief(program, attached.planSections, strandId);
  } catch (error) {
    if (!(error instanceof StrandBriefError)) throw error;
    throw new ToolRefusal("validation_failed", error.message, {
      strands: strandsOf(program).map((strand) => strand.id),
    });
  }
  return JobContractSchema.parse({
    schemaVersion: 1,
    ...attached.session.scope,
    jobContractId: state.runtime.ids.next("job"),
    objective: brief.objective,
    scope: brief.scope,
    acceptance: brief.acceptance,
    dependencies: [],
    // A strand's risk is the plan's to state (D-P8-01): the program's default.
    risk: program.defaultRisk,
    ambiguity: "medium",
    ...(kind === "sub-program" ? { kind: "orchestrate" } : {}),
    strandId,
    createdAt: nowIso(state.runtime.clock),
  });
};

/** The engine's own refusals of a strand, in the orchestrator's vocabulary. */
const submitStrand = async (
  attached: AttachedRun,
  submission: Parameters<AttachedRun["engine"]["submit"]>[0],
): ReturnType<AttachedRun["engine"]["submit"]> => {
  try {
    return await attached.engine.submit(submission);
  } catch (error) {
    if (error instanceof StrandBlockedError) {
      throw new ToolRefusal("strand_blocked", error.message, {
        strandId: error.strandId,
        blockedBy: error.blockers,
      });
    }
    if (error instanceof StrandDelegationError) {
      throw new ToolRefusal("validation_failed", error.message);
    }
    throw error;
  }
};

const describeStrandSubmission = (
  strandId: string,
  submitted: { readonly status: string; readonly nodeId: string },
  waiting: ReturnType<AttachedRun["engine"]["waiting"]>,
): string => {
  if (submitted.status === "running") {
    return `Strand ${strandId} is running as node ${submitted.nodeId}.`;
  }
  if (waiting?.kind !== "strands") {
    return `Strand ${strandId} is queued as node ${submitted.nodeId}; it starts when a slot frees.`;
  }
  const verb = waiting.waitingFor.length === 1 ? "has" : "have";
  return `Strand ${strandId} is queued as node ${submitted.nodeId}: it starts when ${waiting.waitingFor.join(", ")} ${verb} succeeded.`;
};

const buildJobContract = (
  state: OrchestratorSession,
  attached: AttachedRun,
  input: DelegateInput,
): JobContract =>
  JobContractSchema.parse({
    schemaVersion: 1,
    ...attached.session.scope,
    jobContractId: state.runtime.ids.next("job"),
    objective: input.objective,
    scope: input.scope,
    acceptance: input.acceptance,
    dependencies: input.dependencies ?? [],
    // Unstated means conservative (D-P8-01): the program's risk, medium
    // ambiguity, weak testability. Never the cheapest rung by omission.
    ...conservativeDefaults(attached.session.program),
    ...(input.risk === undefined ? {} : { risk: input.risk }),
    ...(input.ambiguity === undefined ? {} : { ambiguity: input.ambiguity }),
    ...(input.testability === undefined ? {} : { testability: input.testability }),
    ...(input.kind === "sub-program"
      ? { kind: "orchestrate" }
      : input.jobKind === undefined
        ? {}
        : { kind: input.jobKind }),
    ...(input.repair === undefined ? {} : { repair: input.repair }),
    createdAt: nowIso(state.runtime.clock),
  });

/** Depth, concurrency and scope narrowing, from `core`'s own rule. */
const checkDelegationOrRefuse = async (
  state: OrchestratorSession,
  attached: AttachedRun,
  request: DelegateInput["scope"],
): Promise<{ readonly depth: number; readonly scope: Scope }> => {
  const nodes = await state.runtime.stores.executionNodes.listByRun(attached.session.scope);
  const tree = buildTree([...nodes.items]);
  // Authority, depth and scope. Not concurrency: excess work queues (D-P6-02).
  const check = checkAuthority(
    tree,
    attached.session.rootNodeId,
    attached.session.program.delegationLimits,
    request,
  );
  if (check.allowed) return { depth: check.depth, scope: check.scope };

  const reason = check.reason;
  const code: RefusalCode =
    reason.kind === "scope_widening"
      ? "scope_widening"
      : reason.kind === "depth_limit_exceeded"
        ? "depth_limit_exceeded"
        : reason.kind === "concurrency_limit_exceeded"
          ? "concurrency_limit_exceeded"
          : "validation_failed";
  throw new ToolRefusal(code, describeRejection(reason), { ...reason });
};

/** Routing, with its own refusal surfaced as a validation failure. */
const chooseRoute = (attached: AttachedRun, job: JobContract, pins: RoutePins): RouteChoice => {
  try {
    return routeJob(attached.session.run, attached.session.program, job, { pins, unavailable: [] });
  } catch (error) {
    if (error instanceof RoutingRefusedError) {
      throw new ToolRefusal("validation_failed", error.message, {
        routingCode: error.code,
        eligibleOptions: error.eligibleOptions,
      });
    }
    throw error;
  }
};

/** A refusal a model can act on, rather than a rule's internal vocabulary. */
const describeRejection = (reason: DelegationRejection): string => {
  switch (reason.kind) {
    case "scope_widening":
      return `the requested scope claims authority the program does not hold: ${reason.reasons.join("; ")}`;
    case "depth_limit_exceeded":
      return `this would be depth ${reason.depth}, and the program allows ${reason.maxDepth}`;
    case "concurrency_limit_exceeded":
      // The same sentence whichever check fired first — the program's policy
      // here, or the runner's own one-at-a-time rule. An orchestrator should not
      // have to learn two vocabularies for the same wait.
      return (
        `${reason.running} job(s) already hold the limit of ${reason.maxConcurrency}. Wait for ` +
        "the running job with job.wait, or stop it with job.cancel. More than one job in flight " +
        "arrives in P6."
      );
    case "parent_is_terminal":
      return `the run's root node is ${reason.parentStatus} and can take no further jobs`;
    case "parent_cannot_delegate":
      return `the run's root node is a ${reason.parentKind} and holds no delegation authority`;
  }
};
