/**
 * The project line's routes (Pipkin M1b): what the engine of the line's run (a
 * run of the line program) and humans use. Everything is keyed by (project,
 * branch); the branch is one URL-encoded path segment, which the router has
 * decoded.
 *
 * The rules are `core`'s (`rules/line.ts`) and return refusals as values; this
 * file only maps each to a status and applies the result inside the store's
 * compare-and-swap `update`. The line run's heartbeat is a run's own
 * (`dispatch.ts`).
 */
import {
  calendarMonthOf,
  EventSchema,
  type EventType,
  inlinePayloadBytes,
  LineBundleUploadUrlBodySchema,
  type LineComposedPayload,
  type LineParkedPayload,
  LinePushBodySchema,
  type LineRecord,
  type LineSettleBody,
  LineSettleBodySchema,
  type LineView,
  LineViewSchema,
  MAX_INLINE_PAYLOAD_BYTES,
  type Principal,
  type ProjectId,
  summariseLineVerification,
  TakeLineBatchBodySchema,
} from "@nightshift/contracts";
import {
  createUlidIdGenerator,
  LINE_RESOLVER_ATTEMPTS,
  type LineChange,
  type LineOwnerArg,
  type LineRefusal,
  lineBundleObjectKey,
  lineProgramId,
  nowIso,
  type RunScope,
  requestPush,
  requireEffectivePolicy,
  settleBatch,
  takeBatch,
} from "@nightshift/core";
import { type ApiDeps, HttpError, parseBody } from "../http.js";
import { projectIdFrom } from "../params.js";
import type { Handler, RouteContext } from "../router.js";
import { pageAt, readAll, requireProject } from "./common.js";

interface LineTarget {
  readonly projectId: ProjectId;
  readonly branch: string;
}

const targetOf = (params: RouteContext["params"]): LineTarget => {
  const branch = params.branch;
  if (branch === undefined || branch === "") {
    throw new HttpError(
      400,
      "invalid_query",
      "the line's branch is missing: name it as `?branch=`",
    );
  }
  return { projectId: projectIdFrom(params), branch };
};

const requireLine = async (deps: ApiDeps, target: LineTarget): Promise<LineRecord> => {
  const record = await deps.stores.lines.get(target.projectId, target.branch);
  if (record === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `project ${target.projectId} has no line on ${target.branch}`,
    );
  }
  return record;
};

/** Humans read the line; every line write is the line run's engine's. */
const refuseUser = (principal: Principal, what: string): void => {
  if (principal.kind === "user") {
    throw new HttpError(403, "execution_forbidden_operation", `a user may not ${what}`);
  }
};

/**
 * The owner a line write acts as: the line run's engine, fenced on its own
 * run's dispatch (and on the generation the body claims, where it names one).
 * The batch is held as (runId, generation).
 */
const ownerOf = async (
  { deps, principal }: Pick<RouteContext, "deps" | "principal">,
  claimed: number | undefined,
): Promise<LineOwnerArg> => {
  if (principal.kind !== "execution") {
    throw new HttpError(
      403,
      "execution_forbidden_operation",
      "only the line run's engine may write to the line",
    );
  }
  const dispatch = await deps.stores.dispatches.get({
    projectId: principal.projectId,
    programId: principal.programId,
    runId: principal.runId,
  });
  if (
    dispatch === undefined ||
    dispatch.generation !== principal.generation ||
    (claimed !== undefined && claimed !== dispatch.generation)
  ) {
    throw new HttpError(
      409,
      "stale_generation",
      `this call is from generation ${String(claimed ?? principal.generation)}; the run's dispatch is at ${String(dispatch?.generation)}`,
    );
  }
  return { runId: principal.runId, generation: dispatch.generation };
};

const refusalStatus = (refusal: LineRefusal): HttpError =>
  new HttpError(
    409,
    refusal.reason === "stale_batch" ||
      refusal.reason === "resolver_attempts" ||
      refusal.reason === "stale_generation"
      ? refusal.reason
      : "conflict",
    refusal.detail,
  );

/**
 * Applies a rule that may refuse to the line record. A refusal changes
 * nothing; the last call of `change` (the one that won, if the store retried)
 * decides the answer.
 */
const applyLineChange = async (
  deps: ApiDeps,
  target: LineTarget,
  rule: (record: LineRecord) => LineChange,
): Promise<LineRecord> => {
  let outcome: LineChange | undefined;
  const stored = await deps.stores.lines.update(target.projectId, target.branch, (current) => {
    if (current === undefined) {
      outcome = undefined;
      return undefined;
    }
    outcome = rule(current);
    return outcome.ok ? outcome.record : undefined;
  });
  if (stored === undefined || outcome === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `project ${target.projectId} has no line on ${target.branch}`,
    );
  }
  if (!outcome.ok) throw refusalStatus(outcome);
  return stored;
};

const fedProgramsOf = (record: LineRecord) => [
  ...new Set([
    ...record.queue.map((entry) => entry.program),
    ...(record.batch?.entries ?? []).map((entry) => entry.program),
  ]),
];

/** `GET …/line?branch=`. */
export const getLine: Handler = async ({ deps, params }) => {
  const target = targetOf(params);
  const record = await requireLine(deps, target);
  const programId = lineProgramId(target.projectId, target.branch);
  const runs = await readAll((cursor) =>
    deps.stores.runs.listByProgram({ projectId: target.projectId, programId }, pageAt(cursor)),
  );
  const latest = runs.reduce<(typeof runs)[number] | undefined>(
    (best, run) => (best === undefined || run.runId > best.runId ? run : best),
    undefined,
  );
  const dispatch =
    latest === undefined
      ? undefined
      : await deps.stores.dispatches.get({
          projectId: target.projectId,
          programId,
          runId: latest.runId,
        });
  const month = calendarMonthOf(nowIso(deps.clock));
  const usage = await deps.stores.projectSelfStartedUsage.get(target.projectId, month);
  const programs: LineView["programs"] = [];
  for (const program of fedProgramsOf(record)) {
    const contract = await deps.stores.programContracts.get(target.projectId, program);
    if (contract !== undefined) {
      programs.push({ program, branch: contract.repository.programBranch });
    }
  }
  // The org's policy as a run's snapshot is computed (`requireEffectivePolicy`,
  // start-run.ts), at org level: it takes one program's narrowing, and the line
  // is fed by several, so the view shows what the org allows before any program
  // narrows it. Omitted while the org has no config.
  const project = await requireProject(deps.stores, target.projectId);
  const orgConfig = await deps.stores.orgConfigs.get(project.orgId);
  const policy =
    orgConfig === undefined
      ? undefined
      : requireEffectivePolicy(orgConfig, {
          examinationPolicy: orgConfig.examinationPolicy,
        });
  const view: LineView = {
    record,
    programId,
    ...(latest === undefined ? {} : { runId: latest.runId }),
    ...(dispatch === undefined
      ? {}
      : {
          dispatchStatus: dispatch.status,
          generation: dispatch.generation,
          meteredUsd: dispatch.spend.meteredUsd,
        }),
    ...(usage === undefined ? {} : { usage }),
    ...(policy === undefined ? {} : { policy }),
    programs,
  };
  return { status: 200, body: LineViewSchema.parse(view) };
};

/** `POST …/line/batch?branch=` — the whole queue as one batch, or none. */
export const takeLineBatch: Handler = async (context) => {
  const { deps, request, params } = context;
  const target = targetOf(params);
  const body = parseBody(TakeLineBatchBodySchema, request.body);
  const owner = await ownerOf(context, body.generation);
  const at = nowIso(deps.clock);
  const ids = deps.ids ?? createUlidIdGenerator(deps.clock);
  let taken: ReturnType<typeof takeBatch> | undefined;
  const stored = await deps.stores.lines.update(target.projectId, target.branch, (current) => {
    if (current === undefined) return undefined;
    taken = takeBatch(current, owner, { batchId: ids.next("comp") }, at);
    return taken.record === current ? undefined : taken.record;
  });
  if (stored === undefined || taken === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `project ${target.projectId} has no line on ${target.branch}`,
    );
  }
  // The record holds the batch just taken, or the one already held.
  return {
    status: 200,
    body: stored.batch === undefined ? {} : { batch: stored.batch },
  };
};

/**
 * The resolver's attempts above the limit are a refusal of the line (409), not
 * a malformed body: read off the raw body before the schema, which caps them too.
 */
const refuseResolverOver = (body: unknown): void => {
  const resolver = (body as { resolver?: { attempts?: unknown } } | null | undefined)?.resolver;
  if (typeof resolver?.attempts === "number" && resolver.attempts > LINE_RESOLVER_ATTEMPTS) {
    throw new HttpError(
      409,
      "resolver_attempts",
      `the resolver reports ${resolver.attempts} attempts; at most ${LINE_RESOLVER_ATTEMPTS} are allowed`,
    );
  }
};

/** Ask the publisher for a pending push; recorded first, then published, so an error is only logged. */
const askPublisher = async (deps: ApiDeps, target: LineTarget): Promise<void> => {
  await deps.dispatcher?.publishLine?.(target).catch((error: unknown) => {
    // Recorded first, then published: a push left pending is found by the reconciler.
    console.error(
      `line ${target.projectId} ${target.branch}: the publisher could not be invoked`,
      error,
    );
  });
};

/**
 * The settled entries as events of the run that held the batch: the run's own
 * history, beyond what the line record's window keeps. The record write has
 * already happened, so a failed append is logged, never thrown. An entry whose
 * payload would not fit inline keeps everything but its verification's command
 * results, which a summary replaces.
 */
const appendSettledEvents = async (
  deps: ApiDeps,
  principal: Extract<Principal, { kind: "execution" }>,
  record: LineRecord,
  settled: readonly string[],
  at: string,
): Promise<void> => {
  const scope: RunScope = {
    projectId: principal.projectId,
    programId: principal.programId,
    runId: principal.runId,
  };
  try {
    const nodes = await deps.stores.executionNodes.listByRun(scope);
    const executionNodeId =
      nodes.items.find((n) => n.parentNodeId === null)?.executionNodeId ?? null;
    const ids = deps.ids ?? createUlidIdGenerator(deps.clock);
    const entries: {
      type: EventType;
      id: string;
      payload: Record<string, unknown>;
    }[] = [];
    for (const composition of record.compositions) {
      if (!settled.includes(composition.compositionId)) continue;
      const payload: LineComposedPayload = composition;
      entries.push({
        type: "line.composed",
        id: composition.compositionId,
        payload,
      });
    }
    for (const parked of record.parked) {
      if (!settled.includes(parked.compositionId)) continue;
      const payload: LineParkedPayload = parked;
      entries.push({ type: "line.parked", id: parked.compositionId, payload });
    }
    for (const entry of entries) {
      let payload = entry.payload;
      if (inlinePayloadBytes(payload) > MAX_INLINE_PAYLOAD_BYTES) {
        const verification = payload.verification as
          | Parameters<typeof summariseLineVerification>[0]
          | undefined;
        if (verification !== undefined && "commands" in verification) {
          payload = {
            ...payload,
            verification: summariseLineVerification(verification),
          };
        }
      }
      try {
        await deps.stores.events.append(
          EventSchema.parse({
            schemaVersion: 1,
            ...scope,
            eventId: ids.next("evt"),
            idempotencyKey: `${entry.type}:${entry.id}`,
            sequence: null,
            type: entry.type,
            source: "control-plane",
            executionNodeId,
            agentId: null,
            payload,
            occurredAt: at,
            recordedAt: at,
          }),
        );
      } catch (error) {
        console.error(
          `line ${scope.runId}: could not append ${entry.type} for ${entry.id} (the settle stands)`,
          error,
        );
      }
    }
  } catch (error) {
    console.error(`line ${scope.runId}: could not append the settled entries' events`, error);
  }
};

/** `POST …/line/settle?branch=` — the batch settled with a composition and/or parked entries. */
export const postLineSettle: Handler = async (context) => {
  const { deps, request, params } = context;
  const target = targetOf(params);
  refuseUser(context.principal, "write to the line");
  const raw = request.body as { composition?: unknown; parked?: unknown } | null | undefined;
  refuseResolverOver(raw?.composition);
  if (Array.isArray(raw?.parked)) for (const entry of raw.parked) refuseResolverOver(entry);
  const body: LineSettleBody = parseBody(LineSettleBodySchema, request.body);
  const at = nowIso(deps.clock);
  const ids = deps.ids ?? createUlidIdGenerator(deps.clock);
  const compositionId = body.composition === undefined ? undefined : ids.next("comp");
  const parkedIds = body.parked.map(() => ids.next("comp"));
  const owner = await ownerOf(context, undefined);
  const record = await applyLineChange(deps, target, (current) =>
    settleBatch(
      current,
      body,
      { ...(compositionId === undefined ? {} : { compositionId }), parkedIds },
      owner,
      at,
    ),
  );
  if (context.principal.kind === "execution") {
    await appendSettledEvents(
      deps,
      context.principal,
      record,
      [...(compositionId === undefined ? [] : [compositionId]), ...parkedIds],
      at,
    );
  }
  if (
    body.push !== undefined &&
    record.push?.head === body.push.head &&
    record.push.status === "pending"
  )
    await askPublisher(deps, target);
  return { status: 200, body: record };
};

/** `POST …/line/push?branch=` — recorded pending, then the publisher is asked. */
export const postLinePush: Handler = async (context) => {
  const { deps, request, params } = context;
  const target = targetOf(params);
  refuseUser(context.principal, "write to the line");
  const body = parseBody(LinePushBodySchema, request.body);
  const owner = await ownerOf(context, undefined);
  const at = nowIso(deps.clock);
  const record = await applyLineChange(deps, target, (current) =>
    requestPush(current, body, owner, at),
  );
  await askPublisher(deps, target);
  return { status: 200, body: record };
};

/** An id that is one safe segment of the object key. */
const BUNDLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `POST …/line/bundle-upload-url?branch=` — a presigned PUT for one bundle. */
export const createLineBundleUploadUrl: Handler = async (context) => {
  const { deps, request, params } = context;
  const target = targetOf(params);
  refuseUser(context.principal, "write to the line");
  const body = parseBody(LineBundleUploadUrlBodySchema, request.body);
  if (!BUNDLE_ID.test(body.id)) {
    throw new HttpError(400, "validation_failed", "id must be 1-64 letters, digits, - or _");
  }
  await ownerOf(context, body.generation);
  const signKey = deps.uploads?.signKey?.bind(deps.uploads);
  if (signKey === undefined) {
    throw new HttpError(
      501,
      "uploads_unavailable",
      "this control plane was wired without an upload signer for line bundles",
    );
  }
  const key = lineBundleObjectKey(target.projectId, target.branch, body.generation, body.id);
  const signed = await signKey(key, "application/octet-stream");
  return {
    status: 200,
    body: {
      uri: signed.uri,
      uploadUrl: signed.uploadUrl,
      key: signed.key,
      contentType: signed.contentType,
      expiresAt: signed.expiresAt,
    },
  };
};
