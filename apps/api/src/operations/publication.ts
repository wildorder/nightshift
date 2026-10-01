/**
 * Publication intents (P10, D-P10-22): the engine asks for the program branch
 * to move; the publisher Lambda (T4) does the moving. The intent is recorded
 * on the dispatch, one per head, and `enforce` has held the engine to its
 * generation.
 */
import { PublicationIntentBodySchema } from "@nightshift/contracts";
import { nowIso, recordIntent } from "@nightshift/core";
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
  if (created) await deps.stores.dispatches.put(next);
  const intent = next.publication.intents.find((candidate) => candidate.head === body.head);
  return { status: created ? 201 : 200, body: intent };
};

export const listPublication: Handler = async ({ deps, params }) => ({
  status: 200,
  body: (await requireDispatch(deps, runScopeFrom(params))).publication,
});
