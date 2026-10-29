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
import { createHash } from "node:crypto";
import {
  calendarMonthOf,
  EventSchema,
  type EventType,
  inlinePayloadBytes,
  LineBundleUploadUrlBodySchema,
  type LineComposition,
  type LineParked,
  LinePushBodySchema,
  type LineRecord,
  type LineSettleBody,
  LineSettleBodySchema,
  type LineSettledPayload,
  type LineView,
  LineViewSchema,
  MAX_INLINE_PAYLOAD_BYTES,
  MAX_LINE_SETTLED_ENTRIES_PER_EVENT,
  type Principal,
  type ProjectId,
  TakeLineBatchBodySchema,
} from "@nightshift/contracts";
import {
  composedEntryOf,
  createUlidIdGenerator,
  entryText,
  LINE_RESOLVER_ATTEMPTS,
  type LineChange,
  type LineOwnerArg,
  type LineRefusal,
  lineBundleObjectKey,
  lineProgramId,
  nowIso,
  parkedEntryOf,
  type RunScope,
  requestPush,
  requireEffectivePolicy,
  settleBatch,
  settledMarkers,
  settleIds,
  settlementDigest,
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

/** What a chunk event's payload may weigh, with room under the inline bound for the envelope's own fields. */
const CHUNK_PAYLOAD_BYTES = 6000;

interface PlannedEvent {
  readonly type: EventType;
  readonly key: string;
  readonly payload: Record<string, unknown>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** An idempotency key within the schema's bound: an over-long id is stood for by its hash. */
const keyOf = (...parts: readonly string[]): string => {
  const key = parts.join(":");
  return key.length <= 256
    ? key
    : [parts[0] ?? "", sha256(parts[1] ?? ""), ...parts.slice(2)].join(":");
};

/**
 * Splits `text` into ordered slices whose chunk payloads each measure under
 * `CHUNK_PAYLOAD_BYTES` by `inlinePayloadBytes` (not by string length), never
 * between the halves of a surrogate pair.
 */
const chunkText = (head: { kind: string; id: string; digest: string }, text: string): string[] => {
  const slices: string[] = [];
  let start = 0;
  while (start < text.length) {
    let size = Math.min(text.length - start, CHUNK_PAYLOAD_BYTES);
    const fits = (n: number) =>
      inlinePayloadBytes({
        ...head,
        part: 99999,
        parts: 99999,
        text: text.slice(start, start + n),
      }) <= CHUNK_PAYLOAD_BYTES;
    while (size > 1 && !fits(size)) size = Math.max(1, Math.floor(size * 0.8));
    const last = text.charCodeAt(start + size - 1);
    if (size > 1 && last >= 0xd800 && last <= 0xdbff) size -= 1;
    slices.push(text.slice(start, start + size));
    start += size;
  }
  return slices;
};

/**
 * An entry's events: one event carrying the entry with its id and digest, or,
 * when that would not fit inline, ordered chunks of its JSON text. Keys carry
 * the content digest, so a different body for the same id is a new event.
 */
const planEntry = (
  type: "line.composed" | "line.parked",
  entry: LineComposition | LineParked,
): { events: PlannedEvent[]; digest: string } => {
  const id = entry.compositionId;
  const text = entryText(entry);
  const digest = sha256(text);
  const payload = { ...JSON.parse(text), id, digest } as Record<string, unknown>;
  if (inlinePayloadBytes(payload) <= MAX_INLINE_PAYLOAD_BYTES) {
    return { events: [{ type, key: keyOf(type, id, digest), payload }], digest };
  }
  const head = { kind: type === "line.composed" ? "composed" : "parked", id, digest };
  const slices = chunkText(head, text);
  return {
    digest,
    events: slices.map((slice, part) => ({
      type: "line.entry_chunk" as const,
      key: keyOf("line.entry_chunk", id, digest, String(part)),
      payload: { ...head, part, parts: slices.length, text: slice },
    })),
  };
};

/**
 * The settlement's events on the run that held the batch, in two steps around
 * the record change. `appendEntryEvents` runs BEFORE it: content-addressed
 * (keys carry the entry's digest) and reportable only once a `line.settled`
 * marker names them, so an attempt that never commits (a failed append, a
 * refused takeover, a superseded owner) is never a fact. `appendSettledMarker`
 * runs AFTER the record committed; a failure there is a 5xx and the composer's
 * retry of the same body recovers (the record's `lastSettled`). Nothing is
 * truncated: an entry too large for one event is chunked.
 */
const appendPlanned = async (
  deps: ApiDeps,
  principal: Extract<Principal, { kind: "execution" }>,
  planned: readonly PlannedEvent[],
  at: string,
): Promise<void> => {
  const scope: RunScope = {
    projectId: principal.projectId,
    programId: principal.programId,
    runId: principal.runId,
  };
  const nodes = await deps.stores.executionNodes.listByRun(scope);
  const executionNodeId = nodes.items.find((n) => n.parentNodeId === null)?.executionNodeId ?? null;
  const ids = deps.ids ?? createUlidIdGenerator(deps.clock);
  for (const event of planned) {
    await deps.stores.events.append(
      EventSchema.parse({
        schemaVersion: 1,
        ...scope,
        eventId: ids.next("evt"),
        idempotencyKey: event.key,
        sequence: null,
        type: event.type,
        source: "control-plane",
        executionNodeId,
        agentId: null,
        payload: event.payload,
        occurredAt: at,
        recordedAt: at,
      }),
    );
  }
};

interface SettlementPlan {
  readonly events: PlannedEvent[];
  readonly marked: LineSettledPayload["entries"];
}

const planSettlement = (
  body: LineSettleBody,
  ids: ReturnType<typeof settleIds>,
  at: string,
): SettlementPlan => {
  const events: PlannedEvent[] = [];
  const marked: LineSettledPayload["entries"][number][] = [];
  const add = (type: "line.composed" | "line.parked", entry: LineComposition | LineParked) => {
    const planned = planEntry(type, entry);
    events.push(...planned.events);
    marked.push({ type, id: entry.compositionId, digest: planned.digest });
  };
  if (body.composition !== undefined) {
    add("line.composed", composedEntryOf(body.composition, ids.compositionId ?? "", at));
  }
  body.parked.forEach((entry, index) => {
    add("line.parked", parkedEntryOf(entry, ids.parkedIds[index] ?? "", at));
  });
  return { events, marked };
};

const appendSettledMarker = async (
  deps: ApiDeps,
  principal: Extract<Principal, { kind: "execution" }>,
  plan: SettlementPlan,
  settlement: { batchId: string; generation: number; digest: string },
  at: string,
): Promise<void> => {
  const markers = settledMarkers(
    { ...settlement, entries: plan.marked },
    MAX_LINE_SETTLED_ENTRIES_PER_EVENT,
  );
  await appendPlanned(
    deps,
    principal,
    markers.map((payload) => ({
      type: "line.settled" as const,
      key: keyOf(
        "line.settled",
        settlement.batchId,
        settlement.digest,
        ...(markers.length > 1 ? [String(payload.part)] : []),
      ),
      payload,
    })),
    at,
  );
};

/**
 * `POST …/line/settle?branch=` — the batch settled with a composition and/or
 * parked entries. The rule is dry-run (a refusal writes nothing), the entry
 * events are appended (not yet facts), the record is changed (the commit), and
 * only then the `line.settled` marker is appended. A settle for a batch the
 * record already shows settled with the same body is a retry of one whose
 * marker was lost: its events and marker are re-appended and it answers 200.
 */
export const postLineSettle: Handler = async (context) => {
  const { deps, request, params } = context;
  const target = targetOf(params);
  refuseUser(context.principal, "write to the line");
  const raw = request.body as { composition?: unknown; parked?: unknown } | null | undefined;
  refuseResolverOver(raw?.composition);
  if (Array.isArray(raw?.parked)) for (const entry of raw.parked) refuseResolverOver(entry);
  const body: LineSettleBody = parseBody(LineSettleBodySchema, request.body);
  const settled = settleIds(body);
  const owner = await ownerOf(context, undefined);
  const principal = context.principal;
  if (principal.kind !== "execution") {
    throw new HttpError(
      403,
      "execution_forbidden_operation",
      "only the line run's engine may settle",
    );
  }
  const digest = settlementDigest(body);
  const current = await requireLine(deps, target);
  const prior = current.lastSettled;
  const recovered =
    prior !== undefined &&
    prior.batchId === body.batchId &&
    prior.digest === digest &&
    current.batch?.batchId !== body.batchId &&
    (prior.runId === undefined || prior.runId === principal.runId);
  let record: LineRecord;
  let at: string;
  let generation: number;
  let plan: SettlementPlan;
  if (recovered) {
    record = current;
    at = prior.at;
    generation = prior.generation;
    plan = planSettlement(body, settled, at);
    await appendPlanned(deps, principal, plan.events, at);
  } else {
    at = nowIso(deps.clock);
    generation = typeof owner === "number" ? owner : owner.generation;
    const dryRun = settleBatch(current, body, settled, owner, at);
    if (!dryRun.ok) throw refusalStatus(dryRun);
    plan = planSettlement(body, settled, at);
    await appendPlanned(deps, principal, plan.events, at);
    record = await applyLineChange(deps, target, (latest) =>
      settleBatch(latest, body, settled, owner, at),
    );
  }
  await appendSettledMarker(
    deps,
    principal,
    plan,
    { batchId: body.batchId, generation, digest },
    at,
  );
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
