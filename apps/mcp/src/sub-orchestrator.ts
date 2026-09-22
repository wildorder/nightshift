/**
 * The sub-orchestrator role's tools (P6, D-P6-03, D-P6-04).
 *
 * A sub-program's orchestrator plans and delegates inside the subtree under its
 * own node. It holds a **delegating execution token** and nothing else, and what
 * is missing here is, as in the worker role, the point:
 *
 * - **It starts nothing.** `delegate` writes a Job Contract and a `validated`
 *   node through the control plane and returns. The run's one engine, in the
 *   human's orchestrator's process, finds the record and does the rest
 *   (D-P6-01). There is no execution layer in this process and no route to the
 *   program branch.
 * - **It writes no code.** There is no `complete` that snapshots anything: its
 *   directory is a checkout to read, and nothing in it is ever collected.
 * - **It sees its subtree.** Every read is of its own node or something under
 *   it; the API refuses the rest (`ORCHESTRATOR_ACCESS`).
 *
 * `job.cancel` and `job.retry` are requests, made the only way this role can
 * make one: by asking for a status. `cancelled` asks the engine to stop a node;
 * `queued` is the table's own `retry` edge from a failure.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type ExecutionNode,
  type ExecutionNodeId,
  type JobContractId,
  JobContractSchema,
  ReversibilitySchema,
  RiskLevelSchema,
  ScopeRequestSchema,
} from "@nightshift/contracts";
import {
  explainWidening,
  type IdGenerator,
  isDoneForNow,
  isSettled,
  narrow,
  nowIso,
  RETRYABLE_STATUSES,
  transition,
} from "@nightshift/core";
import {
  git,
  recordWorkerDecision,
  reportProgress,
  type WorkerEnvironment,
  type WorkerIdentity,
} from "@nightshift/execution";
import { NoCheckpointError } from "@nightshift/harness";
import { z } from "zod";
import { guarded, ok, ToolRefusal, waitForFirstSettled } from "./results.js";

export interface SubOrchestratorDeps {
  readonly identity: WorkerIdentity;
  readonly environment: WorkerEnvironment;
  readonly ids: IdGenerator;
  /** The cap on one `job.wait`, in seconds. Below a harness's own tool timeout. */
  readonly waitCapSeconds: number;
}

const WAIT_POLL_MS = 500;

export const registerSubOrchestratorTools = (
  server: McpServer,
  deps: SubOrchestratorDeps,
): void => {
  const { identity, environment, ids } = deps;
  const { stores, clock, outbox } = environment;
  const { scope } = identity;
  /** What this process delegated: Job Contract → node. */
  const delegated = new Map<JobContractId, ExecutionNodeId>();

  const own = async (): Promise<ExecutionNode> => {
    const node = await stores.executionNodes.get(scope, identity.executionNodeId);
    if (node === undefined)
      throw new ToolRefusal("not_found", "this sub-program's node is not readable");
    return node;
  };

  /** Every node under this one, read level by level: the only way this role may. */
  const descendants = async (): Promise<ExecutionNode[]> => {
    const found: ExecutionNode[] = [];
    const frontier: ExecutionNodeId[] = [identity.executionNodeId];
    while (frontier.length > 0) {
      const parent = frontier.pop() as ExecutionNodeId;
      for (const child of await stores.executionNodes.listChildren(scope, parent)) {
        found.push(child);
        if (child.kind !== "job") frontier.push(child.executionNodeId);
      }
    }
    return found;
  };

  const nodeOf = async (jobId: string): Promise<ExecutionNode> => {
    const known = delegated.get(jobId as JobContractId);
    const node =
      known === undefined
        ? (await descendants()).find((candidate) => candidate.jobContractId === jobId)
        : await stores.executionNodes.get(scope, known);
    if (node === undefined) {
      throw new ToolRefusal("not_found", `no node under this sub-program carries job ${jobId}`);
    }
    return node;
  };

  const report = async (jobId: string): Promise<Record<string, unknown>> => {
    const node = await nodeOf(jobId);
    const verification = (await stores.verifications.listByNode(scope, node.executionNodeId)).at(
      -1,
    );
    const agent = (await stores.agents.listByNode(scope, node.executionNodeId)).at(-1);
    return {
      jobContractId: jobId,
      nodeId: node.executionNodeId,
      kind: node.kind,
      status: node.status,
      settled: isDoneForNow(node.status),
      commitSha: node.commitSha,
      outcomeReason: node.outcomeReason ?? null,
      agent:
        agent === undefined
          ? null
          : { agentId: agent.agentId, status: agent.status, model: agent.model },
      verification:
        verification === undefined
          ? null
          : {
              outcome: verification.outcome,
              commands: verification.commands.map((command) => ({
                stepId: command.stepId,
                exitCode: command.exitCode,
                logArtifactId: command.logArtifactId ?? null,
              })),
            },
    };
  };

  const describe = (r: Readonly<Record<string, unknown>>): string =>
    `Job ${String(r.jobContractId)} is ${String(r.status)}.` +
    (r.outcomeReason === null ? "" : ` Reason: ${String(r.outcomeReason)}.`);

  server.registerTool(
    "subprogram.get",
    {
      title: "Read your sub-program",
      description:
        "Your objective, acceptance criteria, the scope you may delegate within, and what you have delegated so far.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const node = await own();
        const contract = await stores.jobContracts.get(scope, identity.jobContractId);
        const children = await descendants();
        return ok(
          `Objective: ${contract?.objective ?? "(unreadable)"}\n` +
            `You may delegate within: ${node.scope.includes.join(", ")}\n` +
            `Delegated so far: ${children.length === 0 ? "nothing" : children.map((child) => `${child.jobContractId} ${child.status}`).join("; ")}`,
          {
            objective: contract?.objective ?? null,
            acceptance: contract?.acceptance ?? [],
            scope: node.scope,
            status: node.status,
            checkout: identity.worktree,
            children: children.map((child) => ({
              jobId: child.jobContractId,
              nodeId: child.executionNodeId,
              kind: child.kind,
              status: child.status,
            })),
          },
        );
      }),
  );

  server.registerTool(
    "delegate",
    {
      title: "Delegate one bounded piece of work",
      description:
        "Record a Job Contract and its node under your sub-program. Nightshift's engine starts it " +
        "when a slot is free, verifies it and integrates it. Returns at once; wait with job.wait.",
      inputSchema: {
        kind: z.enum(["job", "sub-program"]).optional(),
        objective: z.string().min(1),
        scope: ScopeRequestSchema,
        acceptance: z.array(z.string().min(1)).min(1),
        risk: RiskLevelSchema.optional(),
        ambiguity: RiskLevelSchema.optional(),
      },
    },
    async (input) =>
      guarded(async () => {
        const parent = await own();
        // Scope can only narrow (A-11). Checked here so the refusal lists every
        // pattern that was not covered; the API checks it again, with depth and
        // everything else this role cannot see.
        const widenings = explainWidening(parent.scope, input.scope);
        if (widenings.length > 0) {
          throw new ToolRefusal(
            "scope_widening",
            `the requested scope claims authority this sub-program does not hold: ${widenings.join("; ")}`,
            { reasons: widenings },
          );
        }

        const at = nowIso(clock);
        const job = JobContractSchema.parse({
          schemaVersion: 1,
          ...scope,
          jobContractId: ids.next("job"),
          objective: input.objective,
          scope: input.scope,
          acceptance: input.acceptance,
          dependencies: [],
          risk: input.risk ?? "low",
          ambiguity: input.ambiguity ?? "low",
          createdAt: at,
        });
        await stores.jobContracts.put(job);

        const node: ExecutionNode = {
          schemaVersion: 1,
          ...scope,
          executionNodeId: ids.next("node"),
          kind: input.kind ?? "job",
          parentNodeId: parent.executionNodeId,
          depth: parent.depth + 1,
          scope: narrow(parent.scope, input.scope),
          status: "validated",
          jobContractId: job.jobContractId,
          commitSha: null,
          createdAt: at,
          updatedAt: at,
        };
        await stores.executionNodes.put(node);
        delegated.set(job.jobContractId, node.executionNodeId);
        outbox.emit({
          type: "node.delegated",
          source: "mcp",
          payload: { jobContractId: job.jobContractId, objective: job.objective, kind: node.kind },
          executionNodeId: node.executionNodeId,
          agentId: identity.agentId,
        });
        await outbox.flush(5_000);

        return ok(
          `Delegated ${node.kind} ${job.jobContractId} as node ${node.executionNodeId}. Nightshift ` +
            "starts it when a slot is free. Wait for it with job.wait.",
          {
            jobId: job.jobContractId,
            nodeId: node.executionNodeId,
            kind: node.kind,
            status: "validated",
          },
        );
      }),
  );

  server.registerTool(
    "job.get",
    {
      title: "Read a job you delegated",
      description: "Its status, commit, verification and outcome reason.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const r = await report(jobId);
        return ok(describe(r), r);
      }),
  );

  server.registerTool(
    "job.wait",
    {
      title: "Wait for jobs you delegated",
      description:
        "Block until the first of these jobs settles, or the cap elapses. Always returns: " +
        "`timedOut` says whether a job settled or the wait did.",
      inputSchema: {
        jobId: z.string().min(1).optional(),
        jobIds: z.array(z.string().min(1)).min(1).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
      },
    },
    async ({ jobId, jobIds, timeoutSeconds }) =>
      guarded(async () => {
        const wanted = [...(jobIds ?? []), ...(jobId === undefined ? [] : [jobId])];
        if (wanted.length === 0)
          throw new ToolRefusal("validation_failed", "name at least one job");
        const limit = Math.min(timeoutSeconds ?? deps.waitCapSeconds, deps.waitCapSeconds);
        const { reports, first, timedOut } = await waitForFirstSettled(
          () => Promise.all(wanted.map(report)),
          limit,
          WAIT_POLL_MS,
        );
        return first === undefined
          ? ok(`None of ${wanted.length} jobs settled within ${limit}s. Call job.wait again.`, {
              timedOut,
              waitedSeconds: limit,
              jobs: reports,
            })
          : ok(describe(first), { ...first, timedOut, jobs: reports });
      }),
  );

  server.registerTool(
    "job.cancel",
    {
      title: "Cancel a job you delegated",
      description: "Asks Nightshift to stop it. The node ends durably cancelled.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const node = await nodeOf(jobId);
        if (isSettled(node.status) && !RETRYABLE_STATUSES.includes(node.status)) {
          return ok(`Job ${jobId} is already ${node.status}.`, await report(jobId));
        }
        await stores.executionNodes.put(transition(node, "cancel", nowIso(clock)));
        return ok(`Asked Nightshift to cancel job ${jobId}.`, await report(jobId));
      }),
  );

  server.registerTool(
    "job.retry",
    {
      title: "Retry a job that failed",
      description:
        "Runs it again from the current program head, as a new attempt. For a job that ended failed, " +
        "verification_failed or interrupted; read its outcomeReason first.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async ({ jobId }) =>
      guarded(async () => {
        const node = await nodeOf(jobId);
        if (!RETRYABLE_STATUSES.includes(node.status)) {
          throw new ToolRefusal(
            "validation_failed",
            `job ${jobId} is ${node.status}, which is not retryable`,
          );
        }
        const { outcomeReason: _previous, ...requeued } = transition(node, "retry", nowIso(clock));
        await stores.executionNodes.put({ ...requeued, commitSha: null });
        return ok(`Job ${jobId} is queued again. Wait for it with job.wait.`, await report(jobId));
      }),
  );

  server.registerTool(
    "decision.record",
    {
      title: "Record a decision",
      description: "A choice about this sub-program a later reader would want the reasoning for.",
      inputSchema: {
        context: z.string().min(1),
        alternatives: z
          .array(z.object({ summary: z.string().min(1), rejectedBecause: z.string().optional() }))
          .min(1),
        choice: z.string().min(1),
        rationale: z.string().min(1),
        reversibility: ReversibilitySchema,
      },
    },
    async (input) =>
      guarded(async () => {
        const decision = await recordWorkerDecision(environment, identity, ids, input).catch(
          (error: unknown) => {
            if (error instanceof NoCheckpointError)
              throw new ToolRefusal("not_found", error.message);
            throw error;
          },
        );
        return ok(`Recorded decision ${decision.decisionId}.`, { decisionId: decision.decisionId });
      }),
  );

  server.registerTool(
    "subprogram.progress",
    {
      title: "Report progress",
      description: "Say what you are doing. Recorded as intent, on the record, as you go.",
      inputSchema: {
        message: z.string().min(1),
        percent: z.number().int().min(0).max(100).optional(),
      },
    },
    async ({ message, percent }) =>
      guarded(async () => {
        reportProgress(environment, identity, message, percent);
        return ok("Noted.", { message });
      }),
  );

  server.registerTool(
    "subprogram.refresh",
    {
      title: "Bring your checkout up to date",
      description:
        "Moves your read-only checkout to the run's latest checkpoint, so you can read what your " +
        "jobs integrated. Anything you changed in it is discarded: it is never collected.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const latest = (await stores.checkpoints.listByRun(scope)).items.at(-1);
        if (latest === undefined)
          throw new ToolRefusal("not_found", "this run has no checkpoint yet");
        await git(environment.git, ["checkout", "--detach", "--force", latest.commitSha], {
          cwd: identity.worktree,
        });
        return ok(`Your checkout is at ${latest.commitSha}.`, { commitSha: latest.commitSha });
      }),
  );

  const end = async (
    status: "succeeded" | "failed",
    reason: string | undefined,
  ): Promise<ExecutionNode> => {
    const node = await own();
    if (node.status !== "running") {
      throw new ToolRefusal("validation_failed", `this sub-program is already ${node.status}`);
    }
    const ended: ExecutionNode = {
      ...node,
      status,
      updatedAt: nowIso(clock),
      ...(reason === undefined ? {} : { outcomeReason: reason }),
    };
    await stores.executionNodes.put(ended);
    outbox.emit({
      type: status === "succeeded" ? "node.succeeded" : "node.failed",
      source: "mcp",
      payload: reason === undefined ? {} : { reason },
      executionNodeId: node.executionNodeId,
      agentId: identity.agentId,
    });
    await outbox.flush(5_000);
    return ended;
  };

  server.registerTool(
    "subprogram.complete",
    {
      title: "Report the sub-program complete",
      description:
        "Call this when your objective is met. Refused while anything you delegated is still in " +
        "flight: wait for it, or cancel it, first.",
      inputSchema: { summary: z.string().min(1) },
    },
    async ({ summary }) =>
      guarded(async () => {
        const unsettled = (await descendants()).filter((child) => !isDoneForNow(child.status));
        if (unsettled.length > 0) {
          throw new ToolRefusal(
            "job_running",
            `${unsettled.length} of your jobs are still in flight: ` +
              `${unsettled.map((child) => `${child.jobContractId} ${child.status}`).join("; ")}. ` +
              "Wait for them with job.wait, or cancel them, before completing.",
            { unsettled: unsettled.map((child) => child.jobContractId) },
          );
        }
        reportProgress(environment, identity, summary.slice(0, 2_000), 100);
        await end("succeeded", undefined);
        return ok("Recorded. Your sub-program has succeeded; you can stop now.", {
          status: "succeeded",
        });
      }),
  );

  server.registerTool(
    "subprogram.fail",
    {
      title: "Report the sub-program failed",
      description:
        "Use this when the objective cannot be met. Whatever you delegated that is still running is " +
        "cancelled. A clear reason is worth far more than a guess.",
      inputSchema: { reason: z.string().min(1) },
    },
    async ({ reason }) =>
      guarded(async () => {
        await end("failed", reason);
        return ok("Recorded. Your sub-program has failed durably, with your reason attached.", {
          reason,
        });
      }),
  );
};
