/**
 * Getting hold of the error a promise rejected with.
 *
 * `await expect(p).rejects.toBeInstanceOf(X)` proves the class and nothing else,
 * and `p.catch((e) => e)` widens the type to `T | unknown`, which then needs a
 * cast at every assertion. Both are worse than saying what is meant: this
 * promise must reject, and here is what it rejected with.
 *
 * Lives in `core`'s testing module rather than in a test file because every
 * package above this one asserts on typed domain failures, and three copies of
 * the same six lines is how two of them end up subtly different.
 */

/**
 * Awaits `work`, which must reject, and returns the `Error` it rejected with.
 *
 * Throws when the promise resolves instead — a test asserting on a failure that
 * silently stopped failing is the defect this prevents — and rethrows a
 * non-`Error` rejection rather than pretending it is one.
 */
export const rejectionOf = async (work: Promise<unknown>): Promise<Error> => {
  let resolved: unknown;
  try {
    resolved = await work;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected a rejection with an Error, got ${typeof error}: ${String(error)}`);
  }
  throw new Error(
    `expected a rejection, but the promise resolved with ${JSON.stringify(resolved) ?? "undefined"}`,
  );
};
