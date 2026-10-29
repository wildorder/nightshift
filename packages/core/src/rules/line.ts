/**
 * The project line's rules (Pipkin M1b): the queue of published ranges, the
 * batch an owner takes, what it composes or parks, and the one push in flight;
 * the project's self-started spend against its cap; and the machine's slot.
 *
 * Pure over `LineRecord` and `ProjectSelfStartedUsage`. The
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
  LineParkBody,
  LinePushBody,
  LinePushStatus,
  LineQueueEntry,
  LineRange,
  LineRecord,
  LineResolver,
  LineSettleBody,
  ProgramId,
  ProjectId,
  ProjectSelfStartedUsage,
  RunId,
} from "@nightshift/contracts";
import { MAX_LINE_COMPOSITIONS, MAX_LINE_PARKED } from "@nightshift/contracts";

/** What the plane's own starts may spend on one project's line per month, unless the config says. */
export const DEFAULT_LINE_MONTHLY_USD = 25;
/** The most an owner is given to compose one batch, in seconds. */
export const LINE_COMPOSITION_SECONDS = 3600;
/** How long the owner waits with an empty queue and nothing in flight before it stops, in seconds. */
export const LINE_IDLE_SECONDS = 600;
/** The most attempts the conflict resolver gets at one composition. */
export const LINE_RESOLVER_ATTEMPTS = 3;
/** The most queue entries one batch takes; the rest wait for the next. */
export const MAX_LINE_BATCH_ENTRIES = 25;

/**
 * Who holds a batch. The line principal is its generation alone; a line run is
 * its `runId` and generation together, because a replacement run may carry the
 * same generation number as the run it replaced.
 */
export interface LineOwner {
  readonly runId: RunId;
  readonly generation: number;
}

export type LineOwnerArg = number | LineOwner;

const generationOf = (owner: LineOwnerArg): number =>
  typeof owner === "number" ? owner : owner.generation;

/** Whether a run owner is the holder of `batch`. A generation-only owner is not judged here. */
const holdsBatch = (batch: LineBatch, owner: LineOwnerArg): boolean =>
  typeof owner === "number" ||
  (batch.runId === owner.runId && batch.generation === owner.generation);

const notHolder = (owner: LineOwnerArg, batch: LineBatch | undefined): LineRefusal | undefined =>
  batch === undefined || holdsBatch(batch, owner)
    ? undefined
    : {
        reason: "stale_generation",
        detail: `this call is not from the owner that holds batch ${batch.batchId}`,
      };

export type LineRefusal =
  /** The batch named is not the one the line holds: the owner is stale, or the batch was settled already. */
  | { readonly reason: "stale_batch"; readonly detail: string }
  /** The resolver reports more attempts than it is allowed. */
  | { readonly reason: "resolver_attempts"; readonly detail: string }
  /** A push is already pending for another head. */
  | { readonly reason: "push_pending"; readonly detail: string }
  /** The push named is not the one the line holds. */
  | { readonly reason: "no_such_push"; readonly detail: string }
  /** A held entry was not an entry of the settled batch. */
  | { readonly reason: "held_not_in_batch"; readonly detail: string }
  /** The write is from an owner generation the line has moved past. */
  | { readonly reason: "stale_generation"; readonly detail: string };

export type LineChange =
  | { readonly ok: true; readonly record: LineRecord }
  | ({ readonly ok: false } & LineRefusal);

const refuse = (refusal: LineRefusal): LineChange => ({
  ok: false,
  ...refusal,
});

const sameRange = (
  a: Pick<LineRange, "program" | "upTo">,
  b: Pick<LineRange, "program" | "upTo">,
) => a.program === b.program && a.upTo === b.upTo;

/** Whether a range up to `upTo` of `program` is already in the batch or in a composition. */
const alreadyTaken = (record: LineRecord, program: ProgramId, upTo: CommitSha): boolean =>
  (record.batch?.entries ?? []).some((entry) => sameRange(entry, { program, upTo })) ||
  record.compositions.some(
    (composition) =>
      (composition.pushed !== undefined ||
        (record.push?.status === "pending" && record.push.head === composition.commit)) &&
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

/** Moves the held entries `pick` chooses to the front of the queue, repairs and enqueuedAt kept. */
const releaseHeld = (record: LineRecord, pick: (entry: LineQueueEntry) => boolean): LineRecord => {
  const released = record.held.filter(pick);
  if (released.length === 0) return record;
  const kept = record.held.filter((entry) => !pick(entry));
  const { heldBy: _heldBy, ...rest } = record;
  return {
    ...(kept.length === 0 ? rest : record),
    held: kept,
    queue: [
      ...released.filter((entry) => !record.queue.some((queued) => sameRange(queued, entry))),
      ...record.queue,
    ],
  };
};

/**
 * Moves the oldest `MAX_LINE_BATCH_ENTRIES` of the queue into one batch for the owner of `generation`. An empty
 * queue gives no batch. A batch already held is the owner's to finish, so it is
 * handed back instead (re-bound to `generation` when a newer owner asks), and
 * the queue waits behind it.
 */
export const takeBatch = (
  record: LineRecord,
  owner: LineOwnerArg,
  ids: { readonly batchId: string },
  at: string,
  release: readonly Pick<LineQueueEntry, "program" | "upTo">[] = [],
): { readonly record: LineRecord; readonly batch?: LineBatch } => {
  const generation = generationOf(owner);
  // A newer owner has no reservations, so everything held returns; otherwise only what was named.
  const replaced =
    record.held.length > 0 &&
    ((record.heldBy !== undefined && generation > record.heldBy) ||
      (record.batch !== undefined && record.batch.generation !== generation));
  const released = replaced
    ? releaseHeld(record, () => true)
    : release.length === 0
      ? record
      : releaseHeld(record, (entry) => release.some((named) => sameRange(named, entry)));
  if (released !== record) {
    const next = takeBatch(released, owner, ids, at);
    return {
      record: next.record === released ? { ...released, updatedAt: at } : next.record,
      ...(next.batch === undefined ? {} : { batch: next.batch }),
    };
  }
  const ownedBy = typeof owner === "number" ? {} : { runId: owner.runId };
  if (record.batch !== undefined) {
    if (
      record.batch.generation === generation &&
      (typeof owner === "number" || holdsBatch(record.batch, owner))
    ) {
      return { record, batch: record.batch };
    }
    // A newer owner takes back the batch the plane already fenced the old one out of.
    const { runId: _previous, ...held } = record.batch;
    const batch: LineBatch = { ...held, generation, ...ownedBy };
    return { record: { ...record, batch, updatedAt: at }, batch };
  }
  if (record.queue.length === 0) return { record };
  const batch: LineBatch = {
    batchId: ids.batchId,
    entries: record.queue.slice(0, MAX_LINE_BATCH_ENTRIES),
    takenAt: at,
    generation,
    ...ownedBy,
  };
  return {
    record: {
      ...record,
      queue: record.queue.slice(MAX_LINE_BATCH_ENTRIES),
      batch,
      updatedAt: at,
    },
  };
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

const notInBatch = (
  record: LineRecord,
  held: readonly LineQueueEntry[],
): LineRefusal | undefined => {
  const missing = held.find(
    (entry) => !(record.batch?.entries ?? []).some((taken) => sameRange(taken, entry)),
  );
  return missing === undefined
    ? undefined
    : {
        reason: "held_not_in_batch",
        detail: `${missing.program} up to ${missing.upTo.slice(0, 12)} was not an entry of batch ${record.batch?.batchId ?? "(none)"}`,
      };
};

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
            ...(body.repair === undefined ? {} : { repair: body.repair }),
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
            ...(body.repair === undefined ? {} : { repair: body.repair }),
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
 * Settles a batch with a composition and/or parked entries in one change. The
 * refusals are `composeBatch`'s and `parkBatch`'s: a stale batch, and a
 * resolver over its attempts (on the composition or any parked entry).
 */
export const settleBatch = (
  record: LineRecord,
  body: LineSettleBody,
  ids: {
    readonly compositionId?: string;
    readonly parkedIds: readonly string[];
  },
  owner: LineOwnerArg,
  at: string,
): LineChange => {
  const generation = generationOf(owner);
  const pending = record.push?.status === "pending" ? record.push : undefined;
  const refusal =
    notHolder(owner, record.batch) ??
    staleBatch(record, body.batchId) ??
    (body.push !== undefined && pending !== undefined && pending.head !== body.push.head
      ? ({
          reason: "push_pending",
          detail: `a push to ${pending.head.slice(0, 12)} is still pending`,
        } as const)
      : undefined) ??
    notInBatch(record, body.held ?? []) ??
    resolverOver(body.composition?.resolver) ??
    body.parked.map((entry) => resolverOver(entry.resolver)).find((r) => r !== undefined);
  if (refusal !== undefined) return refuse(refusal);
  const { batch: _settled, ...rest } = record;
  const composition = body.composition;
  const heldNow = (body.held ?? []).reduce<LineQueueEntry[]>(
    (all, entry) => {
      const at = all.findIndex((have) => sameRange(have, entry));
      if (at < 0) return [...all, entry];
      if ((entry.repairs ?? 0) > (all[at]?.repairs ?? 0)) all[at] = entry;
      return all;
    },
    [...record.held],
  );
  return {
    ok: true,
    record: {
      ...rest,
      ...(body.held === undefined || body.held.length === 0
        ? {}
        : { held: heldNow, heldBy: generation }),
      compositions:
        composition === undefined
          ? record.compositions
          : newest(
              [
                ...record.compositions,
                {
                  compositionId: ids.compositionId ?? "",
                  commit: composition.commit,
                  parent: composition.parent,
                  ranges: composition.ranges,
                  verification: composition.verification,
                  ...(composition.resolver === undefined ? {} : { resolver: composition.resolver }),
                  ...(composition.repair === undefined ? {} : { repair: composition.repair }),
                  composedAt: at,
                },
              ],
              MAX_LINE_COMPOSITIONS,
            ),
      ...(body.push === undefined
        ? {}
        : {
            push:
              pending !== undefined
                ? pending
                : {
                    ...body.push,
                    generation,
                    status: "pending" as const,
                    requestedAt: at,
                  },
          }),
      parked:
        body.parked.length === 0
          ? record.parked
          : newest(
              [
                ...record.parked,
                ...body.parked.map((entry, index) => ({
                  compositionId: ids.parkedIds[index] ?? "",
                  ranges: entry.ranges,
                  reason: entry.reason,
                  ...(entry.commit === undefined ? {} : { commit: entry.commit }),
                  ...(entry.verification === undefined ? {} : { verification: entry.verification }),
                  ...(entry.resolver === undefined ? {} : { resolver: entry.resolver }),
                  ...(entry.repair === undefined ? {} : { repair: entry.repair }),
                  parkedAt: at,
                })),
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
  owner: LineOwnerArg,
  at: string,
): LineChange => {
  const generation = generationOf(owner);
  const stale = notHolder(owner, record.batch);
  if (stale !== undefined) return refuse(stale);
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
  const unpushed =
    status === "published"
      ? undefined
      : record.compositions.find(
          (composition) => composition.commit === head && composition.pushed === undefined,
        );
  const requeued =
    unpushed === undefined
      ? record.queue
      : [
          ...unpushed.ranges
            .filter((range) => !record.queue.some((queued) => sameRange(queued, range)))
            .map((range) => ({
              program: range.program,
              upTo: range.upTo,
              enqueuedAt: unpushed.composedAt,
              ...(range.repairs === undefined ? {} : { repairs: range.repairs }),
            })),
          ...record.queue,
        ];
  return {
    ok: true,
    record: {
      ...record,
      ...(status === "published" ? { head } : {}),
      queue: requeued,
      push: {
        ...settled,
        status,
        resolvedAt: at,
        ...(detail === undefined ? {} : { detail }),
      },
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
  record.queue.length > 0 ||
  record.held.length > 0 ||
  record.batch !== undefined ||
  record.push?.status === "pending";

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

/**
 * The key of a line dispatch in a usage row's `charged`. The engine agent id is
 * fixed for the dispatch's life, so it survives lease replacements (which only
 * move the generation), and is fresh for each dispatch started after a settle.
 */
export const dispatchChargeKey = (branch: string, engineAgentId: string): string =>
  `${branch}#${engineAgentId}`;

/** The calendar month before `month`. */
export const previousMonthOf = (month: CalendarMonth): CalendarMonth => {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return (
    number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, "0")}`
  ) as CalendarMonth;
};

/**
 * What a dispatch has been charged in `month`'s row: its entry there, else the
 * `baselineUsd` (what the previous month's row held for it, or 0).
 */
const chargedOf = (
  current: ProjectSelfStartedUsage | undefined,
  month: CalendarMonth,
  key: string,
  baselineUsd: number,
): number =>
  (current !== undefined && current.month === month ? current.charged?.[key] : undefined) ??
  baselineUsd;

/** Whether a dispatch's cumulative spend is ahead of what `month`'s row has charged for it. */
export const dispatchChargeDue = (
  current: ProjectSelfStartedUsage | undefined,
  input: {
    readonly month: CalendarMonth;
    readonly key: string;
    readonly dispatchUsd: number;
    readonly baselineUsd: number;
  },
): boolean => input.dispatchUsd > chargedOf(current, input.month, input.key, input.baselineUsd);

/**
 * Charges a line dispatch's cumulative `dispatchUsd` to the project's row for
 * `month`: the difference from what the row already holds for `key` is added,
 * and the entry becomes the greater of the two. Idempotent: a repeat charges
 * nothing, and a beat after a failed write charges what that one missed. A new
 * month's row starts from `baselineUsd` (the previous month's entry), so a
 * dispatch across the boundary is charged only what it spent after it.
 */
export const chargeDispatchUsage = (
  current: ProjectSelfStartedUsage | undefined,
  input: {
    readonly projectId: ProjectId;
    readonly month: CalendarMonth;
    readonly capUsd: number;
    readonly key: string;
    readonly dispatchUsd: number;
    readonly baselineUsd: number;
  },
  at: string,
): ProjectSelfStartedUsage => {
  const charged = chargedOf(current, input.month, input.key, input.baselineUsd);
  const target = Math.max(charged, input.dispatchUsd);
  const metered = meterProjectUsage(
    current,
    {
      projectId: input.projectId,
      month: input.month,
      deltaUsd: target - charged,
      capUsd: input.capUsd,
    },
    at,
  );
  return {
    ...metered,
    charged: {
      ...(current !== undefined && current.month === input.month ? current.charged : {}),
      [input.key]: target,
    },
  };
};

/** Whether the project's self-started spend for `month` has reached `capUsd`. */
export const capReached = (
  usage: ProjectSelfStartedUsage | undefined,
  month: CalendarMonth,
  capUsd: number,
): boolean => usage !== undefined && usage.month === month && usage.meteredUsd >= capUsd;

const SLOT_STATUSES: readonly DispatchStatus[] = ["provisioning", "ready", "running", "stopping"];

/**
 * Whether a dispatch in `status` holds a compute slot against the org's
 * concurrency: a machine is being made, is up, or is being stopped. A
 * `requested` one has none yet, and a `stopped` or `failed` one has none left.
 */
export const occupiesComputeSlot = (status: DispatchStatus): boolean =>
  SLOT_STATUSES.includes(status);
