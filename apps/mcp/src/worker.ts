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
import {
  createWorkerTools,
  type WorkerEnvironment,
  type WorkerIdentity,
} from "@nightshift/execution";
import { NoCheckpointError } from "@nightshift/harness";
import { z } from "zod";
import { guarded, ok, ToolRefusal } from "./results.js";

export interface WorkerDeps {
  readonly identity: WorkerIdentity;
  readonly environment: WorkerEnvironment;
  readonly ids: IdGenerator;
}

export const registerWorkerTools = (server: McpServer, deps: WorkerDeps): void => {
  const { identity, environment } = deps;
  // The one implementation of the four operations (A-37). This role is the stdio
  // transport for it and adds nothing but the words a model reads back.
  const tools = createWorkerTools(environment, identity, deps.ids);

  server.registerTool(
    "job.get",
    {
      title: "Read your job",
      description:
        "Your objective, your acceptance criteria and your worktree. " +
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
            `Working directory: ${identity.worktree}\n` +
            "Finish with job.complete, or job.fail if you are stuck. Do not commit.",
          {
            jobContractId: job.jobContractId,
            objective: job.objective,
            acceptance: job.acceptance,
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
        await tools.progress(message, percent);
        return ok("Noted.", { message });
      }),
  );

  server.registerTool(
    "job.complete",
    {
      title: "Report the job complete",
      description:
        "Nightshift snapshots your worktree into one commit it authors and records the result. " +
        "Do not commit anything yourself.",
      inputSchema: { summary: z.string().min(1) },
    },
    async ({ summary }) =>
      guarded(async () => {
        const result = await tools.complete(summary);
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
        "take an action the program forbids. A clear reason is worth far more than a guess.",
      inputSchema: { reason: z.string().min(1) },
    },
    async ({ reason }) =>
      guarded(async () => {
        await tools.fail(reason);
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
        const { decisionId } = await tools.recordDecision(input).catch((error: unknown) => {
          if (error instanceof NoCheckpointError) throw new ToolRefusal("not_found", error.message);
          throw error;
        });
        return ok(`Recorded decision ${decisionId}.`, { decisionId });
      }),
  );
};
