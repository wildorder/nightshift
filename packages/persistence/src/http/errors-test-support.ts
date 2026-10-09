/**
 * Every `DomainErrorCode`, as a value.
 *
 * `DomainErrorCode` is a union of string literals, so it cannot be enumerated at
 * run time. This list is `satisfies`-checked against the union, which means
 * adding a code to `core` without adding it here is a compile error rather than
 * a test that quietly stops covering it.
 */
import type { DomainErrorCode } from "@nightshift/core";

export const DOMAIN_ERROR_CODES_FOR_TEST = [
  "ownership_violation",
  "tree_structure",
  "cycle",
  "depth_limit_exceeded",
  "concurrency_limit_exceeded",
  "delegation_refused",
  "illegal_transition",
  "verification_evidence",
  "decision_authority",
  "reversibility_softened",
  "outcome_required",
] as const satisfies readonly DomainErrorCode[];
