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
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Checkpoint,
  ExecutionNode,
  JobContract,
  ProgramContract,
  RouteChoice,
  Scope,
} from "@nightshift/contracts";
import {
  ExecutionNodeIdSchema,
  JobContractSchema,
  ReversibilitySchema,
  RiskLevelSchema,
  ScopeRequestSchema,
} from "@nightshift/contracts";
import {
  buildTree,
  checkAuthority,
  type DelegationRejection,
  highestSequence,
  nowIso,
  pendingCount,
} from "@nightshift/core";
import { endProgramNode } from "@nightshift/execution";
import { configuredRoute, RoutingRefusedError } from "@nightshift/routing";
import { z } from "zod";
import type { RefusalCode } from "./results.js";
import { guarded, ok, ToolRefusal, waitForFirstSettled } from "./results.js";
import type { AttachedRun, OrchestratorSession } from "./session.js";
import { attachRun, createCheckpointAt, describeNodeLine, startNewRun } from "./session.js";

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

/** Statuses from which nothing further will happen without someone asking. */
const SETTLED: readonly ExecutionNode["status"][] = [
  "integrated",
  "failed",
  "cancelled",
  "interrupted",
  "verification_failed",
  "examination_failed",
];

export interface OrchestratorDeps {
  readonly state: OrchestratorSession;
  readonly env: Readonly<Record<string, string | undefined>>;
}

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
    settled: SETTLED.includes(node.status),
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
  return `Job ${String(report.jobContractId)} is ${status}.${commit}${verified}${reason}`;
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
  const { running, queued } = attached.engine.snapshot();
  throw new ToolRefusal(
    "job_running",
    `${running.length} job${running.length === 1 ? " is" : "s are"} running and ${queued.length} queued. ` +
      "Wait for them with job.wait, or stop them with job.cancel, before finishing the run.",
    { running, queued },
  );
};

/** A run that ended badly says why. Killing work must never leave silence. */
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
        const contract: unknown = JSON.parse(await readFile(path, "utf8"));
        const started = await startNewRun(state, { program: contract, repoPath: repo, model });
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
        return ok(
          `Attached to run ${attached.session.scope.runId}. ` +
            (attached.replayed > 0
              ? `Replayed ${attached.replayed} spooled events from an earlier session. `
              : "") +
            "Delegate a job with `delegate`.",
          {
            runId: attached.session.scope.runId,
            rootNodeId: attached.session.rootNodeId,
            agentId: attached.session.orchestratorAgentId,
            replayedEvents: attached.replayed,
          },
        );
      }),
  );

  server.registerTool(
    "run.finish",
    {
      title: "Finish the run",
      description: "Give the run a terminal status. Refused while a job is running.",
      inputSchema: {
        outcome: z.enum(["succeeded", "failed", "cancelled"]),
        reason: z.string().min(1).optional(),
      },
    },
    async ({ outcome, reason }) =>
      guarded(async () => {
        const attached = requireAttached(state);
        await assertNoJobRunning(deps, attached);
        assertEndingExplained(outcome, reason);

        const { stores, clock } = state.runtime;
        const run = await stores.runs.get(attached.session.scope, attached.session.scope.runId);
        if (run === undefined) throw new ToolRefusal("not_found", "this run no longer exists");
        await stores.runs.put({
          ...run,
          status: outcome,
          endedAt: nowIso(clock),
          ...(reason === undefined ? {} : { outcomeReason: reason }),
        });
        // The program node follows its run (D-P5-06): `succeeded`, never
        // `integrated`, because a program node integrates nothing.
        await endProgramNode(state.runtime, attached.session, outcome, reason);
        attached.outbox.emit({
          type: outcome === "succeeded" ? "run.completed" : `run.${outcome}`,
          source: "control-plane",
          payload: reason === undefined ? {} : { reason },
          executionNodeId: attached.session.rootNodeId,
        });
        await attached.outbox.flush(5_000);
        return ok(`Run ${attached.session.scope.runId} is ${outcome}.`, {
          runId: attached.session.scope.runId,
          outcome,
        });
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
    "delegate",
    {
      title: "Delegate one bounded job",
      description:
        "Validate a Job Contract, persist it with its node, agent and routing decision, and start " +
        "a worker in an isolated worktree. Returns once the worker is running; wait with job.wait.",
      inputSchema: {
        objective: z.string().min(1),
        scope: ScopeRequestSchema,
        acceptance: z.array(z.string().min(1)).min(1),
        dependencies: z.array(z.string().min(1)).optional(),
        risk: RiskLevelSchema.optional(),
        ambiguity: RiskLevelSchema.optional(),
        // `sub-program` hands a bounded region of the program to an orchestrator
        // of its own, which delegates within it (D-P6-03).
        kind: z.enum(["job", "sub-program"]).optional(),
        harness: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      },
    },
    async (input) =>
      guarded(async () => {
        const attached = requireAttached(state);

        // 1. A valid Job Contract before anything else (A-03). An invalid one
        //    never becomes a node, so nothing is persisted on this path.
        const job = buildJobContract(state, attached, input);

        // 2. Examination policy, before the expensive part (D-P3-07).
        assertExaminable(attached.session.program, job);

        // 3. Depth, concurrency and scope narrowing, all from `core` (A-11).
        const check = await checkDelegationOrRefuse(state, attached, input.scope);

        // 4. Where it runs, and why (D-P3-08).
        const route = chooseRoute(attached.session.program, job, {
          harness: input.harness,
          model: input.model,
        });

        // 5. The delegation is recorded, and the engine starts it when its parent
        //    has a free slot: at once, usually (D-P6-01, D-P6-02). The lifecycle
        //    continues in the background of this process (D-P3-04).
        const submitted = await attached.engine.submit({
          job,
          scope: check.scope,
          depth: check.depth,
          parentNodeId: attached.session.rootNodeId,
          route,
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
        return ok(
          timedOut
            ? `${describeJob(report)} Still running after ${limit}s — this wait is capped below ` +
                "the harness's own tool timeout, so call job.wait again."
            : describeJob(report),
          {
            ...report,
            timedOut,
            waitedSeconds: limit,
            ...(wanted.length > 1 ? { jobs: reports } : {}),
          },
        );
      }),
  );

  server.registerTool(
    "job.retry",
    {
      title: "Retry a job that failed",
      description:
        "Runs it again from the current program head as a new attempt: fresh worktree, new agent. " +
        "For a job that ended failed (an integration_conflict, say), verification_failed or " +
        "interrupted. Read its outcomeReason first: a retry repeats the delegation as written.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const attached = requireAttached(state);
        if (!(await attached.engine.retry(jobId as never))) {
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
        context: z.string().min(1),
        alternatives: z
          .array(z.object({ summary: z.string().min(1), rejectedBecause: z.string().optional() }))
          .min(1),
        choice: z.string().min(1),
        rationale: z.string().min(1),
        reversibility: ReversibilitySchema,
        affectedNodes: z.array(z.string().min(1)).optional(),
      },
    },
    async (input) =>
      guarded(async () => {
        const attached = requireAttached(state);
        const { stores, ids, clock } = state.runtime;
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

        const decisionId = ids.next("dec");
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
        return ok(`Recorded decision ${decisionId}: ${input.choice}`, {
          decisionId,
          checkpointBefore: latest.checkpointId,
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
// `delegate`, one step at a time
// ---------------------------------------------------------------------------

interface DelegateInput {
  readonly objective: string;
  readonly scope: Parameters<typeof checkAuthority>[3] & object;
  readonly acceptance: readonly string[];
  readonly dependencies?: readonly string[] | undefined;
  readonly risk?: "low" | "medium" | "high" | undefined;
  readonly ambiguity?: "low" | "medium" | "high" | undefined;
  readonly model?: string | undefined;
  readonly kind?: "job" | "sub-program" | undefined;
}

/** The contract, validated. An invalid one never becomes a node. */
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
    risk: input.risk ?? attached.session.program.defaultRisk,
    ambiguity: input.ambiguity ?? attached.session.program.defaultRisk,
    createdAt: nowIso(state.runtime.clock),
  });

/**
 * D-P3-07, checked before the expensive part.
 *
 * Refusing loudly beats silently skipping a step the contract asked for — a job
 * that quietly ran without the scrutiny its risk demanded would look identical
 * to one that had it.
 */
const assertExaminable = (program: ProgramContract, job: JobContract): void => {
  const requirement = program.examinationPolicy[job.risk];
  if (!requirement.required) return;
  throw new ToolRefusal(
    "examination_unavailable",
    `this program's examination policy requires an examiner for ${job.risk}-risk work, and ` +
      "examination arrives in P7. Lower the job's risk if that is honest, or change the " +
      "program's policy — do not pretend the work was examined.",
    { risk: job.risk, requirement },
  );
};

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
const chooseRoute = (
  program: ProgramContract,
  job: JobContract,
  override: { readonly harness?: string | undefined; readonly model?: string | undefined },
): RouteChoice => {
  try {
    return configuredRoute({ program, job, override });
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
