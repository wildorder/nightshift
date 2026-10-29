import {
  type CommitSha,
  type LineBatch,
  type LineQueueEntry,
  type LineRange,
  type LineRepairRef,
  type LineVerification,
  MAX_LINE_REPAIRS,
  type ProgramId,
} from "@nightshift/contracts";
import { LINE_COMPOSITION_SECONDS } from "@nightshift/core";
import { lineCauseText } from "./park.js";
import type {
  LineBatchOutcome,
  LineCommandLog,
  LineComposerPorts,
  LineRepairCause,
  LineRepairRequest,
  LineSettlement,
  LineWorktree,
  RepairOutcome,
} from "./ports.js";

type ParkPart = LineSettlement["parked"][number];

const rangeLabel = (range: LineRange): string =>
  `${range.program} ${range.from ?? "(start)"}..${range.upTo}`;

const withRepairs = (range: LineRange, repairs: number): LineRange => {
  const { repairs: _spent, ...rest } = range;
  return repairs > 0 ? { ...rest, repairs } : rest;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const TIME_LIMIT_REASON = "the composition's time limit passed before this range could be composed";
const RECENT_REPAIRS = 5;

interface Grouped {
  range: LineRange;
  entries: LineQueueEntry[];
}

interface Unit {
  program: ProgramId;
  entries: LineQueueEntry[];
  repairs: number;
  /** Set for a released range: it is its own range and never joins queued entries. */
  released?: HeldItem;
  first: number;
}

/**
 * The batch's ranges. A released (repaired) range stands alone, and so does any
 * entry that already carries repairs; only plain queued entries of one program
 * are combined. Within a program the ranges chain: each starts where the one
 * before it ended, so a later range never absorbs an earlier one.
 */
const groupRanges = async (
  ports: LineComposerPorts,
  lineHead: CommitSha,
  batch: LineBatch,
  released: HeldItem[],
): Promise<Grouped[]> => {
  const entries = batch.entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Date.parse(a.entry.enqueuedAt) - Date.parse(b.entry.enqueuedAt) || a.index - b.index,
    )
    .map((item) => item.entry);
  const keyOf = (entry: { program: ProgramId; upTo: CommitSha }) =>
    `${entry.program}:${entry.upTo}`;
  const taken = new Set<LineQueueEntry>();
  const units: Unit[] = [];
  const position = (entry: LineQueueEntry) => entries.indexOf(entry);
  for (const item of released) {
    const keys = new Set(item.entries.map(keyOf));
    const mine = entries.filter((entry) => keys.has(keyOf(entry)) && !taken.has(entry));
    if (mine.length === 0) continue;
    for (const entry of mine) taken.add(entry);
    units.push({
      program: item.range.program,
      entries: mine,
      repairs: Math.max(0, ...mine.map((entry) => entry.repairs ?? 0)),
      released: item,
      first: Math.min(...mine.map(position)),
    });
  }
  const plain = new Map<ProgramId, Unit>();
  for (const entry of entries) {
    if (taken.has(entry)) continue;
    if ((entry.repairs ?? 0) > 0) {
      units.push({
        program: entry.program,
        entries: [entry],
        repairs: entry.repairs ?? 0,
        first: position(entry),
      });
      continue;
    }
    const unit = plain.get(entry.program) ?? {
      program: entry.program,
      entries: [],
      repairs: 0,
      first: position(entry),
    };
    unit.entries.push(entry);
    plain.set(entry.program, unit);
    if (!units.includes(unit)) units.push(unit);
  }
  units.sort((a, b) => a.first - b.first);

  const chain = new Map<ProgramId, CommitSha | undefined>();
  const grouped: Grouped[] = [];
  for (const unit of units) {
    let upTo: CommitSha;
    if (unit.released) {
      upTo = unit.released.range.upTo;
    } else {
      const commits = unit.entries.map((entry) => entry.upTo);
      // The head is the entry that descends from every other; only diverged
      // history falls back to the newest by enqueue time.
      let last: CommitSha | undefined;
      for (const candidate of commits) {
        let holdsAll = true;
        for (const other of commits) {
          if (other !== candidate && !(await ports.checkout.isAncestor(other, candidate))) {
            holdsAll = false;
            break;
          }
        }
        if (holdsAll) {
          last = candidate;
          break;
        }
      }
      upTo = last ?? (commits.at(-1) as CommitSha);
    }
    const from = chain.has(unit.program)
      ? chain.get(unit.program)
      : await ports.queue.lastComposed(unit.program);
    // A parked (spent) range is not on the line, so the next one does not follow it.
    if (unit.released?.owner.state !== "spent") chain.set(unit.program, upTo);
    if (await ports.checkout.isAncestor(upTo, lineHead)) continue;
    const repaired =
      unit.released?.range.repaired ??
      unit.entries.find((entry) => entry.repairs === unit.repairs && entry.repaired)?.repaired;
    grouped.push({
      range: withRepairs(
        {
          program: unit.program,
          ...(from === undefined ? {} : { from }),
          upTo,
          ...(repaired === undefined ? {} : { repaired }),
        },
        unit.repairs,
      ),
      entries: unit.entries,
    });
  }
  return grouped;
};

/** One range's chain of repairs: the range, any repair of its repair, and the paths they reserve. */
interface Lineage {
  range: LineRange;
  /** Repairs spent, the one queued or in flight included. */
  repairs: number;
  /** The commit whose merge failed: the range's own, or a repair's. */
  commit: CommitSha;
  paths: Set<string>;
  state: "queued" | "running" | "repaired" | "spent";
  fresh: boolean;
  cause: LineRepairCause;
  causePaths: string[];
  checks: LineCommandLog[];
  candidate: CommitSha;
  lineHead: CommitSha;
  landedFrom: number;
  /** The successful repair; `repair` is absent when recovered from a queue entry. */
  repaired?: { commit: CommitSha; repair?: LineRepairRef };
  lastWords?: string;
  lastRepair?: LineRepairRef;
}

interface HeldItem {
  range: LineRange;
  entries: LineQueueEntry[];
  owner: Lineage;
}

export interface LineStep {
  /** Present when a batch was taken and composed. */
  outcome?: LineBatchOutcome;
  /** No repair in flight and nothing held. */
  idle: boolean;
}

export interface LineComposer {
  /** Takes and composes one batch, if there is one; folds in any repair that settled. */
  step(): Promise<LineStep>;
  /** Steps until there is no batch to take; a rejected push ends it early. Does not wait for a repair. */
  drain(): Promise<LineBatchOutcome[]>;
  /**
   * No repair in flight, none waiting to start, nothing held, and recovery done.
   * False on a fresh composer until its first take (see `needsRecovery`).
   */
  idle(): boolean;
  /**
   * True until the first take: a fresh composer (a restart in the same
   * generation, or a new owner) may find held work on the plane. The host calls
   * `drain()` or `step()` at least once while this is true; the first take
   * releases every held entry the composer holds no reservation for (read through
   * `queue.heldEntries`), so they are composed afresh, with their `repairs` kept.
   */
  needsRecovery(): boolean;
  /** Resolves when the repair in flight (if any) has answered. */
  repairSettled(): Promise<void>;
}

export const createLineComposer = (
  ports: LineComposerPorts,
  heads: () => Promise<{ lineHead: CommitSha; mainHead: CommitSha }>,
): LineComposer => {
  const { checkout, verifier, queue, publisher, clock } = ports;
  const lineages: Lineage[] = [];
  let held: HeldItem[] = [];
  let running: Lineage | undefined;
  let inflight: Promise<void> | undefined;
  const done: { lineage: Lineage; outcome: RepairOutcome }[] = [];
  const recent: LineRepairRequest["recentRepairs"] = [];
  const landed: LineRange[] = [];
  /** Held items released to the queue, until the batch that carries them settles. */
  const pendingRelease: HeldItem[] = [];
  /** Repaired lineages whose composition is awaiting its push; kept until it is published. */
  const awaiting = new Set<Lineage>();

  let recovered = false;

  const idle = (): boolean =>
    recovered &&
    running === undefined &&
    done.length === 0 &&
    lineages.length === 0 &&
    held.length === 0;

  const dropLineage = (lineage: Lineage): void => {
    const at = lineages.indexOf(lineage);
    if (at >= 0) lineages.splice(at, 1);
  };

  const requestOf = (lineage: Lineage): LineRepairRequest => ({
    cause: lineage.cause,
    range: withRepairs(lineage.range, lineage.repairs),
    base: lineage.candidate,
    lineHead: lineage.lineHead,
    paths: lineage.causePaths,
    held: held.map((item) => item.range),
    checks: lineage.checks,
    landedSince: landed.slice(lineage.landedFrom),
    recentRepairs: recent.slice(-RECENT_REPAIRS),
    attempt: lineage.repairs,
  });

  const launch = (lineage: Lineage): void => {
    lineage.state = "running";
    running = lineage;
    const request = requestOf(lineage);
    inflight = (async () => {
      let outcome: RepairOutcome;
      try {
        outcome = await ports.repair(request);
      } catch (error) {
        outcome = { kind: "failed", words: `the repair threw: ${messageOf(error)}` };
      }
      done.push({ lineage, outcome });
    })();
  };

  /** A candidate commit of `commit` merged onto the worktree's head: the red merge, or the conflict with markers. */
  const candidateOf = async (
    wt: LineWorktree,
    commit: CommitSha,
    message: string,
  ): Promise<
    | { kind: "merged"; candidate: CommitSha }
    | { kind: "conflict"; candidate: CommitSha; paths: string[] }
  > => {
    const merged = await checkout.merge(wt, commit, message);
    if (merged.kind === "merged") return { kind: "merged", candidate: merged.head };
    const candidate = await checkout.conflictCandidate(wt, commit, message);
    return { kind: "conflict", candidate, paths: merged.paths };
  };

  const startNext = async (): Promise<void> => {
    if (running !== undefined) return;
    const next = lineages.find((lineage) => lineage.state === "queued");
    if (next === undefined) return;
    if (next.fresh) {
      const { lineHead } = await heads();
      const wt = await checkout.open(lineHead);
      try {
        const made = await candidateOf(wt, next.commit, `Candidate for ${rangeLabel(next.range)}`);
        next.candidate = made.candidate;
        next.lineHead = lineHead;
        if (made.kind === "conflict") {
          next.cause = "line_conflict";
          next.causePaths = made.paths;
          next.checks = [];
          for (const path of made.paths) next.paths.add(path);
        }
        next.fresh = false;
      } finally {
        await checkout.close(wt);
      }
    }
    launch(next);
  };

  /** Folds in the repairs that answered; returns the entries to release to the queue. */
  const processDone = async (): Promise<{ program: ProgramId; upTo: CommitSha }[]> => {
    const release: HeldItem[] = [];
    for (const { lineage, outcome } of done.splice(0)) {
      if (running === lineage) {
        running = undefined;
        inflight = undefined;
      }
      recent.push({
        range: withRepairs(lineage.range, lineage.repairs),
        cause: lineCauseText({ ...lineage, paths: lineage.causePaths }),
        outcome: outcome.kind === "repaired" ? "repaired" : "failed",
        ...(outcome.kind === "failed" ? { words: outcome.words } : {}),
      });
      if (outcome.repair !== undefined) lineage.lastRepair = outcome.repair;
      if (outcome.kind === "repaired") {
        lineage.state = "repaired";
        lineage.repaired = { commit: outcome.commit, repair: outcome.repair };
      } else {
        lineage.lastWords = outcome.words;
        if (lineage.repairs >= MAX_LINE_REPAIRS) {
          lineage.state = "spent";
        } else {
          lineage.repairs += 1;
          lineage.state = "queued";
          lineage.fresh = true;
        }
      }
      if (lineage.state === "repaired" || lineage.state === "spent") {
        release.push(...held.filter((item) => item.owner === lineage));
      }
    }
    await startNext();
    const names = new Set(release);
    held = held.filter((item) => !names.has(item));
    pendingRelease.push(...release);
    return pendingRelease.flatMap((item) =>
      item.entries.map((entry) => ({ program: entry.program, upTo: entry.upTo })),
    );
  };

  const composeBatch = async (
    batch: LineBatch,
    lineHead: CommitSha,
    mainHead: CommitSha,
  ): Promise<LineBatchOutcome> => {
    const deadlineMs = clock.now() + (ports.limits?.seconds ?? LINE_COMPOSITION_SECONDS) * 1000;
    const deadline = new Date(deadlineMs).toISOString();
    const passed = () => clock.now() >= deadlineMs;
    const outcome: LineBatchOutcome = {
      batchId: batch.batchId,
      head: lineHead,
      composed: [],
      parked: [],
    };
    const parkedParts: ParkPart[] = [];
    const newHeld: HeldItem[] = [];
    /** Ranges whose repair commit this machine does not have, with what to say of it. */
    const missing = new Map<string, string>();
    const rangeKey = (range: LineRange) => `${range.program}:${range.upTo}`;
    const park = (range: LineRange, reason: string, extra: Partial<ParkPart> = {}) => {
      const note = missing.get(rangeKey(range));
      const said = note === undefined ? reason : `${reason}; ${note}`;
      const { repaired: _kept, ...plain } = range;
      parkedParts.push({ ranges: [plain], reason: said, ...extra });
      outcome.parked.push({ ranges: [plain], reason: said });
    };
    awaiting.clear();
    const composedRange = (range: LineRange, own: Lineage | undefined): LineRange => {
      if (!own) return range;
      awaiting.add(own);
      const spent = withRepairs(range, own.repairs);
      return own.repaired === undefined ? spent : { ...spent, repaired: own.repaired.commit };
    };
    const entriesByRange = new Map<LineRange, LineQueueEntry[]>();
    const entriesOf = (range: LineRange, repairs: number): LineQueueEntry[] =>
      (entriesByRange.get(range) ?? []).map(({ repairs: _old, repaired: _stale, ...entry }) =>
        repairs > 0 ? { ...entry, repairs } : entry,
      );

    const finish = async (settlement: Omit<LineSettlement, "batchId" | "parked" | "held">) => {
      const heldEntries = newHeld.flatMap((item) => item.entries);
      await queue.settle({
        batchId: batch.batchId,
        ...settlement,
        parked: parkedParts,
        ...(heldEntries.length === 0 ? {} : { held: heldEntries }),
      });
      held.push(...newHeld);
      // A released lineage whose unit this batch has handled (composed, parked or held behind another) is over.
      for (const item of pendingRelease.splice(0)) {
        if (awaiting.has(item.owner)) continue;
        if (item.owner.state === "repaired" || item.owner.state === "spent") {
          dropLineage(item.owner);
        }
      }
    };

    const grouped = await groupRanges(ports, lineHead, batch, [...pendingRelease]);
    const ranges = grouped.map((item) => item.range);
    for (const item of grouped) entriesByRange.set(item.range, item.entries);
    if (ranges.length === 0) {
      await finish({});
      return outcome;
    }

    const lineageFor = (range: LineRange): Lineage | undefined =>
      lineages.find(
        (lineage) =>
          lineage.range.program === range.program &&
          lineage.range.upTo === range.upTo &&
          (lineage.state === "repaired" || lineage.state === "spent"),
      );

    const lineageOf = lineageFor;
    // A range that arrives with its repair commit (requeued after a rejected push, or
    // recovered by a new generation) composes that commit first, spending no repair.
    for (const range of ranges) {
      const repairedCommit = range.repaired;
      if (repairedCommit === undefined || lineageFor(range) !== undefined) continue;
      if (checkout.hasCommit !== undefined && !(await checkout.hasCommit(repairedCommit))) {
        delete range.repaired;
        const say = `${rangeLabel(range)}: the repair commit ${repairedCommit} was not present locally; composing the original range`;
        outcome.notes = [...(outcome.notes ?? []), say];
        missing.set(
          rangeKey(range),
          `the repair commit ${repairedCommit} was not present locally, so the original range was composed`,
        );
        continue;
      }
      const { repaired: _repaired, ...plainRange } = range;
      const lineage: Lineage = {
        range: plainRange,
        repairs: range.repairs ?? 0,
        commit: repairedCommit,
        paths: new Set(),
        state: "repaired",
        fresh: false,
        cause: "line_conflict",
        causePaths: [],
        checks: [],
        candidate: repairedCommit,
        lineHead,
        landedFrom: landed.length,
        repaired: { commit: repairedCommit },
      };
      lineages.push(lineage);
    }

    const mainMessage = `Merge main ${mainHead} into the line`;
    const rangeMessage = (range: LineRange) => `Merge program ${rangeLabel(range)} into the line`;
    const pathCache = new Map<string, string[]>();
    const pathsOf = async (range: LineRange, at: CommitSha): Promise<string[]> => {
      const key = `${range.program}:${range.from ?? ""}:${range.upTo}`;
      const known = pathCache.get(key);
      if (known) return known;
      const found = await checkout.changedPaths(range.from, range.upTo, at);
      pathCache.set(key, found);
      return found;
    };
    /** The lineage whose reservation `range` touches, if any (its own excluded). */
    const reservedBy = async (range: LineRange, at: CommitSha): Promise<Lineage | undefined> => {
      const others = lineages.filter(
        (lineage) => lineage.state === "queued" || lineage.state === "running",
      );
      if (others.length === 0) return undefined;
      // A descendant of a range under repair would bring in its unrepaired content.
      for (const lineage of others) {
        if (
          lineage.range.program === range.program &&
          lineage.range.upTo !== range.upTo &&
          (await checkout.isAncestor(lineage.range.upTo, range.upTo))
        ) {
          return lineage;
        }
      }
      const paths = await pathsOf(range, at);
      return others.find((lineage) => paths.some((path) => lineage.paths.has(path)));
    };
    const holdBehind = (range: LineRange, owner: Lineage) => {
      newHeld.push({ range, entries: entriesOf(range, range.repairs ?? 0), owner });
    };

    const settleComposed = async (
      composition: NonNullable<LineSettlement["composition"]>,
    ): Promise<void> => {
      const { bundleKey } = await publisher.stage({
        head: composition.commit,
        expectedPredecessor: composition.parent,
      });
      await finish({
        composition,
        push: { head: composition.commit, expectedPredecessor: composition.parent, bundleKey },
      });
    };
    const awaitPush = async (head: CommitSha, composed: LineRange[]): Promise<LineBatchOutcome> => {
      const result = await publisher.outcome({ head });
      outcome.published =
        result.status === "published"
          ? { status: result.status }
          : { status: result.status, detail: result.detail };
      // The repaired lineages keep their commit and reservation until the line has it.
      const unpublished = [...awaiting];
      awaiting.clear();
      if (result.status === "published") {
        outcome.head = head;
        landed.push(...composed);
        for (const lineage of unpublished) dropLineage(lineage);
      }
      return outcome;
    };

    // Ranges held behind a reservation never join the composition.
    const special = ranges.filter((range) => lineageOf(range) !== undefined);
    const ordinary: LineRange[] = [];
    for (const range of ranges) {
      if (special.includes(range)) continue;
      const owner = await reservedBy(range, lineHead);
      if (owner) holdBehind(range, owner);
      else ordinary.push(range);
    }

    // The batch attempt: everything merged together and verified once.
    if (special.length === 0 && ordinary.length > 0) {
      let wt: LineWorktree | undefined;
      try {
        wt = await checkout.open(lineHead);
        let merged = (await checkout.merge(wt, mainHead, mainMessage)).kind === "merged";
        for (const range of ordinary) {
          if (!merged) break;
          merged = (await checkout.merge(wt, range.upTo, rangeMessage(range))).kind === "merged";
        }
        if (merged) {
          const head = await checkout.head(wt);
          const result = await verifier.verify({
            worktree: wt,
            commit: head,
            base: lineHead,
            deadline,
          });
          if (result.timedOut || passed()) {
            for (const range of ordinary) park(range, TIME_LIMIT_REASON);
            await finish({});
            return outcome;
          }
          if (result.verification.outcome === "passed") {
            outcome.composed = ordinary;
            await settleComposed({
              commit: head,
              parent: lineHead,
              ranges: ordinary,
              verification: result.verification,
            });
            return await awaitPush(head, ordinary);
          }
        }
      } finally {
        if (wt) await checkout.close(wt);
      }
    }

    if (passed()) {
      for (const range of ordinary) park(range, TIME_LIMIT_REASON);
      await finish({});
      return outcome;
    }

    if (special.length === 0 && ordinary.length === 0) {
      await finish({});
      return outcome;
    }

    // The fallback: one unit at a time. A lineage's own unit goes first.
    const units: LineRange[] = [
      ...special.filter((range) => lineageOf(range)?.state === "spent"),
      ...special.filter((range) => lineageOf(range)?.state === "repaired"),
      ...ordinary,
    ];
    let head = lineHead;
    let headVerification: LineVerification | undefined;
    let lastRepair: LineRepairRef | undefined;
    const composed: LineRange[] = [];
    let current: LineWorktree | undefined;
    const reopen = async (at: CommitSha) => {
      if (current) {
        const old = current;
        current = undefined;
        await checkout.close(old);
      }
      current = await checkout.open(at);
      return current;
    };

    try {
      await reopen(lineHead);
      const mainResult = await checkout.merge(current as LineWorktree, mainHead, mainMessage);
      let mainParked = false;
      if (mainResult.kind === "conflict") {
        mainParked = true;
      } else if (mainResult.head !== head) {
        const result = await verifier.verify({
          worktree: current as LineWorktree,
          commit: mainResult.head,
          base: head,
          deadline,
        });
        if (result.timedOut || passed()) {
          for (const range of units) park(range, TIME_LIMIT_REASON);
          await finish({});
          return outcome;
        }
        if (result.verification.outcome === "passed") {
          head = mainResult.head;
          headVerification = result.verification;
        } else {
          mainParked = true;
        }
      }
      if (mainParked) {
        for (const range of units) {
          park(range, "main does not compose onto the line");
        }
        await finish({});
        return outcome;
      }

      for (let i = 0; i < units.length; i++) {
        const range = units[i] as LineRange;
        const own = lineageOf(range);
        if (own?.state === "spent") {
          const reason = `${lineCauseText({ ...own, paths: own.causePaths })}; ${own.repairs} repairs were spent; the last repair failed: ${own.lastWords ?? "(no words)"}`;
          park(withRepairs(range, own.repairs), reason, {
            ...(own.lastRepair === undefined ? {} : { repair: own.lastRepair }),
          });
          dropLineage(own);
          continue;
        }
        if (!own) {
          const owner = await reservedBy(range, head);
          if (owner) {
            holdBehind(range, owner);
            continue;
          }
        }
        if (passed()) {
          for (const rest of units.slice(i)) park(rest, TIME_LIMIT_REASON);
          break;
        }
        const commit = own?.repaired?.commit ?? range.upTo;
        const worktree = current as LineWorktree;
        const merged = await checkout.merge(worktree, commit, rangeMessage(range));
        let failure:
          | { cause: "line_conflict"; paths: string[]; checks: LineCommandLog[] }
          | { cause: "line_red"; candidate: CommitSha; checks: LineCommandLog[] }
          | undefined;
        if (merged.kind === "conflict") {
          failure = { cause: "line_conflict", paths: merged.paths, checks: [] };
        } else if (merged.head === head) {
          composed.push(composedRange(range, own));
          if (own) lastRepair = own.repaired?.repair ?? lastRepair;
          continue;
        } else {
          const result = await verifier.verify({
            worktree,
            commit: merged.head,
            base: head,
            deadline,
          });
          if (result.timedOut || passed()) {
            for (const rest of units.slice(i)) park(rest, TIME_LIMIT_REASON);
            break;
          }
          if (result.verification.outcome === "passed") {
            head = merged.head;
            headVerification = result.verification;
            composed.push(composedRange(range, own));
            if (own) lastRepair = own.repaired?.repair ?? lastRepair;
            continue;
          }
          failure = { cause: "line_red", candidate: merged.head, checks: result.logs };
        }

        // The unit failed: a repair, unless its lineage has spent the budget.
        const prior = own?.repairs ?? range.repairs ?? 0;
        const rangePaths = await pathsOf(range, head);
        const causePaths = failure.cause === "line_conflict" ? failure.paths : rangePaths;
        if (prior >= MAX_LINE_REPAIRS) {
          const reason = `${lineCauseText({ cause: failure.cause, paths: causePaths, checks: failure.checks })}; the lineage has spent its ${MAX_LINE_REPAIRS} repairs${own?.lastWords === undefined ? "" : `; the last repair failed: ${own.lastWords}`}`;
          park(withRepairs(range, prior), reason, {
            ...(own?.lastRepair === undefined ? {} : { repair: own.lastRepair }),
          });
          if (own) dropLineage(own);
          await reopen(head);
          continue;
        }
        const candidate =
          failure.cause === "line_red"
            ? failure.candidate
            : await checkout.conflictCandidate(
                worktree,
                commit,
                `Candidate for ${rangeLabel(range)}`,
              );
        const lineage: Lineage = own ?? {
          range,
          repairs: 0,
          commit,
          paths: new Set(),
          state: "queued",
          fresh: false,
          cause: failure.cause,
          causePaths,
          checks: failure.checks,
          candidate,
          lineHead: head,
          landedFrom: landed.length,
        };
        if (!own) lineages.push(lineage);
        lineage.state = "queued";
        lineage.repairs = prior + 1;
        lineage.commit = commit;
        lineage.cause = failure.cause;
        lineage.causePaths = causePaths;
        lineage.checks = failure.checks;
        lineage.candidate = candidate;
        lineage.lineHead = head;
        lineage.fresh = false;
        delete lineage.repaired;
        for (const path of [...rangePaths, ...causePaths]) lineage.paths.add(path);
        newHeld.push({
          range: withRepairs(range, lineage.repairs),
          entries: entriesOf(range, lineage.repairs),
          owner: lineage,
        });
        await reopen(head);
      }
    } finally {
      if (current) await checkout.close(current);
    }

    if (composed.length === 0 || headVerification === undefined) {
      await finish({});
      await startNext();
      return outcome;
    }
    outcome.composed = composed;
    await settleComposed({
      commit: head,
      parent: lineHead,
      ranges: composed,
      verification: headVerification,
      ...(lastRepair === undefined ? {} : { repair: lastRepair }),
    });
    await startNext();
    return awaitPush(head, composed);
  };

  const step = async (): Promise<LineStep> => {
    const release = await processDone();
    if (!recovered) {
      const key = (entry: { program: ProgramId; upTo: CommitSha }) =>
        `${entry.program}:${entry.upTo}`;
      const reserved = new Set(
        [...held, ...pendingRelease].flatMap((item) => item.entries).map(key),
      );
      for (const entry of release) reserved.add(key(entry));
      for (const entry of (await queue.heldEntries?.()) ?? []) {
        if (reserved.has(key(entry))) continue;
        reserved.add(key(entry));
        release.push({ program: entry.program, upTo: entry.upTo });
      }
    }
    const batch = await queue.takeBatch(release.length > 0 ? release : undefined);
    recovered = true;
    if (batch === undefined) {
      // Nothing came back for what was released: those lineages are over.
      for (const item of pendingRelease.splice(0)) dropLineage(item.owner);
      // A repaired lineage whose composition was rejected and never came back is over.
      for (const lineage of lineages.filter((l) => l.state === "repaired")) dropLineage(lineage);
      return { idle: idle() };
    }
    const { lineHead, mainHead } = await heads();
    const outcome = await composeBatch(batch, lineHead, mainHead);
    return { outcome, idle: idle() };
  };

  return {
    step,
    idle,
    needsRecovery: () => !recovered,
    repairSettled: async () => {
      await inflight;
    },
    async drain() {
      const outcomes: LineBatchOutcome[] = [];
      for (;;) {
        const result = await step();
        if (result.outcome === undefined) return outcomes;
        outcomes.push(result.outcome);
        if (result.outcome.published?.status === "rejected") return outcomes;
      }
    },
  };
};
