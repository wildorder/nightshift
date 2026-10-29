/**
 * What a line settlement records, and how it is told apart from another: the
 * entries exactly as `settleBatch` writes them, the canonical JSON they are
 * hashed from, and the digests that content-address the run's entry events.
 * Pure and runtime-neutral (the report reads these in the browser too).
 */
import type {
  LineComposition,
  LineParked,
  LineSettleBody,
  LineSettledPayload,
} from "@nightshift/contracts";
import { sha256Bytes } from "./sha256.js";

/** JSON with object keys sorted and `undefined` members dropped: equal values give equal text. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const members = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    );
  return `{${members.join(",")}}`;
};

/** The hex sha256 of a UTF-8 string. */
export const sha256Hex = (text: string): string =>
  Array.from(sha256Bytes(text), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The composition `settleBatch` records for a settle body. */
export const composedEntryOf = (
  body: NonNullable<LineSettleBody["composition"]>,
  compositionId: string,
  at: string,
): LineComposition => ({
  compositionId,
  commit: body.commit,
  parent: body.parent,
  ranges: body.ranges,
  verification: body.verification,
  ...(body.resolver === undefined ? {} : { resolver: body.resolver }),
  ...(body.repair === undefined ? {} : { repair: body.repair }),
  composedAt: at,
});

/** The parked entry `settleBatch` records for one of a settle body's parked entries. */
export const parkedEntryOf = (
  entry: LineSettleBody["parked"][number],
  compositionId: string,
  at: string,
): LineParked => ({
  compositionId,
  ranges: entry.ranges,
  reason: entry.reason,
  ...(entry.commit === undefined ? {} : { commit: entry.commit }),
  ...(entry.verification === undefined ? {} : { verification: entry.verification }),
  ...(entry.resolver === undefined ? {} : { resolver: entry.resolver }),
  ...(entry.repair === undefined ? {} : { repair: entry.repair }),
  parkedAt: at,
});

/** The canonical JSON an entry is hashed and chunked from; `pushed` is the publisher's later word, not the settlement's. */
export const entryText = (entry: LineComposition | LineParked): string => {
  const { pushed: _pushed, ...rest } = entry as LineComposition;
  return canonicalJson(rest);
};

/** The content digest of an entry as recorded. */
export const entryDigest = (entry: LineComposition | LineParked): string =>
  sha256Hex(entryText(entry));

/** The digest of a whole settle body: independent of when it is made, so a retry of the same body matches. */
export const settlementDigest = (
  body: Pick<LineSettleBody, "batchId" | "composition" | "parked" | "push">,
): string =>
  sha256Hex(
    canonicalJson({
      batchId: body.batchId,
      composition: body.composition,
      parked: body.parked,
      push: body.push,
    }),
  );

/** The marker events' payloads naming a settlement's entries, split to stay inline. */
export const settledMarkers = (
  input: {
    readonly batchId: string;
    readonly generation: number;
    readonly digest: string;
    readonly entries: LineSettledPayload["entries"];
  },
  perEvent: number,
): LineSettledPayload[] => {
  const parts = Math.max(1, Math.ceil(input.entries.length / perEvent));
  return Array.from({ length: parts }, (_, part) => ({
    batchId: input.batchId,
    generation: input.generation,
    digest: input.digest,
    part,
    parts,
    entries: input.entries.slice(part * perEvent, (part + 1) * perEvent),
  }));
};
