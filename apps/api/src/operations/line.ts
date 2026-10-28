/**
 * The project line's routes (Pipkin M1b): what the line owner (a machine holding
 * a `line` token) and humans use. Everything is keyed by (project, branch); the
 * branch is one URL-encoded path segment, which the router has decoded.
 *
 * The rules are `core`'s (`rules/line.ts`) and return refusals as values; this
 * file only maps each to a status and applies the result inside the store's
 * compare-and-swap `update`. The heartbeat mirrors a run's (`dispatch.ts`),
 * applied to a `LineDispatch` and metered against the project's own cap as well
 * as the org's ledger.
 */
import {
  calendarMonthOf,
  DEFAULT_COMPUTE_CEILINGS,
  type HeartbeatResponse,
  HeartbeatResponseSchema,
  LineAgentBodySchema,
  LineBundleUploadUrlBodySchema,
  type LineCompositionBody,
  LineCompositionBodySchema,
  LineDecisionBodySchema,
  type LineDispatch,
  type LineDispatchFailureCode,
  LineHeartbeatBodySchema,
  type LineParkBody,
  LineParkBodySchema,
  LinePushBodySchema,
  type LineRecord,
  type LineSettleBody,
  LineSettleBodySchema,
  type LineView,
  LineViewSchema,
  type OrgId,
  PROVIDERS,
  type Project,
  type ProjectId,
  type Provider,
  TakeLineBatchBodySchema,
} from "@nightshift/contracts";
import {
  announceLineAgent,
  chargeDispatchUsage,
  composeBatch,
  createUlidIdGenerator,
  DEFAULT_LINE_MONTHLY_USD,
  dispatchChargeDue,
  dispatchChargeKey,
  ensureLineDispatch,
  foldProgress,
  foldStages,
  installationGranting,
  isDispatchTerminal,
  LINE_COMPOSITION_SECONDS,
  LINE_RESOLVER_ATTEMPTS,
  type LineChange,
  type LineRefusal,
  leaseExpiryFrom,
  lineBundleObjectKey,
  meterUsd,
  nowIso,
  parkBatch,
  previousMonthOf,
  recordLineDecision,
  repositoryNameOf,
  requestPush,
  requireEffectivePolicy,
  runnerStopped,
  settleBatch,
  takeBatch,
  transitionDispatch,
} from "@nightshift/core";
import { type ApiDeps, HttpError, parseBody } from "../http.js";
import { projectIdFrom } from "../params.js";
import type { Handler, RouteContext } from "../router.js";
import { mintLineToken } from "../tokens/mint.js";
import { pageAt, readAll, requireProject } from "./common.js";
import { keepRefreshedLogin, usageOf } from "./dispatch.js";
import { openProjectSecrets } from "./secrets.js";

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

const requireLineDispatch = async (deps: ApiDeps, target: LineTarget): Promise<LineDispatch> => {
  const dispatch = await deps.stores.lineDispatches.get(target.projectId, target.branch);
  if (dispatch === undefined) {
    throw new HttpError(404, "not_found", `the line on ${target.branch} has no dispatch`);
  }
  return dispatch;
};

/** A dispatch of the generation the caller claims, or 409: the owner is stale. */
const requireGeneration = async (
  deps: ApiDeps,
  target: LineTarget,
  generation: number,
): Promise<LineDispatch> => {
  const dispatch = await requireLineDispatch(deps, target);
  if (dispatch.generation !== generation) {
    throw new HttpError(
      409,
      "stale_generation",
      `this call is from generation ${generation}; the line's dispatch is at ${dispatch.generation}`,
    );
  }
  return dispatch;
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

/**
 * The project's monthly cap for this line: the lowest `line.monthlyUsd` among
 * the project's programs configured for this branch that set one, else the
 * default. Read from the programs' contracts, which inherit the config.
 */
const capUsdOf = async (deps: ApiDeps, target: LineTarget): Promise<number> => {
  const contracts = await readAll((cursor) =>
    deps.stores.programContracts.listByProject(target.projectId, pageAt(cursor)),
  );
  const caps = contracts.flatMap((contract) =>
    contract.line?.branch === target.branch && contract.line.monthlyUsd !== undefined
      ? [contract.line.monthlyUsd]
      : [],
  );
  return caps.length === 0 ? DEFAULT_LINE_MONTHLY_USD : Math.min(...caps);
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
  const dispatch = await deps.stores.lineDispatches.get(target.projectId, target.branch);
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
    ...(dispatch === undefined ? {} : { dispatch }),
    ...(usage === undefined ? {} : { usage }),
    ...(policy === undefined ? {} : { policy }),
    programs,
  };
  return { status: 200, body: LineViewSchema.parse(view) };
};

/** `POST …/line/batch?branch=` — the whole queue as one batch, or none. */
export const takeLineBatch: Handler = async ({ deps, request, params }) => {
  const target = targetOf(params);
  const body = parseBody(TakeLineBatchBodySchema, request.body);
  await requireGeneration(deps, target, body.generation);
  const at = nowIso(deps.clock);
  const ids = deps.ids ?? createUlidIdGenerator(deps.clock);
  let taken: ReturnType<typeof takeBatch> | undefined;
  const stored = await deps.stores.lines.update(target.projectId, target.branch, (current) => {
    if (current === undefined) return undefined;
    taken = takeBatch(current, body.generation, { batchId: ids.next("comp") }, at);
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
  return { status: 200, body: stored.batch === undefined ? {} : { batch: stored.batch } };
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

/** `POST …/line/compositions?branch=`. */
export const postLineComposition: Handler = async ({ deps, request, params }) => {
  const target = targetOf(params);
  refuseResolverOver(request.body);
  const body: LineCompositionBody = parseBody(LineCompositionBodySchema, request.body);
  const at = nowIso(deps.clock);
  const compositionId = (deps.ids ?? createUlidIdGenerator(deps.clock)).next("comp");
  const record = await applyLineChange(deps, target, (current) =>
    composeBatch(current, body, compositionId, at),
  );
  return { status: 200, body: record };
};

/** `POST …/line/decisions?branch=` — a resolver's decision, recorded for later review. */
export const postLineDecision: Handler = async ({ deps, request, params }) => {
  const target = targetOf(params);
  const body = parseBody(LineDecisionBodySchema, request.body);
  const dispatch = await requireGeneration(deps, target, body.generation);
  const at = nowIso(deps.clock);
  const decisionId = (deps.ids ?? createUlidIdGenerator(deps.clock)).next("dec");
  const record = await applyLineChange(deps, target, (current) =>
    recordLineDecision(current, body, decisionId, dispatch.generation, at),
  );
  return { status: 200, body: record };
};

/** `POST …/line/agents?branch=` — an agent announced before it runs (A-04). */
export const postLineAgent: Handler = async ({ deps, request, params }) => {
  const target = targetOf(params);
  const body = parseBody(LineAgentBodySchema, request.body);
  await requireGeneration(deps, target, body.generation);
  const at = nowIso(deps.clock);
  let refused: string | undefined;
  const stored = await deps.stores.lineDispatches.update(
    target.projectId,
    target.branch,
    (current) => {
      const change = announceLineAgent(current, { ...body.agent, generation: body.generation }, at);
      refused = change.ok ? undefined : change.detail;
      return change.ok && change.dispatch !== current ? change.dispatch : undefined;
    },
  );
  if (refused !== undefined) throw new HttpError(409, "stale_generation", refused);
  if (stored === undefined) {
    throw new HttpError(404, "not_found", `the line on ${target.branch} has no dispatch`);
  }
  return { status: 200, body: stored };
};

/** `POST …/line/parked?branch=`. */
export const postLineParked: Handler = async ({ deps, request, params }) => {
  const target = targetOf(params);
  refuseResolverOver(request.body);
  const body: LineParkBody = parseBody(LineParkBodySchema, request.body);
  const at = nowIso(deps.clock);
  const compositionId = (deps.ids ?? createUlidIdGenerator(deps.clock)).next("comp");
  const record = await applyLineChange(deps, target, (current) =>
    parkBatch(current, body, compositionId, at),
  );
  return { status: 200, body: record };
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

/** `POST …/line/settle?branch=` — the batch settled with a composition and/or parked entries. */
export const postLineSettle: Handler = async ({ deps, request, params }) => {
  const target = targetOf(params);
  const raw = request.body as { composition?: unknown; parked?: unknown } | null | undefined;
  refuseResolverOver(raw?.composition);
  if (Array.isArray(raw?.parked)) for (const entry of raw.parked) refuseResolverOver(entry);
  const body: LineSettleBody = parseBody(LineSettleBodySchema, request.body);
  const at = nowIso(deps.clock);
  const ids = deps.ids ?? createUlidIdGenerator(deps.clock);
  const compositionId = body.composition === undefined ? undefined : ids.next("comp");
  const parkedIds = body.parked.map(() => ids.next("comp"));
  const dispatch = await requireLineDispatch(deps, target);
  const record = await applyLineChange(deps, target, (current) =>
    settleBatch(
      current,
      body,
      { ...(compositionId === undefined ? {} : { compositionId }), parkedIds },
      dispatch.generation,
      at,
    ),
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
export const postLinePush: Handler = async ({ deps, request, params }) => {
  const target = targetOf(params);
  const body = parseBody(LinePushBodySchema, request.body);
  const dispatch = await requireLineDispatch(deps, target);
  const at = nowIso(deps.clock);
  const record = await applyLineChange(deps, target, (current) =>
    requestPush(current, body, dispatch.generation, at),
  );
  await askPublisher(deps, target);
  return { status: 200, body: record };
};

/** An id that is one safe segment of the object key. */
const BUNDLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `POST …/line/bundle-upload-url?branch=` — a presigned PUT for one bundle. */
export const createLineBundleUploadUrl: Handler = async ({ deps, request, params }) => {
  const target = targetOf(params);
  const body = parseBody(LineBundleUploadUrlBodySchema, request.body);
  if (!BUNDLE_ID.test(body.id)) {
    throw new HttpError(400, "validation_failed", "id must be 1-64 letters, digits, - or _");
  }
  await requireGeneration(deps, target, body.generation);
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

const STOP_STATUSES = ["stopping", "stopped", "failed"] as const;

/**
 * `POST …/line/dispatch/cancel?branch=` — a human stops the line owner.
 * `authorize` refuses the line principal this operation.
 */
export const cancelLineDispatch: Handler = async ({ deps, params }) => {
  const target = targetOf(params);
  const at = nowIso(deps.clock);
  let result: LineDispatch | undefined;
  const stored = await deps.stores.lineDispatches.update(
    target.projectId,
    target.branch,
    (current) => {
      result = current;
      if (isDispatchTerminal(current.status) || current.status === "stopping") return undefined;
      return transitionDispatch<LineDispatch>(
        { ...current, failure: { code: "cancelled", message: "cancelled by the operator" } },
        "stop",
        at,
      );
    },
  );
  if (stored === undefined || result === undefined) {
    throw new HttpError(404, "not_found", `the line on ${target.branch} has no dispatch`);
  }
  return { status: 200, body: stored };
};

/** `POST …/line/heartbeat?branch=`. */
export const lineHeartbeat: Handler = async (context) => {
  const { deps, request, params } = context;
  const target = targetOf(params);
  const body = parseBody(LineHeartbeatBodySchema, request.body);
  const at = nowIso(deps.clock);
  const month = calendarMonthOf(at);

  const current = await requireLineDispatch(deps, target);
  // The fence: only the current generation is heard.
  if (body.generation !== current.generation) {
    throw new HttpError(
      409,
      "stale_generation",
      `this heartbeat is from generation ${body.generation}; the line's dispatch is at ${current.generation}`,
    );
  }
  if (current.status === "requested") {
    throw new HttpError(409, "no_machine", "the dispatch has no machine yet to heartbeat from");
  }

  let previousUsd = 0;
  let dispatch = current;
  const stored = await deps.stores.lineDispatches.update(
    target.projectId,
    target.branch,
    (held): LineDispatch | undefined => {
      if (held.generation !== body.generation) return undefined;
      let next = held;
      if (body.report === "ready" && next.status === "provisioning") {
        next = transitionDispatch(next, "ready", at);
      } else if (body.report === "running" && next.status === "ready") {
        next = transitionDispatch(next, "start", at);
      } else if (body.report === "stopped") {
        next = runnerStopped(next, body.failure, at);
      }
      previousUsd = held.spend.meteredUsd;
      const attempts = next.attempts.map((attempt) =>
        attempt.generation === next.generation
          ? {
              ...attempt,
              meteredSeconds: Math.max(attempt.meteredSeconds ?? 0, body.meteredSeconds),
              ...(body.report === "ready" && attempt.readyAt === undefined ? { readyAt: at } : {}),
              ...(body.report === "running" && attempt.runningAt === undefined
                ? { runningAt: at }
                : {}),
              ...(body.report === "stopped" && attempt.endedAt === undefined
                ? {
                    endedAt: at,
                    endReason:
                      body.failure === undefined ? ("stopped" as const) : ("failed" as const),
                  }
                : {}),
            }
          : attempt,
      );
      const meteredSeconds = attempts.reduce(
        (total, attempt) => total + (attempt.meteredSeconds ?? 0),
        0,
      );
      const live = !STOP_STATUSES.includes(next.status as (typeof STOP_STATUSES)[number]);
      const progress =
        body.progress === undefined
          ? undefined
          : foldProgress(next.progress, body.progress, next.generation, at);
      const updated: LineDispatch = {
        ...next,
        attempts,
        spend: {
          ...next.spend,
          meteredSeconds,
          meteredUsd: meterUsd(next.tier, meteredSeconds),
        },
        ...(live ? { leaseExpiresAt: leaseExpiryFrom(deps.clock.now()) } : {}),
        ...(progress === undefined ? {} : { progress, stages: foldStages(next.stages, progress) }),
        updatedAt: at,
      };
      dispatch = updated;
      return updated;
    },
  );
  if (stored === undefined) {
    throw new HttpError(
      409,
      "stale_generation",
      "the line's dispatch moved on during the heartbeat",
    );
  }
  dispatch = stored;
  const live = !STOP_STATUSES.includes(dispatch.status as (typeof STOP_STATUSES)[number]);
  const { meteredUsd, meteredSeconds } = dispatch.spend;
  const delta = Math.max(0, meteredUsd - previousUsd);

  const project = await requireProject(deps.stores, target.projectId);
  if (live && body.refreshedCredentials?.openai !== undefined) {
    await keepRefreshedLogin(
      deps,
      project.orgId,
      `line ${target.branch}`,
      body.refreshedCredentials.openai,
    );
  }

  // The org's ledger, exactly as a run's.
  if (delta > 0) {
    const usage = await usageOf(deps, project.orgId, at);
    await deps.stores.computeLedger.put({
      ...usage,
      meteredUsd: usage.meteredUsd + (meteredUsd - previousUsd),
      updatedAt: at,
    });
  }

  // The project's own: shared by every line branch of the project, by CAS.
  let record = await requireLine(deps, target);
  const capUsd = await capUsdOf(deps, target);
  const held = await deps.stores.projectSelfStartedUsage.get(target.projectId, month);
  let usage = held;
  // Charged by the dispatch's cumulative spend against what the row already
  // holds for it, never by this beat's delta: a write that failed is repaired
  // by the next beat, and a repeated beat charges nothing.
  const chargeKey = dispatchChargeKey(dispatch.branch, dispatch.engineAgentId);
  const baselineUsd =
    held !== undefined && held.charged?.[chargeKey] !== undefined
      ? 0
      : ((await deps.stores.projectSelfStartedUsage.get(target.projectId, previousMonthOf(month)))
          ?.charged?.[chargeKey] ?? 0);
  const charge = { month, key: chargeKey, dispatchUsd: meteredUsd, baselineUsd };
  if (
    dispatchChargeDue(held, charge) ||
    (held !== undefined && held.meteredUsd >= capUsd && held.reachedAt === undefined)
  ) {
    usage = await deps.stores.projectSelfStartedUsage.update(target.projectId, month, (row) =>
      chargeDispatchUsage(row, { projectId: target.projectId, capUsd, ...charge }, at),
    );
  }

  // Ceilings: the project's cap, then the org's per-run and wall-clock ones.
  let stop = !live;
  const ceilings =
    (await deps.stores.orgConfigs.get(project.orgId))?.compute ?? DEFAULT_COMPUTE_CEILINGS;
  if (live) {
    const overCap = usage !== undefined && usage.month === month && usage.meteredUsd >= capUsd;
    const overRun = meteredUsd > ceilings.maxUsdPerRun;
    const overHours = meteredSeconds > ceilings.maxRunHours * 3600;
    if (overCap || overRun || overHours) {
      const code: LineDispatchFailureCode = overCap
        ? "line_cap"
        : overRun
          ? "run_cap"
          : "wall_clock";
      const message =
        code === "line_cap"
          ? `the project's self-started spend $${(usage?.meteredUsd ?? 0).toFixed(2)} reached the $${capUsd.toFixed(2)} monthly cap for ${month}`
          : code === "run_cap"
            ? `metered $${meteredUsd.toFixed(2)} crossed the $${ceilings.maxUsdPerRun.toFixed(2)} cap per run`
            : `metered ${Math.round(meteredSeconds / 60)} minutes crossed the ${ceilings.maxRunHours}-hour wall clock`;
      const stopped = await deps.stores.lineDispatches.update(
        target.projectId,
        target.branch,
        (now) =>
          now.generation === dispatch.generation &&
          !isDispatchTerminal(now.status) &&
          now.status !== "stopping"
            ? transitionDispatch<LineDispatch>({ ...now, failure: { code, message } }, "stop", at)
            : undefined,
      );
      if (stopped !== undefined) dispatch = stopped;
      if (code === "line_cap") {
        await deps.stores.lines.update(target.projectId, target.branch, (row) =>
          row === undefined
            ? undefined
            : {
                ...row,
                waiting: {
                  reason: "monthly_cap",
                  detail: message,
                  since: row.waiting?.reason === "monthly_cap" ? row.waiting.since : at,
                },
                updatedAt: at,
              },
        );
      }
      stop = true;
    }
  }

  // A batch an owner has held past the composition hour is parked, whole.
  if (live) {
    await deps.stores.lines.update(target.projectId, target.branch, (row) => {
      const batch = row?.batch;
      if (row === undefined || batch === undefined) return undefined;
      if (Date.parse(at) - Date.parse(batch.takenAt) <= LINE_COMPOSITION_SECONDS * 1000) {
        return undefined;
      }
      const parked = parkBatch(
        row,
        {
          batchId: batch.batchId,
          ranges: batch.entries.map((entry) => ({ program: entry.program, upTo: entry.upTo })),
          reason: "composition_hour",
        },
        (deps.ids ?? createUlidIdGenerator(deps.clock)).next("comp"),
        at,
      );
      return parked.ok ? parked.record : undefined;
    });
  }

  // The owner stopped with work still queued: ask for the next dispatch. It
  // answers `live` until the last one's cleanup has settled (J5 restarts then).
  if (body.report === "stopped") {
    record = await requireLine(deps, target);
    if (record.queue.length > 0) {
      await ensureLineDispatch(
        {
          stores: deps.stores,
          clock: deps.clock,
          ids: deps.ids ?? createUlidIdGenerator(deps.clock),
          startMachine: async (line) => {
            await deps.dispatcher?.provisionLine?.(line).catch((error: unknown) => {
              console.error(`line ${line.branch}: the dispatcher could not be invoked`, error);
            });
          },
        },
        { ...target, capUsd: await capUsdOf(deps, target) },
      );
    }
  }

  record = await requireLine(deps, target);
  const response: HeartbeatResponse = {
    generation: dispatch.generation,
    status: dispatch.status,
    leaseExpiresAt: dispatch.leaseExpiresAt ?? at,
    stop,
    ...(await renewedLineToken(context, dispatch, stop)),
    ...(await credentialsFor(deps, project, record, dispatch, stop)),
    ...(await secretsFor(deps, project, dispatch, stop)),
  };
  return { status: 200, body: HeartbeatResponseSchema.parse(response) };
};

const renewedLineToken = async (
  { deps }: RouteContext,
  dispatch: LineDispatch,
  stop: boolean,
): Promise<Pick<HeartbeatResponse, "token" | "tokenExpiresAt">> => {
  if (stop || deps.tokens === undefined) return {};
  const minted = await mintLineToken(deps.tokens.signer, {
    dispatch,
    issuer: deps.tokens.issuer,
    now: deps.clock.now(),
  });
  return { token: minted.token, tokenExpiresAt: minted.expiresAt };
};

/** The project's secrets, only while the owner is running and is to carry on. */
const secretsFor = async (
  deps: ApiDeps,
  project: Project,
  dispatch: LineDispatch,
  stop: boolean,
): Promise<Pick<HeartbeatResponse, "secrets">> => {
  if (stop || dispatch.status !== "running") return {};
  const secrets = await openProjectSecrets(deps, project);
  return Object.keys(secrets).length === 0 ? {} : { secrets };
};

/**
 * The org's provider keys and a GitHub read token for the line's repository,
 * only while the owner is running and is to carry on. The read token is the one
 * credential for GitHub the owner is given: only the publisher writes.
 */
const credentialsFor = async (
  deps: ApiDeps,
  project: Project,
  record: LineRecord,
  dispatch: LineDispatch,
  stop: boolean,
): Promise<Pick<HeartbeatResponse, "credentials">> => {
  if (stop || dispatch.status !== "running") return {};
  const orgId: OrgId = project.orgId;
  const credentials: Record<string, string> = {};
  const repository = repositoryNameOf(record.repositoryUrl);
  const installation =
    repository === undefined
      ? undefined
      : installationGranting(
          (await deps.stores.orgConfigs.get(orgId))?.installations ?? [],
          repository,
        );
  if (deps.github !== undefined && installation !== undefined && repository !== undefined) {
    try {
      credentials.github = (
        await deps.github.readToken(installation.installationId, [repository])
      ).token;
    } catch (error) {
      console.error(`line ${dispatch.branch}: no GitHub read token for the machine`, error);
    }
  }
  if (deps.envelope !== undefined) {
    for (const provider of PROVIDERS) {
      let sealed: Awaited<ReturnType<typeof deps.stores.credentials.sealed>>;
      try {
        sealed = await deps.stores.credentials.sealed(orgId, provider as Provider);
      } catch (error) {
        if (error instanceof Error && error.name === "CredentialsTableUnavailableError") break;
        throw error;
      }
      if (sealed === undefined) continue;
      credentials[provider] = await deps.envelope.open(orgId, provider as Provider, sealed);
    }
  }
  return Object.keys(credentials).length === 0 ? {} : { credentials };
};
