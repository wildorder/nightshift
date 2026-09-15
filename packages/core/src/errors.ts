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
  | "scope_widening"
  | "tree_structure"
  | "cycle"
  | "depth_limit_exceeded"
  | "concurrency_limit_exceeded"
  | "delegation_refused"
  | "illegal_transition"
  | "verification_evidence"
  | "decision_authority"
  | "reversibility_softened";

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

/**
 * A child tried to claim authority its parent does not hold (A-11). `reasons`
 * lists every widening found, not just the first, so a caller can fix the whole
 * request in one pass.
 */
export class ScopeWideningError extends DomainError {
  readonly code = "scope_widening" as const;

  constructor(readonly reasons: readonly string[]) {
    super(`child scope would widen its parent's authority: ${reasons.join("; ")}`);
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
 * A delegation was refused for a reason other than a limit or a scope widening:
 * the parent is terminal, or it is a leaf job with no delegation authority.
 */
export class DelegationRefusedError extends DomainError {
  readonly code = "delegation_refused" as const;

  constructor(readonly reason: string) {
    super(`delegation refused: ${reason}`);
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

export const isDomainError = (value: unknown): value is DomainError => value instanceof DomainError;
