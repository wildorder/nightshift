# T1 — The local store

**Program:** `p12-local-instance`
**Depends on:** —
**Unblocks:** T2
**Decisions applied:** D-P12-02

## Objective

The memory store's logic runs over a SQLite file as well as a `Map`, and the
two are proven equivalent.

## Deliverables

1. **`KeyValueTable<T>`** in `persistence/memory/scoped-map.ts`: the interface
   `ScopedMap` already satisfies (`set`, `get`, `has`, `delete`, `scan(prefix)`,
   `all`, `clear`, `size`), exported; `ScopedMap` implements it.
   `createInMemoryStores` gains `tables?: () => KeyValueTable<unknown>` (a
   factory, one table per store) defaulting to `ScopedMap`; every store method is
   unchanged.
2. **`@nightshift/persistence/local`**: `createSqliteTable(db, name)` over
   `node:sqlite`'s `DatabaseSync` (`key TEXT PRIMARY KEY, value TEXT`; `scan` is a
   range query on the prefix, ordered by key, matching `ScopedMap.scan`'s sort);
   `createLocalStores({ file }): NightshiftStores & { close() }`, which opens or
   creates the file and hands `createInMemoryStores` SQLite tables. Records are
   stored as JSON text; parsing through the contract schemas stays in the store
   methods.
3. **The equivalence property** (fast-check): a generated sequence of table
   operations applied to a `ScopedMap` and a `createSqliteTable` yields the same
   `scan`, `all` and `size` at every step. Plus the memory store's own suite run
   once over each table (a shared `describe` parameterised by table).
4. **Durability**: a store closed and reopened on the same file holds every
   record, every event with its sequence, every org config version.
5. **Node 24.** `engines` to `>=24 <25`, `.node-version` to `24`, the Lambda
   runtime to `nodejs24.x` if `aws-cdk-lib` offers it (else unchanged, with a
   note), `tsconfig.base.json`'s `target`/`lib` to what Node 24 supports; the
   whole verify behind it on both legs. A note in `AGENTS.md`'s conventions that
   `node:sqlite` is used under `persistence/local` only. The architecture rules:
   `persistence/local` may import `node:sqlite`; `contracts` and `core` still
   may not (AR-1 unchanged; AR-3 gains the local adapter alongside memory and
   http: no AWS SDK).

## Acceptance

- The memory suite passes over both tables; the property holds.
- A reopened file answers what was written; `npm run verify` green on both legs.
