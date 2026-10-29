/**
 * The seams of the line composition engine.
 *
 * Everything the composer and the verifier touch arrives through
 * these ports: git, the queue, the publisher, the repair, the clock. Nothing here imports from `apps/` or the plane's stores. Agents
 * never write git state; Nightshift owns every commit, which is why a merge is
 * started by `startMerge` and finished by the engine's `commitMerge`.
 */
import type {
  CommitSha,
  LineBatch,
  LineCompositionBody,
  LineParkBody,
  LineQueueEntry,
  LineRange,
  LineRepairRef,
  LineVerification,
  ProgramId,
  TakeLineBatchBody,
} from "@nightshift/contracts";
import type { Clock } from "@nightshift/core";

export interface LineWorktree {
  readonly path: string;
}

export type LineMergeOutcome =
  | { kind: "merged"; head: CommitSha }
  | { kind: "conflict"; paths: string[]; detail: string };

export interface LineCheckoutPort {
  /** A fresh detached worktree at `base`. */
  open(base: CommitSha): Promise<LineWorktree>;
  /**
   * Always a real no-ff merge commit, except that an already-contained commit
   * gives `merged` at the unchanged head. On conflict the merge is aborted and
   * the worktree is left clean at its previous head.
   */
  merge(wt: LineWorktree, commit: CommitSha, message: string): Promise<LineMergeOutcome>;
  /**
   * `git merge --no-commit --no-ff`: leaves the merge in progress (MERGE_HEAD
   * set) and any conflicts in the working tree, for an agent to edit.
   */
  startMerge(
    wt: LineWorktree,
    commit: CommitSha,
  ): Promise<{ kind: "clean" } | { kind: "conflict"; paths: string[] }>;
  /**
   * Engine-owned. Stages every change in the worktree, deletions and new files
   * included (not ignored ones), and commits the in-progress merge, so the
   * commit's parents are the previous head and the merged commit. Throws when no
   * merge is in progress or conflict markers are left unresolved in the index.
   */
  commitMerge(wt: LineWorktree, message: string): Promise<CommitSha>;
  /**
   * The candidate of a conflicting merge: `commit` merged onto the worktree's
   * head with every non-conflicting change applied and the conflict markers
   * left in the conflicting paths, committed as they are (parents: the head,
   * `commit`). The worktree is returned to its previous head.
   */
  conflictCandidate(wt: LineWorktree, commit: CommitSha, message: string): Promise<CommitSha>;
  /**
   * `git diff --name-only from..upTo`; with `from` absent, from the merge-base of
   * `upTo` and `lineHead` (the initial commit's empty tree when there is none).
   */
  changedPaths(
    from: CommitSha | undefined,
    upTo: CommitSha,
    lineHead?: CommitSha,
  ): Promise<string[]>;
  head(wt: LineWorktree): Promise<CommitSha>;
  isAncestor(ancestor: CommitSha, descendant: CommitSha): Promise<boolean>;
  /** Whether `commit` is present in the local repository (`git cat-file -e`); absent: assumed present. */
  hasCommit?(commit: CommitSha): Promise<boolean>;
  sameTree(a: CommitSha, b: CommitSha): Promise<boolean>;
  close(wt: LineWorktree): Promise<void>;
}

/** How much of a step's output a {@link LineCommandLog} keeps, from the end. */
export const LINE_LOG_TAIL_CHARS = 4000;

/**
 * The last {@link LINE_LOG_TAIL_CHARS} characters of a step's output.
 * Diagnostics: held in memory only, never persisted on the line record.
 */
export interface LineCommandLog {
  stepId: string;
  command: string;
  exitCode?: number;
  tail: string;
}

export interface LineVerificationResult {
  verification: LineVerification;
  logs: LineCommandLog[];
  timedOut: boolean;
}

/**
 * Verifies a commit on the line.
 *
 * CONTRACT:
 * (a) The verifier first returns the worktree to exactly `commit` with nothing
 *     else (`reset --hard` plus `clean -fdx`, as `pristineCheckout` in
 *     git/operations.ts does), so uncommitted, untracked or ignored files can
 *     never decide a verification.
 * (b) It starts no step after `deadline` and stops a step still running at it;
 *     the result then has `timedOut: true` and an outcome that is not `passed`.
 * (c) `verification.phase` is `line`.
 */
export interface LineVerifierPort {
  verify(input: {
    worktree: LineWorktree;
    commit: CommitSha;
    base: CommitSha;
    /** ISO timestamp. */
    deadline?: string;
  }): Promise<LineVerificationResult>;
}

export interface LineSettlement {
  batchId: string;
  composition?: Omit<LineCompositionBody, "batchId">;
  parked: Omit<LineParkBody, "batchId">[];
  /** Entries of the batch held back behind a repair, with their lineage's `repairs`. */
  held?: LineQueueEntry[];
  /** Present exactly when `composition` is: head = composition.commit, expectedPredecessor = composition.parent. */
  push?: { head: CommitSha; expectedPredecessor: CommitSha; bundleKey: string };
}

export interface LineQueuePort {
  takeBatch(release?: TakeLineBatchBody["release"]): Promise<LineBatch | undefined>;
  /**
   * The entries the plane holds back (the line record's `held`). A fresh composer
   * reads them once, before its first take, and releases those it holds no
   * reservation for. Absent: nothing is recovered beyond what the plane returns itself.
   */
  heldEntries?(): Promise<LineQueueEntry[]>;
  /** The `upTo` of that program's newest composed range. */
  lastComposed(program: ProgramId): Promise<CommitSha | undefined>;
  settle(settlement: LineSettlement): Promise<void>;
}

export interface LinePublisherPort {
  /** Makes the commits durable (e.g. uploads the bundle) before anything is settled. */
  stage(input: { head: CommitSha; expectedPredecessor: CommitSha }): Promise<{ bundleKey: string }>;
  /** Waits for the pending push of `head` to resolve. */
  outcome(input: {
    head: CommitSha;
  }): Promise<{ status: "published" } | { status: "rejected"; detail: string }>;
}

export type LineRepairCause = "line_conflict" | "line_red";

/** What a repair agent is asked to do; it starts from `base`, the candidate, and only resolves or fixes. */
export interface LineRepairRequest {
  cause: LineRepairCause;
  range: LineRange;
  /** The candidate commit: parents (line head, range.upTo). */
  base: CommitSha;
  lineHead: CommitSha;
  /** The conflicting paths, or the range's changed paths for a red check. */
  paths: string[];
  /** Ranges held back behind reserved paths. */
  held: LineRange[];
  /** The failing check output; red only. */
  checks: LineCommandLog[];
  /** Ranges composed on the line since this lineage's first failure. */
  landedSince: LineRange[];
  recentRepairs: {
    range: LineRange;
    cause: string;
    outcome: "repaired" | "failed";
    words?: string;
  }[];
  /** 1..3 within the lineage. */
  attempt: number;
}

export type RepairOutcome =
  | { kind: "repaired"; commit: CommitSha; repair: LineRepairRef }
  | { kind: "failed"; words: string; repair?: LineRepairRef };

export interface LineComposerPorts {
  queue: LineQueuePort;
  checkout: LineCheckoutPort;
  verifier: LineVerifierPort;
  publisher: LinePublisherPort;
  /** Started without being awaited; the composer keeps composing while it runs. */
  repair: (request: LineRepairRequest) => Promise<RepairOutcome>;
  clock: Clock;
  /** `seconds` defaults to core's `LINE_COMPOSITION_SECONDS`; one deadline per batch. */
  limits?: { seconds?: number };
}

export interface LineBatchOutcome {
  batchId: string;
  /** The line head after the batch. */
  head: CommitSha;
  composed: LineRange[];
  parked: { ranges: LineRange[]; reason: string }[];
  published?: { status: string; detail?: string };
  /** Things worth saying in the owner's log, e.g. a repair commit that was not present locally. */
  notes?: string[];
}
