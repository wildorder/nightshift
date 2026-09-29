/**
 * A `KeyValueTable` over one SQLite table (P12, D-P12-02).
 *
 * `node:sqlite`'s `DatabaseSync` is synchronous, as `ScopedMap` is, so the
 * memory store's logic runs over it unchanged. Values are the records' JSON;
 * the store methods parse through the contract schemas as they always have.
 *
 * Ordering: `scan` returns keys ascending under SQLite's `BINARY` collation,
 * which compares UTF-8 bytes. That equals `ScopedMap`'s JavaScript sort for
 * every key Nightshift writes (identifiers, prefixes and `/`, all ASCII); the
 * property test holds the two equal over ASCII keys.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { KeyValueTable } from "../memory/scoped-map.js";

/** Only names this module itself passes; never user input. */
const TABLE_NAME = /^[a-z][A-Za-z0-9]*$/;

/**
 * The smallest string greater than every string that starts with `prefix`, for
 * a range scan. `undefined` for the empty prefix: scan everything.
 */
export const prefixUpperBound = (prefix: string): string | undefined => {
  if (prefix === "") return undefined;
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
};

export const createSqliteTable = <T>(db: DatabaseSync, name: string): KeyValueTable<T> => {
  if (!TABLE_NAME.test(name)) throw new Error(`not a table name: ${name}`);
  const table = `t_${name}`;
  db.exec(
    `CREATE TABLE IF NOT EXISTS "${table}" (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
  );
  const statements = {
    set: db.prepare(
      `INSERT INTO "${table}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    get: db.prepare(`SELECT value FROM "${table}" WHERE key = ?`),
    delete: db.prepare(`DELETE FROM "${table}" WHERE key = ?`),
    count: db.prepare(`SELECT count(*) AS n FROM "${table}"`),
    all: db.prepare(`SELECT value FROM "${table}" ORDER BY key`),
    range: db.prepare(`SELECT value FROM "${table}" WHERE key >= ? AND key < ? ORDER BY key`),
    clear: db.prepare(`DELETE FROM "${table}"`),
  } satisfies Record<string, StatementSync>;

  const values = (rows: readonly unknown[]): T[] =>
    rows.map((row) => JSON.parse((row as { value: string }).value) as T);

  return {
    set: (key, value) => {
      statements.set.run(key, JSON.stringify(value));
    },
    get: (key) => {
      const row = statements.get.get(key) as { value: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.value) as T);
    },
    has: (key) => statements.get.get(key) !== undefined,
    delete: (key) => Number(statements.delete.run(key).changes) > 0,
    get size() {
      return Number((statements.count.get() as { n: number | bigint }).n);
    },
    scan: (prefix) => {
      const upper = prefixUpperBound(prefix);
      return values(
        upper === undefined ? statements.all.all() : statements.range.all(prefix, upper),
      );
    },
    all: () => values(statements.all.all()),
    clear: () => {
      statements.clear.run();
    },
  };
};
