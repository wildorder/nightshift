/**
 * Agents: create, transition, read, list by node (T2).
 *
 * The execution identity (A-04). The record exists as `created` before a harness
 * process starts, then moves through the agent table in `core`:
 * `created → started → completed | failed | cancelled | interrupted`.
 *
 * Everything about an agent but its status and its timing is immutable. The
 * harness, provider and model are what routing chose, and rewriting them would
 * make the `RoutingDecision` beside it a lie.
 */
import { type Agent, AgentSchema, MintExecutionTokenResponseSchema } from "@nightshift/contracts";
import {
  agentEventFor,
  explainAgentEnding,
  explainAgentUpdate,
  IllegalTransitionError,
  transitionAgent,
} from "@nightshift/core";
import { HttpError, parseBody, sameRecord } from "../http.js";
import {
  assertChainMatches,
  assertIdentifierMatches,
  parsePageQuery,
  pathId,
  runScopeFrom,
} from "../params.js";
import type { Handler } from "../router.js";
import {
  ExecutionTokenChainError,
  ExecutionTokenStateError,
  type MintedExecutionToken,
  mintExecutionToken,
} from "../tokens/mint.js";
import { pageBody, requireProgram, requireRun, withCursor } from "./common.js";

/** An incomplete record is 422: well formed, but not something that can be stored. */
const assertComplete = (agent: Agent): void => {
  const reasons = explainAgentEnding(agent);
  if (reasons.length > 0) {
    throw new HttpError(422, "incomplete_record", reasons.join("; "));
  }
};

/**
 * Checks, in the order a caller most needs to hear about them.
 *
 * The transition comes **first**. Reverting a `started` agent to `created` is
 * both an illegal transition and a dropped `startedAt`, and answering
 * `conflict: startedAt cannot change` would name the symptom rather than the
 * mistake. The state machine is the primary contract, so it speaks first.
 */
const applyUpdate = (existing: Agent, next: Agent): void => {
  const statusMoved = existing.status !== next.status;
  const event = statusMoved ? agentEventFor(existing.status, next.status) : undefined;
  if (statusMoved && event === undefined) {
    throw new IllegalTransitionError(existing.status, `transition to ${next.status}`);
  }

  const immutable = explainAgentUpdate(existing, next);
  if (immutable.length > 0) throw new HttpError(409, "conflict", immutable.join("; "));
  assertComplete(next);

  if (event === undefined) {
    // Status is the only thing that moves. Anything else differing is a conflict
    // rather than a silent overwrite of a record someone else wrote.
    throw new HttpError(
      409,
      "conflict",
      "an agent's status is the only field that changes; this request changes something else",
    );
  }
  // Applied for its refusals: the table, and the rule that no agent ends in
  // silence. The submitted record is what gets stored, as with execution nodes.
  transitionAgent(existing, event, {
    at: next.endedAt ?? next.startedAt ?? existing.createdAt,
    ...(next.outcomeReason === undefined ? {} : { outcomeReason: next.outcomeReason }),
    ...(next.exitCode === undefined ? {} : { exitCode: next.exitCode }),
  });
};

export const putAgent: Handler = async ({ deps, request, params }) => {
  const agent = parseBody(AgentSchema, request.body);
  const scope = runScopeFrom(params);
  assertChainMatches(scope, agent);
  assertIdentifierMatches("agentId", pathId("agent", params, "agentId"), agent.agentId);
  await requireRun(deps.stores, scope);

  const node = await deps.stores.executionNodes.get(scope, agent.executionNodeId);
  if (node === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `execution node ${agent.executionNodeId} does not exist in this run`,
    );
  }

  const existing = await deps.stores.agents.get(scope, agent.agentId);
  if (existing === undefined) {
    assertComplete(agent);
    await deps.stores.agents.put(agent);
    return { status: 201, body: agent };
  }
  if (sameRecord(existing, agent)) return { status: 200, body: existing };
  applyUpdate(existing, agent);
  await deps.stores.agents.put(agent);
  return { status: 200, body: agent };
};

export const getAgent: Handler = async ({ deps, params }) => {
  const scope = runScopeFrom(params);
  const agentId = pathId("agent", params, "agentId");
  const agent = await deps.stores.agents.get(scope, agentId);
  if (agent === undefined) {
    throw new HttpError(404, "not_found", `agent ${agentId} does not exist in this run`);
  }
  return { status: 200, body: agent };
};

export const listAgentsByNode: Handler = async ({ deps, request, params }) => {
  const scope = runScopeFrom(params);
  const nodeId = pathId("node", params, "nodeId");
  // Parsed for its refusals: an unusable `limit` is a 400 here as everywhere,
  // even though the port returns every agent of a node in one go.
  parsePageQuery(request.query);
  await requireRun(deps.stores, scope);
  const items = await withCursor(() => deps.stores.agents.listByNode(scope, nodeId));
  return { status: 200, body: pageBody({ items }) };
};

/**
 * `POST …/runs/{runId}/agents/{agentId}/token` — mint an execution token
 * (T2 deliverable 4, D-P4-03).
 *
 * A user principal whose org owns the project may call it; T3's `enforce` is
 * where that is decided, and `agent.mintToken` is forbidden to every execution
 * principal, so a token cannot mint a token.
 *
 * The response is the only place a token ever appears. Nothing stores it, so
 * there is no idempotency to offer: a second call mints a second token, and
 * both are valid until they expire. That is a deliberate property, not a gap —
 * an idempotent mint would need somewhere to remember what it had issued.
 */
export const mintAgentToken: Handler = async ({ deps, params, request: _request }) => {
  const scope = runScopeFrom(params);
  const agentId = pathId("agent", params, "agentId");

  const issuing = deps.tokens;
  if (issuing === undefined) {
    throw new HttpError(
      501,
      "tokens_unavailable",
      "this control plane has no execution-token signer configured",
    );
  }

  const run = await requireRun(deps.stores, scope);
  const agent = await deps.stores.agents.get(scope, agentId);
  if (agent === undefined) {
    throw new HttpError(404, "not_found", `agent ${agentId} does not exist in this run`);
  }
  const node = await deps.stores.executionNodes.get(scope, agent.executionNodeId);
  if (node === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `execution node ${agent.executionNodeId} does not exist in this run`,
    );
  }
  const program = await requireProgram(deps.stores, scope);

  let minted: MintedExecutionToken;
  try {
    minted = await mintExecutionToken(issuing.signer, {
      agent,
      node,
      run,
      program,
      issuer: issuing.issuer,
      now: deps.clock.now(),
    });
  } catch (error) {
    if (error instanceof ExecutionTokenStateError) {
      throw new HttpError(409, "conflict", error.message);
    }
    if (error instanceof ExecutionTokenChainError) {
      throw new HttpError(422, "incomplete_record", error.message);
    }
    throw error;
  }

  return {
    status: 201,
    body: MintExecutionTokenResponseSchema.parse({
      token: minted.token,
      agentId: agent.agentId,
      expiresAt: minted.expiresAt,
    }),
  };
};
