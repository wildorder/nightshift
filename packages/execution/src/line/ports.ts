/**
 * The seams of the line composition engine.
 *
 * Everything the composer, the resolver and the verifier touch arrives through
 * these ports: git, the queue, the publisher, the agents, the decision store,
 * the clock. Nothing here imports from `apps/` or the plane's stores. Agents
 * never write git state; Nightshift owns every commit, which is why a merge is
 * started by `startMerge` and finished by the engine's `commitMerge`.
 */
import type {
  CommitSha,
  LineBatch,
  LineCompositionBody,
  LineParkBody,
  LineRange,
  LineResolver,
  LineVerification,
  ProgramId,
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
  head(wt: LineWorktree): Promise<CommitSha>;
  isAncestor(ancestor: CommitSha, descendant: CommitSha): Promise<boolean>;
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
  /** Present exactly when `composition` is: head = composition.commit, expectedPredecessor = composition.parent. */
  push?: { head: CommitSha; expectedPredecessor: CommitSha; bundleKey: string };
}

export interface LineQueuePort {
  takeBatch(): Promise<LineBatch | undefined>;
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

export type LineUnit = { kind: "main"; commit: CommitSha } | { kind: "range"; range: LineRange };

export interface LineFailure {
  unit: LineUnit;
  /** The head the unit was merged onto. */
  base: CommitSha;
  /** ISO timestamp: the composition's single deadline. */
  deadline: string;
  /** Resolver attempts left in the composition's budget; 0 parks without an agent call. */
  attemptsLeft: number;
  cause:
    | { kind: "conflict"; paths: string[]; detail: string }
    | {
        kind: "red";
        candidate: CommitSha;
        verification: LineVerification;
        logs: LineCommandLog[];
      };
}

/** Project scoped, not the run-scoped `Decision`. */
export interface LineResolverDecision {
  authority: "line";
  unit: LineUnit;
  base: CommitSha;
  commit: CommitSha;
  context: string;
  alternatives: { summary: string; rejectedBecause?: string }[];
  choice: string;
  rationale: string;
  reversibility: "reversible";
  resolverModel: string;
  examinerModel: string;
  attempts: number;
  verificationId: LineVerification["verificationId"];
  decidedAt: string;
}

export type LineResolution =
  | {
      kind: "resolved";
      commit: CommitSha;
      verification: LineVerification;
      resolver: LineResolver;
      decision: LineResolverDecision;
    }
  | {
      kind: "parked";
      reason: string;
      resolver: LineResolver;
      commit?: CommitSha;
      verification?: LineVerification;
    };

export interface LineResolverAgentPort {
  /** The agent edits files in the worktree only, never git. */
  resolve(input: { brief: string; worktree: LineWorktree; deadline: string }): Promise<{
    model: string;
    status: "finished" | "failed";
    summary?: string;
  }>;
  examine(input: {
    brief: string;
    worktree: LineWorktree;
    commit: CommitSha;
    base: CommitSha;
    verification: LineVerification;
    avoidModel: string;
    deadline: string;
  }): Promise<{
    model: string;
    verdict: "approved" | "rejected";
    findings: string[];
  }>;
}

export interface LineDecisionPort {
  record(decision: LineResolverDecision): Promise<void>;
}

export interface LineResolverPorts {
  checkout: LineCheckoutPort;
  verifier: LineVerifierPort;
  agents: LineResolverAgentPort;
  decisions: LineDecisionPort;
  clock: Clock;
  /** `attempts` defaults to core's `LINE_RESOLVER_ATTEMPTS`; the deadline comes from `failure.deadline`. */
  limits?: { attempts?: number };
}

export interface LineComposerPorts {
  queue: LineQueuePort;
  checkout: LineCheckoutPort;
  verifier: LineVerifierPort;
  publisher: LinePublisherPort;
  resolve: (failure: LineFailure) => Promise<LineResolution>;
  clock: Clock;
  /** `seconds` defaults to core's `LINE_COMPOSITION_SECONDS`; one deadline per batch. */
  limits?: { seconds?: number; attempts?: number };
}

export interface LineBatchOutcome {
  batchId: string;
  /** The line head after the batch. */
  head: CommitSha;
  composed: LineRange[];
  parked: { ranges: LineRange[]; reason: string }[];
  resolutions: LineResolution[];
  published?: { status: string; detail?: string };
}
