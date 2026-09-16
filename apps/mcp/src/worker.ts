/**
 * The worker role's tools (contract §4.5).
 *
 * Five tools, and the interesting thing about them is what is missing. There is
 * no `delegate`, no `run.*`, no `checkpoint.create`, no `job.cancel`, and
 * nothing that creates a `Verification`. Not because a check refuses them —
 * because **they are not registered**, so a worker cannot call what does not
 * exist. That is D-P3-01's process boundary doing real work: the role is fixed
 * at spawn time by the party that spawned it, and the tool surface follows.
 *
 * `job.get` takes no argument. A worker has exactly one job, its identity is in
 * its environment, and a worker that could name a job could name someone else's.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReversibilitySchema } from "@nightshift/contracts";
import type { IdGenerator } from "@nightshift/core";
import { nowIso } from "@nightshift/core";
import {
  completeJob,
  failJob,
  reportProgress,
  type WorkerEnvironment,
  type WorkerIdentity,
} from "@nightshift/execution";
import { z } from "zod";
import { guarded, ok, ToolRefusal } from "./results.js";

export interface WorkerDeps {
  readonly identity: WorkerIdentity;
  readonly environment: WorkerEnvironment;
  readonly ids: IdGenerator;
}

export const registerWorkerTools = (server: McpServer, deps: WorkerDeps): void => {
  const { identity, environment } = deps;

  server.registerTool(
    "job.get",
    {
      title: "Read your job",
      description:
        "Your objective, the scope you may touch, your acceptance criteria and your worktree. " +
        "No argument: you have one job, and this is it.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const job = await environment.stores.jobContracts.get(
          identity.scope,
          identity.jobContractId,
        );
        const node = await environment.stores.executionNodes.get(
          identity.scope,
          identity.executionNodeId,
        );
        if (job === undefined || node === undefined) {
          throw new ToolRefusal("not_found", "this job's records are not readable");
        }
        return ok(
          `Objective: ${job.objective}\n` +
            `Acceptance: ${job.acceptance.map((line) => `- ${line}`).join("\n")}\n` +
            `You may change: ${node.scope.includes.join(", ")}` +
            (node.scope.excludes.length > 0
              ? `, but never ${node.scope.excludes.join(", ")}`
              : "") +
            `\nWorking directory: ${identity.worktree}\n` +
            "Finish with job.complete, or job.fail if you are stuck. Do not commit.",
          {
            jobContractId: job.jobContractId,
            objective: job.objective,
            acceptance: job.acceptance,
            scope: node.scope,
            worktree: identity.worktree,
            status: node.status,
          },
        );
      }),
  );

  server.registerTool(
    "job.progress",
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
    "job.complete",
    {
      title: "Report the job complete",
      description:
        "Nightshift snapshots your worktree into one commit it authors, checks every changed " +
        "path against your scope, and records the result. Do not commit anything yourself.",
      inputSchema: { summary: z.string().min(1) },
    },
    async ({ summary }) =>
      guarded(async () => {
        const result = await completeJob(environment, identity, summary);
        // The flush matters: the harness may kill this process the moment the
        // tool returns, and an unsent `node.implemented` would make a completed
        // job look like a silent one.
        await environment.outbox.flush(5_000);

        if (result.kind === "scope_violation") {
          // Already durably failed. The worker is being told, not asked.
          return ok(
            `Refused, and the job has failed: you changed ${result.offending.join(", ")}, which is ` +
              "outside the scope you were given. Nothing you did will be integrated. If the work " +
              "genuinely needs those paths, that is a job for your orchestrator to delegate, not " +
              "something to work around.",
            { outcome: "scope_violation", offending: result.offending, reason: result.reason },
          );
        }
        return ok(
          `Recorded as implemented at commit ${result.commitSha}, with ${result.changedPaths.length} ` +
            "changed paths. Nightshift now verifies it; implemented is not verified, and the " +
            "verification result is what decides whether this integrates.",
          {
            outcome: "implemented",
            commitSha: result.commitSha,
            changedPaths: result.changedPaths,
          },
        );
      }),
  );

  server.registerTool(
    "job.fail",
    {
      title: "Report the job as failed",
      description:
        "Use this when you are stuck, the job is impossible as specified, or finishing it would " +
        "mean going outside your scope. A clear reason is worth far more than a guess.",
      inputSchema: { reason: z.string().min(1) },
    },
    async ({ reason }) =>
      guarded(async () => {
        await failJob(environment, identity, reason);
        await environment.outbox.flush(5_000);
        return ok("Recorded. The job has failed durably, with your reason attached.", { reason });
      }),
  );

  server.registerTool(
    "decision.record",
    {
      title: "Record a decision",
      description: "A choice on this job a later reader would want the reasoning for.",
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
        const { stores, clock } = environment;
        const checkpoints = await stores.checkpoints.listByRun(identity.scope);
        const latest = checkpoints.items.at(-1);
        if (latest === undefined) {
          throw new ToolRefusal("not_found", "this run has no checkpoint to record against");
        }
        const decisionId = deps.ids.next("dec");
        await stores.decisions.put({
          schemaVersion: 1,
          ...identity.scope,
          decisionId,
          // On its own node, not the run's root: this is the worker's decision.
          executionNodeId: identity.executionNodeId,
          agentId: identity.agentId,
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
          affectedNodes: [],
          authority: "agent",
          supersedesDecisionId: null,
          createdAt: nowIso(clock),
        });
        environment.outbox.emit({
          type: "decision.recorded",
          source: "mcp",
          payload: { decisionId, choice: input.choice },
          executionNodeId: identity.executionNodeId,
          agentId: identity.agentId,
        });
        return ok(`Recorded decision ${decisionId}.`, { decisionId });
      }),
  );
};
