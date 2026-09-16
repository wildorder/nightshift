/**
 * Turning a control-plane refusal back into a typed failure.
 *
 * The point is that a caller can write `catch (error) { if (error instanceof
 * ScopeWideningError) … }` whether its stores are in memory, on DynamoDB, or
 * across the network. A refusal that arrived as a 403 with a JSON body would
 * otherwise be a different kind of thing from the same refusal raised locally,
 * and every call site would need two branches.
 *
 * ## What survives the wire, and what does not
 *
 * The API answers `{ error: { code, message } }`. `code` is a stable
 * `DomainErrorCode` and is what selects the class; `message` is the domain
 * error's own message and is preserved verbatim. The **structured fields are
 * not on the wire** — a `ScopeWideningError` carries `reasons`, a
 * `DepthLimitExceededError` carries two numbers, and the API sends neither.
 * So a reconstructed error carries the message in whatever field its class
 * requires, and nothing more.
 *
 * That is a real limitation, stated rather than hidden: `instanceof` and
 * `.code` are reliable across the network, individual fields are not. Every
 * caller in P3 branches on the class, and the message is what it shows a human.
 * If a caller ever needs a field, the API has to start sending it.
 */
import {
  ConcurrencyLimitExceededError,
  CycleError,
  DecisionAuthorityError,
  DelegationRefusedError,
  DepthLimitExceededError,
  type DomainError,
  type DomainErrorCode,
  IllegalTransitionError,
  OutcomeReasonRequiredError,
  OwnershipViolationError,
  ReversibilitySoftenedError,
  ScopeWideningError,
  TreeStructureError,
  VerificationEvidenceError,
} from "@nightshift/core";

/**
 * A refusal the control plane made that is not a domain rule: a validation
 * failure, a missing parent, a conflict, an authorization refusal, a 5xx that
 * survived every retry.
 */
export class ControlPlaneError extends Error {
  override readonly name = "ControlPlaneError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Schema issues, present on `validation_failed`. */
    readonly issues?: readonly unknown[],
  ) {
    super(message);
  }
}

/** Raised when the transport could not reach the control plane at all. */
export class ControlPlaneUnreachableError extends Error {
  override readonly name = "ControlPlaneUnreachableError";

  constructor(
    message: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(message);
  }
}

/**
 * The exhaustive map from code to class. A new `DomainErrorCode` in `core`
 * fails to compile here until someone decides how it crosses the network —
 * the same property `DOMAIN_ERROR_STATUS` gives the server side.
 */
const DOMAIN_ERRORS: Readonly<Record<DomainErrorCode, (message: string) => DomainError>> = {
  ownership_violation: (message) => new OwnershipViolationError("projectId", "", message),
  scope_widening: (message) => new ScopeWideningError([message]),
  tree_structure: (message) => new TreeStructureError(message),
  cycle: (message) => new CycleError(message, ""),
  depth_limit_exceeded: () => new DepthLimitExceededError(0, 0),
  concurrency_limit_exceeded: () => new ConcurrencyLimitExceededError(0, 0),
  delegation_refused: (message) => new DelegationRefusedError(message),
  illegal_transition: (message) => new IllegalTransitionError(message, ""),
  verification_evidence: (message) => new VerificationEvidenceError(message),
  decision_authority: (message) => new DecisionAuthorityError(message),
  reversibility_softened: () => new ReversibilitySoftenedError("", ""),
  outcome_required: () => new OutcomeReasonRequiredError("run", ""),
};

const isDomainErrorCode = (code: string): code is DomainErrorCode =>
  Object.hasOwn(DOMAIN_ERRORS, code);

interface ErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly issues?: unknown;
  };
}

const readError = (body: unknown): { code: string; message: string; issues?: unknown[] } => {
  const error = (body as ErrorBody | null | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : "unknown_error";
  const message =
    typeof error?.message === "string" ? error.message : `the control plane refused the request`;
  const issues = Array.isArray(error?.issues) ? (error.issues as unknown[]) : undefined;
  return issues === undefined ? { code, message } : { code, message, issues };
};

/**
 * The error to throw for a non-2xx response.
 *
 * A body carrying a `DomainErrorCode` becomes that class, with the server's
 * message. Anything else becomes a {@link ControlPlaneError} carrying the
 * status, so a caller can tell a 404 from a 409 from a 500 without parsing
 * prose.
 */
export const toThrowable = (status: number, body: unknown): Error => {
  const { code, message, issues } = readError(body);
  if (isDomainErrorCode(code)) {
    const error = DOMAIN_ERRORS[code](message);
    // The class is what a caller branches on; the message is what it shows a
    // human. Constructors that build a message from fields would otherwise
    // replace the server's with a synthetic one built from empty placeholders.
    error.message = message;
    return error;
  }
  return new ControlPlaneError(status, code, message, issues);
};
