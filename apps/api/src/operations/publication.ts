/**
 * Publication intents (P10, D-P10-22): the engine asks for the program branch
 * to move; the publisher Lambda (T4) does the moving. The intent is recorded
 * on the dispatch, one per head, and `enforce` has held the engine to its
 * generation.
 */
import { PublicationIntentBodySchema, StrandPublicationBodySchema } from "@nightshift/contracts";
import {
  isOwnStrandBranch,
  nowIso,
  rearmPublication,
  recordIntent,
  recordStrandPublication,
} from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import { runScopeFrom } from "../params.js";
import type { Handler } from "../router.js";
import { requireDispatch } from "./dispatch.js";

export const requestPublication: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const body = parseBody(PublicationIntentBodySchema, request.body);
  const dispatch = await requireDispatch(deps, scope);
  if (dispatch.status !== "running" && dispatch.status !== "ready") {
    throw new HttpError(
      409,
      "dispatch_not_live",
      `the dispatch is ${dispatch.status}; only a live machine publishes`,
    );
  }
  const { dispatch: next, created } = recordIntent(dispatch, body, nowIso(deps.clock));
  if (created) {
    await deps.stores.dispatches.put(next);
    // The publisher resolves what was recorded; a failed invocation leaves the
    // intent pending for the reconciler to hand over again (T6).
    await deps.dispatcher?.publish?.(scope).catch((error: unknown) => {
      console.error(`publication ${scope.runId}: the publisher could not be invoked`, error);
    });
  }
  const intent = next.publication.intents.find((candidate) => candidate.head === body.head);
  return { status: created ? 201 : 200, body: intent };
};

/**
 * `POST …/publication/strands` — a strand's branch moved on the machine (A-60):
 * the newest head is recorded for its branch and the publisher pushes it. Only
 * the run's own `nightshift/<run>/…` branches, and only from a live machine.
 */
export const publishStrand: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const body = parseBody(StrandPublicationBodySchema, request.body);
  if (!isOwnStrandBranch(scope.runId, body.branch)) {
    throw new HttpError(
      400,
      "validation_failed",
      `a run publishes only its own strands' branches, nightshift/${scope.runId}/<node>; not ${body.branch}`,
    );
  }
  const dispatch = await requireDispatch(deps, scope);
  if (dispatch.status !== "running" && dispatch.status !== "ready") {
    throw new HttpError(
      409,
      "dispatch_not_live",
      `the dispatch is ${dispatch.status}; only a live machine publishes`,
    );
  }
  const { dispatch: next, created } = recordStrandPublication(dispatch, body, nowIso(deps.clock));
  if (created) {
    await deps.stores.dispatches.put(next);
    await deps.dispatcher?.publish?.(scope).catch((error: unknown) => {
      console.error(`publication ${scope.runId}: the publisher could not be invoked`, error);
    });
  }
  const strand = next.publication.strands?.find((candidate) => candidate.branch === body.branch);
  return { status: created ? 201 : 200, body: strand };
};

/**
 * `POST …/publication/retry` — a human fixed what blocked publication (granted
 * the App a permission, lifted a rule, reconciled the branch): every
 * unpublished intent goes back to pending, in order, and the publisher pushes
 * them from their bundles. Any dispatch status: the machine need not exist.
 * Answers the publication as it stands once the publisher has been asked.
 */
export const retryPublication: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const dispatch = await requireDispatch(deps, scope);
  const { dispatch: next, rearmed } = rearmPublication(dispatch, nowIso(deps.clock));
  if (next !== dispatch) await deps.stores.dispatches.put(next);
  if (rearmed > 0) {
    await deps.dispatcher?.publish?.(scope).catch((error: unknown) => {
      console.error(`publication ${scope.runId}: the publisher could not be invoked`, error);
    });
  }
  const after = (await deps.stores.dispatches.get(scope)) ?? next;
  return { status: 200, body: { rearmed, publication: after.publication } };
};

export const listPublication: Handler = async ({ deps, params }) => ({
  status: 200,
  body: (await requireDispatch(deps, runScopeFrom(params))).publication,
});
