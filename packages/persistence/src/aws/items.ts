/**
 * How a contract record becomes a DynamoDB item and back.
 *
 * A record is stored flat, with its keys beside its own fields. The contract
 * schemas are strict and none has a field named like a key attribute, so the two
 * cannot collide. On the way out every item is re-parsed through its schema, so a
 * malformed stored record fails here, at the boundary, rather than deep in the
 * domain (T3).
 */
import type { NodeIndexKey, TableKey } from "./keys.js";

export type Item = Record<string, unknown>;

/** Anything with a zod-style `parse`. Structural, so this module needs no zod import. */
export interface Parser<T> {
  parse(value: unknown): T;
}

/**
 * The item's revision, beside its keys and like them no field of the record: a
 * token a record whose writers must not undo each other is written with, and
 * conditioned on (P16, D-08). Upper case, as the keys are, so no contract field
 * can be named like it.
 */
export const REVISION_ATTRIBUTE = "REV";

const KEY_ATTRIBUTES = new Set(["PK", "SK", "GSI1PK", "GSI1SK", REVISION_ATTRIBUTE]);

/**
 * DynamoDB refuses any item over 400 KB. The guard below stops short of it so the
 * failure is ours and typed, not a `ValidationException` from the service.
 */
export const MAX_ITEM_BYTES = 400_000;

/**
 * An upper bound on an item's stored size.
 *
 * DynamoDB counts attribute names and values in UTF-8. The JSON encoding counts
 * those plus quotes, colons and braces, so it always over-estimates; refusing on
 * it can only refuse early, never let an oversized item through.
 */
export const estimateItemBytes = (item: Item): number =>
  new TextEncoder().encode(JSON.stringify(item)).length;

/**
 * A record too large for one DynamoDB item.
 *
 * The plausible case is a very large `ProgramContract`. The answer is to refuse
 * it: splitting a contract across items would make its read non-atomic, and
 * large prose belongs in an artifact the contract references (A-08).
 */
export class ItemTooLargeError extends Error {
  constructor(
    readonly entity: string,
    readonly sizeBytes: number,
    readonly limitBytes: number = MAX_ITEM_BYTES,
  ) {
    super(
      `${entity} would occupy about ${sizeBytes} bytes, over the ${limitBytes}-byte item limit; ` +
        "move large content to an artifact and store a reference (A-08)",
    );
    this.name = "ItemTooLargeError";
  }
}

export const toItem = (
  entity: string,
  key: TableKey,
  record: object,
  index?: NodeIndexKey,
): Item => {
  const item: Item = { ...record, ...key, ...(index ?? {}) };
  const size = estimateItemBytes(item);
  if (size > MAX_ITEM_BYTES) throw new ItemTooLargeError(entity, size);
  return item;
};

/** The record inside an item, keys removed, validated by its schema. */
export const fromItem = <T>(schema: Parser<T>, item: Item): T => {
  const record: Item = {};
  for (const [name, value] of Object.entries(item)) {
    if (!KEY_ATTRIBUTES.has(name)) record[name] = value;
  }
  return schema.parse(record);
};
