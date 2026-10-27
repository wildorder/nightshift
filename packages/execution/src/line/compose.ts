import type {
  CommitSha,
  LineBatch,
  LineRange,
  LineResolver,
  LineVerification,
  ProgramId,
} from "@nightshift/contracts";
import { LINE_COMPOSITION_SECONDS, LINE_RESOLVER_ATTEMPTS } from "@nightshift/core";
import type {
  LineBatchOutcome,
  LineComposerPorts,
  LineFailure,
  LineResolution,
  LineSettlement,
  LineUnit,
  LineWorktree,
} from "./ports.js";

type ParkPart = LineSettlement["parked"][number];

const rangeLabel = (range: LineRange): string =>
  `${range.program} ${range.from ?? "(start)"}..${range.upTo}`;

const unitLabel = (unit: LineUnit): string =>
  unit.kind === "main" ? `main ${unit.commit}` : rangeLabel(unit.range);

const TIME_LIMIT_REASON = "the composition's time limit passed before this range could be composed";

const groupRanges = async (
  ports: LineComposerPorts,
  lineHead: CommitSha,
  batch: LineBatch,
): Promise<LineRange[]> => {
  const entries = batch.entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Date.parse(a.entry.enqueuedAt) - Date.parse(b.entry.enqueuedAt) || a.index - b.index,
    )
    .map((item) => item.entry);
  // Programs keep the order of their earliest entry.
  const byProgram = new Map<ProgramId, CommitSha[]>();
  for (const entry of entries) {
    const commits = byProgram.get(entry.program) ?? [];
    commits.push(entry.upTo);
    byProgram.set(entry.program, commits);
  }
  const upTo = new Map<ProgramId, CommitSha>();
  for (const [program, commits] of byProgram) {
    // The head is the entry that descends from every other; only diverged
    // history falls back to the newest by enqueue time.
    let head: CommitSha | undefined;
    for (const candidate of commits) {
      let holdsAll = true;
      for (const other of commits) {
        if (other !== candidate && !(await ports.checkout.isAncestor(other, candidate))) {
          holdsAll = false;
          break;
        }
      }
      if (holdsAll) {
        head = candidate;
        break;
      }
    }
    upTo.set(program, head ?? (commits.at(-1) as CommitSha));
  }
  const ranges: LineRange[] = [];
  for (const [program, last] of upTo) {
    if (await ports.checkout.isAncestor(last, lineHead)) continue;
    const from = await ports.queue.lastComposed(program);
    ranges.push({
      program,
      ...(from === undefined ? {} : { from }),
      upTo: last,
    });
  }
  return ranges;
};

export const composeLineBatch = async (
  ports: LineComposerPorts,
  input: { lineHead: CommitSha; mainHead: CommitSha; batch: LineBatch },
): Promise<LineBatchOutcome> => {
  const { lineHead, mainHead, batch } = input;
  const { checkout, verifier, queue, publisher, clock } = ports;
  let attemptsLeft = ports.limits?.attempts ?? LINE_RESOLVER_ATTEMPTS;
  const deadlineMs = clock.now() + (ports.limits?.seconds ?? LINE_COMPOSITION_SECONDS) * 1000;
  const deadline = new Date(deadlineMs).toISOString();
  const passed = () => clock.now() >= deadlineMs;
  const outcome: LineBatchOutcome = {
    batchId: batch.batchId,
    head: lineHead,
    composed: [],
    parked: [],
    resolutions: [],
  };

  const ranges = await groupRanges(ports, lineHead, batch);
  if (ranges.length === 0) {
    await queue.settle({ batchId: batch.batchId, parked: [] });
    return outcome;
  }

  const parkedParts: ParkPart[] = [];
  const park = (
    range: LineRange[],
    reason: string,
    extra: Partial<Omit<ParkPart, "ranges" | "reason">> = {},
  ) => {
    parkedParts.push({ ranges: range, reason, ...extra });
    outcome.parked.push({ ranges: range, reason });
  };
  const parkAll = (list: LineRange[], reason: string) => {
    for (const range of list) park([range], reason);
  };
  const finishNothing = async (): Promise<LineBatchOutcome> => {
    await queue.settle({ batchId: batch.batchId, parked: parkedParts });
    return outcome;
  };

  const mainMessage = `Merge main ${mainHead} into the line`;
  const rangeMessage = (range: LineRange) => `Merge program ${rangeLabel(range)} into the line`;

  // The batch attempt: everything merged together and verified once.
  let wt: LineWorktree | undefined;
  try {
    wt = await checkout.open(lineHead);
    let merged = true;
    const first = await checkout.merge(wt, mainHead, mainMessage);
    if (first.kind !== "merged") merged = false;
    for (const range of ranges) {
      if (!merged) break;
      const step = await checkout.merge(wt, range.upTo, rangeMessage(range));
      if (step.kind !== "merged") merged = false;
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
        parkAll(ranges, TIME_LIMIT_REASON);
        return await finishNothing();
      }
      if (result.verification.outcome === "passed") {
        outcome.composed = ranges;
        await settleComposed(
          {
            commit: head,
            parent: lineHead,
            ranges,
            verification: result.verification,
          },
          [],
        );
        return await awaitPush(head);
      }
    }
  } finally {
    if (wt) await checkout.close(wt);
  }

  // Stage first (a throw settles nothing and leaves the batch held), then settle with the push.
  async function settleComposed(
    composition: NonNullable<LineSettlement["composition"]>,
    parked: ParkPart[],
  ): Promise<void> {
    const { bundleKey } = await publisher.stage({
      head: composition.commit,
      expectedPredecessor: composition.parent,
    });
    await queue.settle({
      batchId: batch.batchId,
      composition,
      parked,
      push: {
        head: composition.commit,
        expectedPredecessor: composition.parent,
        bundleKey,
      },
    });
  }

  async function awaitPush(head: CommitSha): Promise<LineBatchOutcome> {
    const result = await publisher.outcome({ head });
    outcome.published =
      result.status === "published"
        ? { status: result.status }
        : { status: result.status, detail: result.detail };
    if (result.status === "published") outcome.head = head;
    return outcome;
  }

  // The fallback: one unit at a time.
  if (passed()) {
    parkAll(ranges, TIME_LIMIT_REASON);
    return finishNothing();
  }

  let head = lineHead;
  let headVerification: LineVerification | undefined;
  let lastFix: { resolver: LineResolver; resolution: LineResolution } | undefined;
  const fixedUnits: string[] = [];
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

    const resolveUnit = async (unit: LineUnit, cause: LineFailure["cause"]) => {
      if (attemptsLeft <= 0) {
        return {
          kind: "parked",
          reason: "the composition's resolver attempts are spent",
          resolver: { decision: "gave_up", attempts: 0 },
        } satisfies LineResolution;
      }
      const failure: LineFailure = {
        unit,
        base: head,
        deadline,
        attemptsLeft,
        cause,
      };
      const resolution = await ports.resolve(failure);
      attemptsLeft -= resolution.resolver.attempts;
      outcome.resolutions.push(resolution);
      return resolution;
    };

    // Merges and verifies one unit onto the current head. Returns the
    // resolution when the unit failed, "time" when the limit stopped it.
    const compose = async (
      unit: LineUnit,
      commit: CommitSha,
      message: string,
    ): Promise<
      { kind: "ok" } | { kind: "time" } | { kind: "failed"; resolution: LineResolution }
    > => {
      if (passed()) return { kind: "time" };
      const worktree = current as LineWorktree;
      const merged = await checkout.merge(worktree, commit, message);
      if (merged.kind === "conflict") {
        const resolution = await resolveUnit(unit, {
          kind: "conflict",
          paths: merged.paths,
          detail: merged.detail,
        });
        return { kind: "failed", resolution };
      }
      if (merged.head === head) return { kind: "ok" };
      const result = await verifier.verify({
        worktree,
        commit: merged.head,
        base: head,
        deadline,
      });
      if (result.timedOut) return { kind: "time" };
      if (result.verification.outcome === "passed") {
        head = merged.head;
        headVerification = result.verification;
        return { kind: "ok" };
      }
      if (passed()) return { kind: "time" };
      const resolution = await resolveUnit(unit, {
        kind: "red",
        candidate: merged.head,
        verification: result.verification,
        logs: result.logs,
      });
      return { kind: "failed", resolution };
    };

    // Applies a failed unit's resolution; true when the unit now counts as composed.
    const apply = async (unit: LineUnit, resolution: LineResolution, parkRange: LineRange[]) => {
      if (resolution.kind === "resolved") {
        head = resolution.commit;
        headVerification = resolution.verification;
        fixedUnits.push(unitLabel(unit));
        lastFix = { resolver: resolution.resolver, resolution };
        await reopen(head);
        return true;
      }
      if (parkRange.length > 0)
        park(parkRange, resolution.reason, {
          resolver: resolution.resolver,
          ...(resolution.commit === undefined ? {} : { commit: resolution.commit }),
          ...(resolution.verification === undefined
            ? {}
            : { verification: resolution.verification }),
        });
      await reopen(head);
      return false;
    };

    const mainUnit: LineUnit = { kind: "main", commit: mainHead };
    const mainResult = await compose(mainUnit, mainHead, mainMessage);
    let mainParked = false;
    if (mainResult.kind === "time") {
      parkAll(ranges, TIME_LIMIT_REASON);
      mainParked = true;
    } else if (mainResult.kind === "failed") {
      const ok = await apply(mainUnit, mainResult.resolution, []);
      if (!ok) {
        const why =
          mainResult.resolution.kind === "parked" ? `: ${mainResult.resolution.reason}` : "";
        parkAll(ranges, `main does not compose onto the line${why}`);
        mainParked = true;
      }
    }

    for (let i = 0; i < ranges.length && !mainParked; i++) {
      const range = ranges[i] as LineRange;
      const unit: LineUnit = { kind: "range", range };
      const result = await compose(unit, range.upTo, rangeMessage(range));
      if (result.kind === "time") {
        parkAll(ranges.slice(i), TIME_LIMIT_REASON);
        break;
      }
      if (result.kind === "ok") {
        composed.push(range);
        continue;
      }
      if (await apply(unit, result.resolution, [range])) composed.push(range);
    }
  } finally {
    if (current) await checkout.close(current);
  }

  if (composed.length === 0 || headVerification === undefined) return finishNothing();

  outcome.composed = composed;
  const fix = lastFix as { resolver: LineResolver; resolution: LineResolution } | undefined;
  const resolver: LineResolver | undefined = fix && {
    decision: "resolved",
    attempts: fix.resolver.attempts,
    detail: `the resolver fixed ${fixedUnits.join("; ")}`,
  };
  await settleComposed(
    {
      commit: head,
      parent: lineHead,
      ranges: composed,
      verification: headVerification,
      ...(resolver ? { resolver } : {}),
    },
    parkedParts,
  );
  return awaitPush(head);
};

export const drainLine = async (
  ports: LineComposerPorts,
  heads: () => Promise<{ lineHead: CommitSha; mainHead: CommitSha }>,
): Promise<LineBatchOutcome[]> => {
  const outcomes: LineBatchOutcome[] = [];
  for (;;) {
    const batch = await ports.queue.takeBatch();
    if (batch === undefined) return outcomes;
    const { lineHead, mainHead } = await heads();
    const outcome = await composeLineBatch(ports, {
      lineHead,
      mainHead,
      batch,
    });
    outcomes.push(outcome);
    if (outcome.published?.status === "rejected") return outcomes;
  }
};
