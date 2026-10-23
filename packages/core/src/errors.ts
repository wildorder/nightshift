/**
 * Typed domain errors.
 *
 * Every failure carries structured fields, not just a message, because these
 * errors become control-plane records and MCP responses: an orchestrator has to
 * be able to act on *why* a delegation was refused, not parse prose.
 */

/** Discriminator for every domain failure. Exhaustive by construction. */
export type DomainErrorCode =
  | "ownership_violation"
  | "tree_structure"
  | "cycle"
  | "depth_limit_exceeded"
  | "concurrency_limit_exceeded"
  | "delegation_refused"
  | "illegal_transition"
  | "outcome_required"
  | "verification_evidence"
  | "decision_authority"
  | "reversibility_softened"
  | "stale_write"
  /**
   * D-05. `apps/api/src/errors.ts` and `packages/persistence/src/http/errors.ts`
   * are exhaustive tables over this union; J3 extends them (to 422).
   */
  | "completion_membership"
  /** P21: a plan draft write or act the draft's state refuses, or a lost append race. */
  | "plan_draft";

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A record was used outside the project, program or run that owns it (A-07), or
 * a stored project was asked to move to another organisation, which would strand
 * its org pointer (`field: "orgId"`).
 */
export class OwnershipViolationError extends DomainError {
  readonly code = "ownership_violation" as const;

  constructor(
    readonly field: "orgId" | "projectId" | "programId" | "runId",
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`${field} mismatch: expected ${expected}, received ${actual}`);
  }
}

/** The execution tree is malformed for a reason other than a cycle. */
export class TreeStructureError extends DomainError {
  readonly code = "tree_structure" as const;

  constructor(
    message: string,
    readonly nodeId?: string,
  ) {
    super(message);
  }
}

/** An edge would make the execution tree cyclic (SC-P1-11). */
export class CycleError extends DomainError {
  readonly code = "cycle" as const;

  constructor(
    readonly nodeId: string,
    readonly parentNodeId: string,
  ) {
    super(`attaching ${nodeId} under ${parentNodeId} would create a cycle`);
  }
}

export class DepthLimitExceededError extends DomainError {
  readonly code = "depth_limit_exceeded" as const;

  constructor(
    readonly depth: number,
    readonly maxDepth: number,
  ) {
    super(`delegation depth ${depth} exceeds the limit of ${maxDepth}`);
  }
}

export class ConcurrencyLimitExceededError extends DomainError {
  readonly code = "concurrency_limit_exceeded" as const;

  constructor(
    readonly running: number,
    readonly maxConcurrency: number,
  ) {
    super(`${running} sibling nodes already occupy the limit of ${maxConcurrency}`);
  }
}

/**
 * A delegation was refused for a reason other than a limit:
 * the parent is terminal, or it is a leaf job with no delegation authority.
 */
export class DelegationRefusedError extends DomainError {
  readonly code = "delegation_refused" as const;

  constructor(readonly reason: string) {
    super(`delegation refused: ${reason}`);
  }
}

/**
 * A run or agent was ended without the reason that ending requires (T2).
 *
 * Separate from `illegal_transition` because the transition itself was legal: a
 * `running` run may certainly fail. What is refused is ending it in silence.
 * Killing a worker must leave durable state (architecture §4), and a terminal
 * record with no reason is the silence that rule exists to prevent.
 */
export class OutcomeReasonRequiredError extends DomainError {
  readonly code = "outcome_required" as const;

  constructor(
    readonly record: "run" | "agent",
    readonly status: string,
  ) {
    super(`a ${record} ending as "${status}" must carry an outcomeReason`);
  }
}

/** A (state, event) pair outside the transition table (SC-P1-15). */
export class IllegalTransitionError extends DomainError {
  readonly code = "illegal_transition" as const;

  constructor(
    readonly from: string,
    readonly event: string,
  ) {
    super(`no legal transition from "${from}" on "${event}"`);
  }
}

/**
 * Verification evidence was missing, failed, or belonged to different work.
 * This is the error that keeps `implemented` from becoming `verified` (A-05).
 */
export class VerificationEvidenceError extends DomainError {
  readonly code = "verification_evidence" as const;

  constructor(readonly reason: string) {
    super(`cannot assert verified: ${reason}`);
  }
}

/** An agent tried to outrank a human. Human authority is always highest. */
export class DecisionAuthorityError extends DomainError {
  readonly code = "decision_authority" as const;

  constructor(readonly reason: string) {
    super(`decision authority violation: ${reason}`);
  }
}

/**
 * A record tried to describe an effect as more reversible than it is. An
 * irreversible external effect is never recorded as reversible (architecture §6).
 */
export class ReversibilitySoftenedError extends DomainError {
  readonly code = "reversibility_softened" as const;

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`reversibility cannot be softened from "${from}" to "${to}"`);
  }
}

/**
 * A versioned write named a version the stored record is no longer at (P8,
 * D-P8-02): someone else wrote in between. Read it again and reapply.
 */
export class StaleWriteError extends DomainError {
  readonly code = "stale_write" as const;

  constructor(
    readonly record: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `${record} is at version ${actual}, not ${expected}; read it again and reapply the change`,
    );
  }
}

export type CompletionMembershipReason =
  | "measurement_unavailable"
  | "unknown_run"
  | "anchor_mismatch"
  | "duplicate"
  | "checkpoint_immutable"
  | "checkpoint_not_positive"
  | "checkpoint_not_member";

/**
 * A completion history write named a membership the project cannot support
 * (D-05): a run that does not exist, an anchor that is not the record's own
 * run, a duplicate member, or a checkpoint that was altered or is not on a
 * member currently rated `worked`.
 */
export class CompletionMembershipError extends DomainError {
  readonly code = "completion_membership" as const;

  constructor(
    readonly ref: { readonly programId: string; readonly runId: string },
    readonly reason: CompletionMembershipReason,
  ) {
    super(`completion membership refused for ${ref.programId}/${ref.runId}: ${reason}`);
  }
}

export type PlanDraftReason =
  | "declined"
  | "stale_base"
  | "no_draft"
  | "not_latest_version"
  | "plan_hash_required"
  | "conflict";

/**
 * A plan draft write or act was refused (P21): the draft is declined, the write
 * was based on a version that is not the latest (or on one when there is no
 * draft), the act names a version that is not the latest, or the store found the
 * version already written. Nothing was changed.
 */
export class PlanDraftError extends DomainError {
  readonly code = "plan_draft" as const;

  constructor(
    readonly reason: PlanDraftReason,
    detail: string,
  ) {
    super(`plan draft refused (${reason}): ${detail}`);
  }
}

export const isDomainError = (value: unknown): value is DomainError => value instanceof DomainError;
