/**
 * A person's explicit grouping of runs that delivered one outcome (P20, D-05).
 *
 * Membership is named by the person and checked here against the path's project
 * alone: a reference to a run that is not in this project is refused, never
 * looked up elsewhere. Checkpoint snapshots are rebuilt by core from the verdicts
 * the server holds.
 */
import { CompletionHistorySchema, type Run, type RunFeedback } from "@nightshift/contracts";
import {
  CompletionMembershipError,
  gatherMemberFigures,
  nowIso,
  reconcileCompletionWrite,
} from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import {
  assertChainMatches,
  assertIdentifierMatches,
  parsePageQuery,
  pathId,
  projectIdFrom,
  runScopeFrom,
} from "../params.js";
import type { Handler } from "../router.js";
import { pageBody, requireProject, requireRun, withCursor } from "./common.js";
import { requireUser } from "./feedback.js";

export const getCompletionHistory: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const id = pathId("comp", params, "completionHistoryId");
  const history = await deps.stores.completionHistories.get(scope, id);
  if (history === undefined) {
    throw new HttpError(404, "not_found", `completion history ${id} does not exist for this run`);
  }
  return { status: 200, body: history };
};

export const listCompletionHistoriesByRun: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  await requireRun(deps.stores, scope);
  return {
    status: 200,
    body: { items: await deps.stores.completionHistories.listByRun(scope) },
  };
};

export const listCompletionHistoriesByProject: Handler = async ({ deps, request, params }) => {
  const projectId = projectIdFrom(params);
  const page = parsePageQuery(request.query);
  await requireProject(deps.stores, projectId);
  const result = await withCursor(() =>
    deps.stores.completionHistories.listByProject(projectId, page),
  );
  return { status: 200, body: pageBody(result) };
};

export const putCompletionHistory: Handler = async ({ deps, request, params, principal }) => {
  const proposed = parseBody(CompletionHistorySchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, proposed);
  const id = pathId("comp", params, "completionHistoryId");
  assertIdentifierMatches("completionHistoryId", id, proposed.completionHistoryId);
  await requireRun(deps.stores, scope);
  const actor = requireUser(principal);

  // Only this project's runs: a ref elsewhere reads as absent and is refused.
  const memberRuns = new Map<string, Run>();
  const feedbackOf = new Map<string, RunFeedback>();
  for (const ref of proposed.members) {
    const key = `${ref.programId}/${ref.runId}`;
    const member = { projectId: scope.projectId, programId: ref.programId };
    const run = await deps.stores.runs.get(member, ref.runId);
    if (run === undefined) throw new CompletionMembershipError(ref, "unknown_run");
    memberRuns.set(key, run);
    const feedback = await deps.stores.feedback.get({
      ...member,
      runId: ref.runId,
    });
    if (feedback !== undefined) feedbackOf.set(key, feedback);
  }

  const stored = await deps.stores.completionHistories.get(scope, id);
  // Measurement reads happen only when this write adds a checkpoint; the figures
  // are taken as of that checkpoint run's verdict. Nothing in the body is used.
  const storedNames = new Set((stored?.checkpoints ?? []).map((c) => c.name));
  const added = proposed.checkpoints.filter((c) => !storedNames.has(c.name));
  const verdictAt = added
    .map((c) => feedbackOf.get(`${c.programId}/${c.runId}`)?.recordedAt)
    .find((recordedAt) => recordedAt !== undefined);
  const figures =
    added.length === 0
      ? undefined
      : await gatherMemberFigures(
          deps.stores,
          scope.projectId,
          proposed.members,
          memberRuns,
          verdictAt ?? nowIso(deps.clock),
        );
  let decided: ReturnType<typeof reconcileCompletionWrite>;
  try {
    decided = reconcileCompletionWrite({
      ...(stored === undefined ? {} : { stored }),
      proposed,
      actor: { kind: "user", userId: actor.userId, orgId: actor.orgId },
      at: nowIso(deps.clock),
      memberRuns,
      feedbackOf,
      ...(figures === undefined
        ? {}
        : {
            resources: figures.resources,
            infrastructure: figures.infrastructure,
            unavailable: new Set(figures.unavailable.keys()),
          }),
    });
  } catch (error) {
    if (
      error instanceof CompletionMembershipError &&
      error.reason === "measurement_unavailable" &&
      figures !== undefined
    ) {
      const detail = [...figures.unavailable]
        .map(([member, reason]) => `${member} (${reason})`)
        .join("; ");
      throw new HttpError(
        503,
        "measurement_unavailable",
        `measurement evidence is unavailable for ${detail}; nothing was stored, retry once the stores answer`,
      );
    }
    throw error;
  }
  if (decided.outcome === "stored") {
    await deps.stores.completionHistories.put(decided.history);
    return { status: stored === undefined ? 201 : 200, body: decided.history };
  }
  return { status: 200, body: decided.history };
};
