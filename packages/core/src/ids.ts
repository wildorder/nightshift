/**
 * Identifier generation (D-P1-07).
 *
 * Prefixed ULIDs, generated from an injected clock and randomness source so a
 * test can replay the exact same sequence. ULIDs sort lexicographically by time,
 * which is what makes them usable as DynamoDB range keys and as the ordering for
 * an event stream.
 *
 * The monotonic factory guarantees that two IDs minted in the same millisecond
 * still sort in creation order, so a burst of events cannot produce ties.
 */
import { ID_PREFIXES, type IdOf, type IdPrefix, parseId } from "@nightshift/contracts";
import { monotonicFactory } from "ulid";
import type { Clock, RandomSource } from "./time.js";
import { defaultRandomSource, systemClock } from "./time.js";

export interface IdGenerator {
  next<P extends IdPrefix>(prefix: P): IdOf<P>;
}

/**
 * Builds a generator over an injected clock and randomness source.
 *
 * Both default to the ambient implementations so application code stays terse;
 * every test passes its own.
 */
export const createUlidIdGenerator = (
  clock: Clock = systemClock,
  random: RandomSource = defaultRandomSource,
): IdGenerator => {
  const ulid = monotonicFactory(random);
  return {
    next: <P extends IdPrefix>(prefix: P): IdOf<P> =>
      // Parsed rather than cast, so a change to either the prefix table or the
      // ULID alphabet fails here rather than downstream in persistence.
      parseId(prefix, `${prefix}_${ulid(clock.now())}`),
  };
};

/**
 * A generator that mints predictable, human-readable identifiers for tests:
 * the same prefix always yields the same sequence. Not for production use, and
 * exported from `core` rather than a test file because every package's tests
 * need it.
 */
export const createCountingIdGenerator = (): IdGenerator => {
  const counters = new Map<IdPrefix, number>();
  return {
    next: <P extends IdPrefix>(prefix: P): IdOf<P> => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return parseId(prefix, `${prefix}_${encodeCrockford(n)}`);
    },
  };
};

/** Crockford base32: no I, L, O or U, so none of them may appear in output. */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Left-pads to the 26 characters a ULID payload always occupies. */
const encodeCrockford = (value: number): string => {
  let remaining = value;
  let encoded = "";
  do {
    encoded = CROCKFORD_ALPHABET[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  } while (remaining > 0);
  return encoded.padStart(26, "0");
};

export type { IdOf, IdPrefix };
/** Every prefix, re-exported so callers need not reach into `contracts` for it. */
export { ID_PREFIXES };
