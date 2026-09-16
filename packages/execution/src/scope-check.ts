/**
 * The scope check at commit time (D-P3-05, A-11).
 *
 * This is where "children may narrow inherited authority, never widen it" stops
 * being a property of a request and becomes a property of what integrates.
 *
 * Scope is enforced twice, deliberately, and neither is redundant:
 *
 * - **During the job**, by the harness adapter's tool policy (D-P3-15). It stops
 *   a well-behaved worker from straying, and gives it a clear refusal when it
 *   tries.
 * - **At commit**, here. The contract is explicit that scope is *not* a
 *   filesystem sandbox: a worker granted `shell.exec` can run anything, and a
 *   tool policy is a policy, not a fence. What P3 guarantees is that nothing
 *   outside scope ever *integrates*, and this is the one point at which that is
 *   structural rather than hoped for.
 *
 * The check is on the **snapshot's changed paths**, not on the worker's
 * behaviour: however a change got there, if it is outside the node's effective
 * scope the job fails with every offending path named.
 */
import type { Scope } from "@nightshift/contracts";
import { scopeAllowsPath } from "@nightshift/core";

export interface ScopeCheck {
  readonly allowed: boolean;
  /** Every path the scope does not permit, in the order git reported them. */
  readonly offending: readonly string[];
}

/**
 * Which of `paths` the scope does not permit.
 *
 * Uses `core`'s `scopeAllowsPath`, so include and exclude semantics — an exclude
 * always wins — are defined in exactly one place and cannot drift between the
 * delegation-time check and this one.
 *
 * Every offender is reported, not the first: a worker that strayed in four
 * places should learn all four, and a human reading the failure should not have
 * to re-run to find the rest.
 */
export const checkChangedPaths = (scope: Scope, paths: readonly string[]): ScopeCheck => {
  const offending = paths.filter((path) => !scopeAllowsPath(scope, path));
  return { allowed: offending.length === 0, offending };
};

/** The `outcomeReason` a scope violation leaves on the node. Durable, and specific. */
export const describeScopeViolation = (offending: readonly string[]): string =>
  `changes outside the job's effective scope: ${offending.join(", ")}`;
