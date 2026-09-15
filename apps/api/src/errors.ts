/**
 * Failure to HTTP status.
 *
 * Domain refusals map by `DomainErrorCode`, never by message (T4 deliverable 4).
 * The record is exhaustive, so a new code in `core` fails to compile here until
 * someone decides its status.
 */
import { type DomainErrorCode, isDomainError } from "@nightshift/core";
import { ZodError } from "zod";
import { type ApiResponse, errorBody, HttpError } from "./http.js";

export const DOMAIN_ERROR_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  // Specified by T4.
  ownership_violation: 403,
  scope_widening: 403,
  illegal_transition: 409,
  verification_evidence: 409,
  concurrency_limit_exceeded: 429,
  depth_limit_exceeded: 422,
  // Chosen here. A malformed tree or a cycle conflicts with the tree already
  // stored, so 409 like the transition table.
  tree_structure: 409,
  cycle: 409,
  // The parent holds no delegation authority (a leaf job) or is terminal: a
  // refusal of authority, like scope widening.
  delegation_refused: 403,
  // An agent trying to outrank a human is an authority refusal.
  decision_authority: 403,
  // Softening reversibility conflicts with what is already recorded.
  reversibility_softened: 409,
};

export const toErrorResponse = (error: unknown): ApiResponse => {
  if (error instanceof HttpError) {
    return { status: error.status, body: errorBody(error.code, error.message, error.issues) };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: errorBody("validation_failed", "request failed validation", error.issues),
    };
  }
  if (isDomainError(error)) {
    return { status: DOMAIN_ERROR_STATUS[error.code], body: errorBody(error.code, error.message) };
  }
  // Logged for the operator; never echoed, so no stack or internal detail leaks.
  console.error("unhandled control-plane error", error);
  return { status: 500, body: errorBody("internal_error", "internal error") };
};
