/**
 * The project line's rules (Pipkin M1b): the queue of published ranges, the
 * batch an owner takes, what it composes or parks, and the one push in flight;
 * the project's self-started spend against its cap; and the machine's slot.
 *
 * Pure over `LineRecord`, `ProjectSelfStartedUsage` and `LineDispatch`. The
 * stores apply them inside a compare-and-swap `update`, so each is a function
 * of the current record alone and is safe to call again on a lost race. A
 * refusal is a value, not a throw: the routes (J3) map each reason to a status.
 */
import type {
  CalendarMonth,
  CommitSha,
  Dispatch,
  DispatchStatus,
  LineBatch,
  LineCompositionBody,
  LineDispatch,
  LineParkBody,
  LinePushBody,
  LinePushStatus,
  LineRange,
  LineRecord,
  LineResolver,
  ProgramId,
  ProjectId,
  ProjectSelfStartedUsage,
} from "@nightshift/contracts";
import {
  type AgentId,
  type ComputeTier,
  MAX_LINE_COMPOSITIONS,
  MAX_LINE_PARKED,
} from "@nightshift/contracts";

/** What the plane's own starts may spend on one project's line per month, unless the config says. */
export const DEFAULT_LINE_MONTHLY_USD = 25;
/** The most an owner is given to compose one batch, in seconds. */
export const LINE_COMPOSITION_SECONDS = 3600;
/** The most attempts the conflict resolver gets at one composition. */
export const LINE_RESOLVER_ATTEMPTS = 3;

export type LineRefusal =
  /** The batch named is not the one the line holds: the owner is stale, or the batch was settled already. */
  | { readonly reason: "stale_batch"; readonly detail: string }
  /** The resolver reports more attempts than it is allowed. */
  | { readonly reason: "resolver_attempts"; readonly detail: string }
  /** A push is already pending for another head. */
  | { readonly reason: "push_pending"; readonly detail: string }
  /** The push named is not the one the line holds. */
  | { readonly reason: "no_such_push"; readonly detail: string };

export type LineChange =
  | { readonly ok: true; readonly record: LineRecord }
  | ({ readonly ok: false } & LineRefusal);

const refuse = (refusal: LineRefusal): LineChange => ({ ok: false, ...refusal });

const sameRange = (
  a: Pick<LineRange, "program" | "upTo">,
  b: Pick<LineRange, "program" | "upTo">,
) => a.program === b.program && a.upTo === b.upTo;

/** Whether a range up to `upTo` of `program` is already in the batch or in a composition. */
const alreadyTaken = (record: LineRecord, program: ProgramId, upTo: CommitSha): boolean =>
  (record.batch?.entries ?? []).some((entry) => sameRange(entry, { program, upTo })) ||
  record.compositions.some((composition) =>
    composition.ranges.some((range) => sameRange(range, { program, upTo })),
  );

/**
 * Queues a published range. The same program and head again is the same entry,
 * and a range already batched or composed is not queued a second time.
 */
export const appendQueueEntry = (
  record: LineRecord,
  entry: { readonly program: ProgramId; readonly upTo: CommitSha },
  at: string,
): LineRecord => {
  if (record.queue.some((queued) => sameRange(queued, entry))) return record;
  if (alreadyTaken(record, entry.program, entry.upTo)) return record;
  return {
    ...record,
    queue: [...record.queue, { program: entry.program, upTo: entry.upTo, enqueuedAt: at }],
    updatedAt: at,
  };
};

/**
 * Moves the whole queue into one batch for the owner of `generation`. An empty
 * queue gives no batch. A batch already held is the owner's to finish, so it is
 * handed back instead (re-bound to `generation` when a newer owner asks), and
 * the queue waits behind it.
 */
export const takeBatch = (
  record: LineRecord,
  generation: number,
  ids: { readonly batchId: string },
  at: string,
): { readonly record: LineRecord; readonly batch?: LineBatch } => {
  if (record.batch !== undefined) {
    if (record.batch.generation === generation) return { record, batch: record.batch };
    const batch: LineBatch = { ...record.batch, generation };
    return { record: { ...record, batch, updatedAt: at }, batch };
  }
  if (record.queue.length === 0) return { record };
  const batch: LineBatch = {
    batchId: ids.batchId,
    entries: record.queue,
    takenAt: at,
    generation,
  };
  return { record: { ...record, queue: [], batch, updatedAt: at } };
};

const staleBatch = (record: LineRecord, batchId: string): LineRefusal | undefined =>
  record.batch?.batchId === batchId
    ? undefined
    : {
        reason: "stale_batch",
        detail:
          record.batch === undefined
            ? `the line holds no batch; ${batchId} was settled or never taken`
            : `the line holds batch ${record.batch.batchId}, not ${batchId}`,
      };

const resolverOver = (resolver: LineResolver | undefined): LineRefusal | undefined =>
  resolver !== undefined && resolver.attempts > LINE_RESOLVER_ATTEMPTS
    ? {
        reason: "resolver_attempts",
        detail: `the resolver reports ${resolver.attempts} attempts; at most ${LINE_RESOLVER_ATTEMPTS} are allowed`,
      }
    : undefined;

const newest = <T>(items: readonly T[], max: number): T[] =>
  items.length > max ? items.slice(items.length - max) : [...items];

/** Records the owner's composition and settles its batch. */
export const composeBatch = (
  record: LineRecord,
  body: LineCompositionBody,
  compositionId: string,
  at: string,
): LineChange => {
  const refusal = staleBatch(record, body.batchId) ?? resolverOver(body.resolver);
  if (refusal !== undefined) return refuse(refusal);
  const { batch: _settled, ...rest } = record;
  return {
    ok: true,
    record: {
      ...rest,
      compositions: newest(
        [
          ...record.compositions,
          {
            compositionId,
            commit: body.commit,
            parent: body.parent,
            ranges: body.ranges,
            verification: body.verification,
            ...(body.resolver === undefined ? {} : { resolver: body.resolver }),
            composedAt: at,
          },
        ],
        MAX_LINE_COMPOSITIONS,
      ),
      updatedAt: at,
    },
  };
};

/** Records ranges the owner could not compose, with why, and settles its batch. */
export const parkBatch = (
  record: LineRecord,
  body: LineParkBody,
  compositionId: string,
  at: string,
): LineChange => {
  const refusal = staleBatch(record, body.batchId) ?? resolverOver(body.resolver);
  if (refusal !== undefined) return refuse(refusal);
  const { batch: _settled, ...rest } = record;
  return {
    ok: true,
    record: {
      ...rest,
      parked: newest(
        [
          ...record.parked,
          {
            compositionId,
            ranges: body.ranges,
            reason: body.reason,
            ...(body.commit === undefined ? {} : { commit: body.commit }),
            ...(body.verification === undefined ? {} : { verification: body.verification }),
            ...(body.resolver === undefined ? {} : { resolver: body.resolver }),
            parkedAt: at,
          },
        ],
        MAX_LINE_PARKED,
      ),
      updatedAt: at,
    },
  };
};

/**
 * Asks the publisher to move the line. The same head again is the same request;
 * a second head while one is pending is refused, because the line moves one
 * compare-and-swap at a time. A request resolved already is replaced.
 */
export const requestPush = (
  record: LineRecord,
  request: LinePushBody,
  generation: number,
  at: string,
): LineChange => {
  const current = record.push;
  if (current?.status === "pending") {
    if (current.head === request.head) return { ok: true, record };
    return refuse({
      reason: "push_pending",
      detail: `a push to ${current.head.slice(0, 12)} is still pending`,
    });
  }
  return {
    ok: true,
    record: {
      ...record,
      push: { ...request, generation, status: "pending", requestedAt: at },
      updatedAt: at,
    },
  };
};

/**
 * The publisher's word on the push for `head`. `published` moves the line's
 * known head and marks the composition at that commit pushed; any other status
 * leaves the head where it was and keeps the detail.
 */
export const resolvePush = (
  record: LineRecord,
  head: CommitSha,
  status: Exclude<LinePushStatus, "pending">,
  detail: string | undefined,
  at: string,
): LineChange => {
  const push = record.push;
  if (push === undefined || push.head !== head) {
    return refuse({
      reason: "no_such_push",
      detail: `the line has no push to ${head.slice(0, 12)}`,
    });
  }
  const { detail: _previous, ...settled } = push;
  return {
    ok: true,
    record: {
      ...record,
      ...(status === "published" ? { head } : {}),
      push: { ...settled, status, resolvedAt: at, ...(detail === undefined ? {} : { detail }) },
      compositions:
        status === "published"
          ? record.compositions.map((composition) =>
              composition.commit === head && composition.pushed === undefined
                ? { ...composition, pushed: { at } }
                : composition,
            )
          : record.compositions,
      updatedAt: at,
    },
  };
};

/** Whether the line has anything left for an owner to do: a queue, a batch, or a push to resolve. */
export const lineHasWork = (record: LineRecord): boolean =>
  record.queue.length > 0 || record.batch !== undefined || record.push?.status === "pending";

/**
 * Whether a run's publication owes the line a range it has not queued: the run
 * asked for it (`lineOwed`) and its published head is not the one last queued.
 */
export const lineQueueOwed = (dispatch: Pick<Dispatch, "publication">): boolean => {
  const { lineOwed, head, lineQueuedUpTo } = dispatch.publication;
  return lineOwed === true && head !== undefined && head !== lineQueuedUpTo;
};

/** Zero spend, for a project the plane has not yet started a line owner for this month. */
const freshUsage = (
  projectId: ProjectId,
  month: CalendarMonth,
  capUsd: number,
  at: string,
): ProjectSelfStartedUsage => ({
  schemaVersion: 1,
  projectId,
  month,
  meteredUsd: 0,
  capUsd,
  version: 1,
  updatedAt: at,
});

/**
 * Adds `deltaUsd` to the project's self-started spend for `month`. A row of
 * another month is not carried over: the month rolls and the spend starts at
 * zero. `reachedAt` is set the first time the spend reaches the cap.
 */
export const meterProjectUsage = (
  current: ProjectSelfStartedUsage | undefined,
  input: {
    readonly projectId: ProjectId;
    readonly month: CalendarMonth;
    readonly deltaUsd: number;
    readonly capUsd: number;
  },
  at: string,
): ProjectSelfStartedUsage => {
  const base =
    current !== undefined && current.month === input.month
      ? current
      : freshUsage(input.projectId, input.month, input.capUsd, at);
  const meteredUsd = base.meteredUsd + Math.max(0, input.deltaUsd);
  const { reachedAt, ...rest } = base;
  const reached = reachedAt ?? (meteredUsd >= input.capUsd ? at : undefined);
  return {
    ...rest,
    meteredUsd,
    capUsd: input.capUsd,
    ...(reached === undefined ? {} : { reachedAt: reached }),
    updatedAt: at,
  };
};

/** Whether the project's self-started spend for `month` has reached `capUsd`. */
export const capReached = (
  usage: ProjectSelfStartedUsage | undefined,
  month: CalendarMonth,
  capUsd: number,
): boolean => usage !== undefined && usage.month === month && usage.meteredUsd >= capUsd;

/** The machine a line owner is asked for, until provisioning (J5) settles it. */
export interface LineMachineSpec {
  readonly tier: ComputeTier;
  readonly instanceType: string;
  readonly usdPerHour: number;
  readonly amiVersion: string;
  readonly workspace?: LineDispatch["workspace"];
}

/**
 * A requested dispatch of the line. The generation continues from `previous`
 * (plus one, never back to 1), so an owner of an older dispatch stays fenced.
 */
export const newLineDispatch = (input: {
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly previous?: Pick<LineDispatch, "generation"> | undefined;
  readonly engineAgentId: AgentId;
  readonly machine: LineMachineSpec;
  readonly at: string;
}): LineDispatch => {
  const generation = (input.previous?.generation ?? 0) + 1;
  const { machine } = input;
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    branch: input.branch,
    version: 1,
    status: "requested",
    tier: machine.tier,
    instanceType: machine.instanceType,
    usdPerHour: machine.usdPerHour,
    ...(machine.workspace === undefined ? {} : { workspace: machine.workspace }),
    amiVersion: machine.amiVersion,
    generation,
    engineAgentId: input.engineAgentId,
    attempts: [{ generation, reason: "dispatch", startedAt: input.at }],
    spend: {
      estimatedUsd: (LINE_COMPOSITION_SECONDS / 3600) * machine.usdPerHour,
      ceilingSeconds: LINE_COMPOSITION_SECONDS,
      meteredUsd: 0,
      meteredSeconds: 0,
    },
    cleanup: { volumeDeleted: false, failures: [] },
    requestedAt: input.at,
    updatedAt: input.at,
  };
};

const SLOT_STATUSES: readonly DispatchStatus[] = ["provisioning", "ready", "running", "stopping"];

/**
 * Whether a dispatch in `status` holds a compute slot against the org's
 * concurrency: a machine is being made, is up, or is being stopped. A
 * `requested` one has none yet, and a `stopped` or `failed` one has none left.
 */
export const occupiesComputeSlot = (status: DispatchStatus): boolean =>
  SLOT_STATUSES.includes(status);
