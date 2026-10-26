import { isDeepStrictEqual } from "node:util";

/** Drops undefined-valued properties at every depth, as JSON-based stores do when persisting. */
const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefined(entry)]),
    );
  }
  return value;
};

/** Equality of two records in their persisted form: undefined-valued properties do not count. */
export const persistedEqual = (a: unknown, b: unknown): boolean =>
  isDeepStrictEqual(stripUndefined(a), stripUndefined(b));
