/**
 * `@nightshift/persistence/local` — the store ports over one SQLite file, for
 * the local instance of the control plane (P12, D-P12-01, D-P12-02).
 *
 * Not a second store: it is `createInMemoryStores`, the same code every offline
 * suite proves, handed SQLite tables instead of `Map`s. Nothing above
 * `persistence` learns which one it holds (A-06: one plane, wherever it runs).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInMemoryStores, type InMemoryStores } from "../memory/index.js";
import type { Atomically } from "../memory/scoped-map.js";
import { createSqliteTable } from "./sqlite-table.js";

export { createSqliteTable, prefixUpperBound } from "./sqlite-table.js";

export interface LocalStoresOptions {
  /** The database file. Created, with its directory, if absent. `:memory:` for a test. */
  readonly file: string;
}

export interface LocalStores extends InMemoryStores {
  /** Closes the database. Nothing may be read or written after. */
  close(): void;
}

export const createLocalStores = (options: LocalStoresOptions): LocalStores => {
  if (options.file !== ":memory:") mkdirSync(dirname(options.file), { recursive: true });
  const db = new DatabaseSync(options.file);
  // WAL so a reader (a second CLI) never blocks the plane's writer; NORMAL is
  // durable at every commit that WAL checkpoints, which is what a local tool needs.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  let depth = 0;
  const atomically: Atomically = (fn) => {
    // Nested calls join the outer transaction: one unit, one commit.
    if (depth > 0) return fn();
    depth += 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      depth -= 1;
    }
  };
  const stores = createInMemoryStores({
    tables: (name) => createSqliteTable(db, name),
    atomically,
  });
  // Assigned, not spread: a spread would read `size` once and freeze it.
  return Object.assign(stores, { close: () => db.close() });
};
