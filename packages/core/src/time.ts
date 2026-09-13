/**
 * Injected time and randomness (D-P1-07).
 *
 * Nothing in `core` reads the ambient clock or ambient randomness. Both arrive
 * as parameters, which is what makes the domain deterministic under property
 * test: a failing case replays exactly.
 */

/** Epoch milliseconds. */
export interface Clock {
  now(): number;
}

/** A pseudo-random source producing values in `[0, 1)`, like `Math.random`. */
export type RandomSource = () => number;

/** The ambient clock. Applications inject this; tests inject a fixed one. */
export const systemClock: Clock = { now: () => Date.now() };

/** A clock that advances by `stepMs` on every read, for deterministic tests. */
export const createSteppingClock = (startMs: number, stepMs = 1): Clock => {
  let current = startMs;
  return {
    now: () => {
      const value = current;
      current += stepMs;
      return value;
    },
  };
};

/** A clock frozen at one instant. */
export const createFixedClock = (atMs: number): Clock => ({ now: () => atMs });

/**
 * Deterministic randomness from a seed, for tests and for reproducing a failing
 * property case. Not cryptographic, and never used for anything that needs to be
 * unguessable: ULID randomness only has to avoid collisions.
 */
export const createSeededRandom = (seed: number): RandomSource => {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    // xorshift32, chosen because it is short enough to read and verify by eye.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
};

/**
 * The ambient randomness source. An application that wants crypto-grade
 * randomness injects its own, since `core` may not import a Node builtin.
 */
export const defaultRandomSource: RandomSource = () => Math.random();

/** Formats epoch milliseconds as the ISO-8601 timestamp the contracts expect. */
export const toIsoTimestamp = (epochMs: number): string => new Date(epochMs).toISOString();

/** The current instant as an ISO-8601 timestamp, from an injected clock. */
export const nowIso = (clock: Clock): string => toIsoTimestamp(clock.now());
