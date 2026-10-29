/**
 * Starting a run of the project's line program (Pipkin): a pending remote run
 * of the program the plane made for the line, then the same admission and store
 * the dispatch route makes (`admitDispatch`), so a line run meets every ceiling
 * any run does, and the line's own two besides.
 */
import {
  defaultOrgConfig,
  type ExecutionNode,
  type LineWaitingReason,
  LineWaitingReasonSchema,
  type ProgramContract,
  type ProjectId,
  type Run,
  type RunId,
} from "@nightshift/contracts";
import {
  createUlidIdGenerator,
  ensureLineProgram,
  nowIso,
  ProgramRunLiveError,
  requireEffectivePolicy,
} from "@nightshift/core";
import { type ApiDeps, HttpError } from "../http.js";
import { admitDispatch, lineBaseSha } from "../operations/dispatch.js";

export type StartLineRunResult =
  | { readonly kind: "started"; readonly runId: RunId }
  | { readonly kind: "live"; readonly runId?: RunId }
  | { readonly kind: "waiting"; readonly reason: LineWaitingReason; readonly detail: string };

/** The plan hash a line dispatch carries: it has none, and the record needs a value. */
const LINE_PLAN_HASH = "line";

/** A placeholder base for when GitHub cannot say; the admission refuses it with the real reason. */
const UNKNOWN_BASE = "0".repeat(40);

export const startLineRun = async (
  deps: ApiDeps,
  input: {
    readonly projectId: ProjectId;
    readonly branch: string;
    readonly naming: ProgramContract;
  },
): Promise<StartLineRunResult> => {
  const { stores, clock } = deps;
  const project = await stores.projects.get(input.projectId);
  if (project === undefined) throw new Error(`project ${input.projectId} does not exist`);
  const at = nowIso(clock);
  const program = await ensureLineProgram(stores, {
    projectId: input.projectId,
    naming: input.naming,
    createdAt: at,
  });
  const ids = deps.ids ?? createUlidIdGenerator(clock);
  const runId = ids.next("run");
  const rootNodeId = ids.next("node");
  const scope = { projectId: program.projectId, programId: program.programId, runId };
  const orgConfig =
    (await stores.orgConfigs.get(project.orgId)) ?? defaultOrgConfig(project.orgId, at);
  const run: Run = {
    schemaVersion: 1,
    ...scope,
    status: "pending",
    location: "remote",
    rootNodeId,
    startedAt: at,
    policy: requireEffectivePolicy(orgConfig, program),
  };
  try {
    // The one-live-run guard answers before anything is written.
    await stores.runs.put(run);
  } catch (error) {
    if (error instanceof ProgramRunLiveError) {
      return { kind: "live", runId: error.liveRunId as RunId };
    }
    throw error;
  }
  const rootNode: ExecutionNode = {
    schemaVersion: 1,
    ...scope,
    executionNodeId: rootNodeId,
    kind: "program",
    parentNodeId: null,
    depth: 0,
    status: "validated",
    jobContractId: null,
    commitSha: null,
    createdAt: at,
    updatedAt: at,
  };
  await stores.executionNodes.put(rootNode);

  const baseSha = (await lineBaseSha(deps, project, program)) ?? UNKNOWN_BASE;
  try {
    // A refusal has already ended the pending run and, for the line's own
    // ceilings and the org's concurrency, recorded what the line waits for.
    await admitDispatch(deps, scope, {
      tier: program.compute?.tier ?? "good",
      idempotencyKey: runId,
      input: {
        repositoryUrl: program.repository.url,
        branch: program.repository.programBranch,
        baseSha,
        planHash: LINE_PLAN_HASH,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      const reason = LineWaitingReasonSchema.safeParse(
        error.code === "concurrency_over_ceiling" ? "org_concurrency" : error.code,
      );
      if (reason.success) return { kind: "waiting", reason: reason.data, detail: error.message };
    }
    throw error;
  }
  return { kind: "started", runId };
};
