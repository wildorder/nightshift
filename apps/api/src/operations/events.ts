/**
 * Events and current run state.
 */
import { AppendEventBodySchema, EventSchema } from "@nightshift/contracts";
import { highestSequence, nowIso, pendingCount } from "@nightshift/core";
import { HttpError, parseBody } from "../http.js";
import {
  assertChainMatches,
  parseAfterSequence,
  parsePageQuery,
  parseQueryNodeId,
  runScopeFrom,
} from "../params.js";
import type { Handler } from "../router.js";
import { pageAt, pageBody, readAll, requireRun, withCursor } from "./common.js";

export const appendEvent: Handler = async ({ deps, request, params }) => {
  const body = parseBody(AppendEventBodySchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, body);
  await requireRun(deps.stores, scope);

  // The control plane owns both fields: `recordedAt` from its clock, and
  // `sequence` from the store, which may leave it null until numbered (A-22).
  const event = EventSchema.parse({ ...body, sequence: null, recordedAt: nowIso(deps.clock) });
  const result = await deps.stores.events.append(event);
  return { status: result.stored ? 201 : 200, body: result };
};

export const listEvents: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const page = parsePageQuery(request.query);
  const afterSequence = parseAfterSequence(request.query);
  const node = request.query.node;
  const type = request.query.type;
  await requireRun(deps.stores, scope);

  // One node's events, by type when named (2026-10-22): the same reading
  // permission as the run's, about less of it.
  if (node !== undefined && node !== "") {
    if (afterSequence !== undefined) {
      throw new HttpError(400, "invalid_query", "node and afterSequence cannot be combined");
    }
    const nodeId = parseQueryNodeId(node);
    const options = type === undefined || type === "" ? page : { ...page, type };
    const result = await withCursor(() => deps.stores.events.listByNode(scope, nodeId, options));
    return { status: 200, body: pageBody(result) };
  }
  const options = afterSequence === undefined ? page : { ...page, afterSequence };
  const result = await withCursor(() => deps.stores.events.listByRun(scope, options));
  return { status: 200, body: pageBody(result) };
};

/**
 * The run, all its nodes, and how far event numbering has got.
 *
 * Cost: this reads every node and every event in the run on each call. That is
 * fine at P2's scale and for rebuilding state from records alone (SC-P2-10), but
 * it is O(events) per request; a realtime surface (P11) should keep a cursor
 * instead of polling this.
 */
export const getRunState: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const run = await requireRun(deps.stores, scope);
  const nodes = await readAll((cursor) =>
    deps.stores.executionNodes.listByRun(scope, pageAt(cursor)),
  );
  const events = await readAll((cursor) => deps.stores.events.listByRun(scope, pageAt(cursor)));

  return {
    status: 200,
    body: {
      run,
      nodes,
      highestSequence: highestSequence(events) ?? null,
      pendingEvents: pendingCount(events),
    },
  };
};
