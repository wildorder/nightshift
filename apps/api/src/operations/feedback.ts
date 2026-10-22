/**
 * A person's one-click verdict on a run (P20, D-04).
 *
 * A user's to write, and nobody else's: core's tables refuse every execution
 * role, and the write refuses a non-user again here. Everything that names who
 * said it, when, and about which commit is the server's: the body contributes the
 * verdict and the version it replaces plus one, and nothing else.
 */
import {
  type CommitSha,
  type Run,
  RunFeedbackSchema,
  type UserPrincipal,
} from "@nightshift/contracts";
import {
  isRunRateable,
  type NightshiftStores,
  nowIso,
  type RunScope,
  reconcileFeedbackWrite,
} from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import { assertChainMatches, parsePageQuery, programScopeFrom, runScopeFrom } from "../params.js";
import type { Handler } from "../router.js";
import { pageBody, requireProgram, requireRun, withCursor } from "./common.js";

/** The acting person, from the validated token alone. */
export const requireUser = (principal: { readonly kind: string }): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new HttpError(
      403,
      "execution_forbidden_operation",
      "only a person may record a verdict or a completion history",
    );
  }
  return principal as UserPrincipal;
};

/**
 * The commit the verdict is about, resolved from stored facts: the run's root
 * node's commit when it has one, else a remote dispatch's published head.
 */
const resultCommitOf = async (
  stores: NightshiftStores,
  scope: RunScope,
  run: Run,
): Promise<CommitSha | undefined> => {
  const root = await stores.executionNodes.get(scope, run.rootNodeId);
  if (root?.commitSha != null) return root.commitSha;
  const dispatch = await stores.dispatches.get(scope);
  return dispatch?.publication.head;
};

export const getFeedback: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const feedback = await deps.stores.feedback.get(scope);
  if (feedback === undefined) {
    throw new HttpError(404, "not_found", `run ${scope.runId} has no feedback`);
  }
  return { status: 200, body: feedback };
};

export const putFeedback: Handler = async ({ deps, request, params, principal }) => {
  const proposed = parseBody(RunFeedbackSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, proposed);
  const run = await requireRun(deps.stores, scope);
  const actor = requireUser(principal);
  if (!isRunRateable(run)) {
    throw new HttpError(409, "run_not_finished", `run ${scope.runId} has not ended`);
  }
  const resultCommit = await resultCommitOf(deps.stores, scope, run);
  const stored = await deps.stores.feedback.get(scope);
  const decided = reconcileFeedbackWrite({
    ...(stored === undefined ? {} : { stored }),
    proposed,
    actor: { kind: "user", userId: actor.userId, orgId: actor.orgId },
    at: nowIso(deps.clock),
    ...(resultCommit === undefined ? {} : { resultCommit }),
  });
  if (decided.outcome === "nothing_to_clear") {
    throw new HttpError(404, "not_found", `run ${scope.runId} has no verdict to clear`);
  }
  if (decided.outcome === "stored") {
    await deps.stores.feedback.put(decided.feedback);
    return { status: stored === undefined ? 201 : 200, body: decided.feedback };
  }
  return { status: 200, body: decided.feedback };
};

export const listFeedbackByProgram: Handler = async ({ deps, request, params }) => {
  const scope = programScopeFrom(params);
  const page = parsePageQuery(request.query);
  await requireProgram(deps.stores, scope);
  const result = await withCursor(() => deps.stores.feedback.listByProgram(scope, page));
  return { status: 200, body: pageBody(result) };
};
