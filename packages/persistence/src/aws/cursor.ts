/**
 * Opaque pagination cursors.
 *
 * The port defines a cursor as an opaque string (T3 deliverable 5). Here it is a
 * base64url JSON document: for key-ordered queries, the key of the last item
 * returned, which DynamoDB accepts as `ExclusiveStartKey`; for the event stream,
 * a position in `orderEvents` order. A cursor that does not decode is a
 * `RangeError`, matching the in-memory adapter.
 */

export const encodeCursor = (value: Readonly<Record<string, unknown>>): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export const decodeCursor = (cursor: string): Record<string, unknown> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new RangeError(`invalid cursor: ${cursor}`);
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new RangeError(`invalid cursor: ${cursor}`);
  }
  return decoded as Record<string, unknown>;
};

/** A key cursor: every attribute must be a string, as every key in this table is. */
export const decodeKeyCursor = (
  cursor: string,
  attributes: readonly string[],
): Record<string, string> => {
  const decoded = decodeCursor(cursor);
  const key: Record<string, string> = {};
  for (const attribute of attributes) {
    const value = decoded[attribute];
    if (typeof value !== "string") throw new RangeError(`invalid cursor: ${cursor}`);
    key[attribute] = value;
  }
  return key;
};

export const assertLimit = (limit: number | undefined): void => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new RangeError(`invalid limit: ${limit}`);
  }
};
