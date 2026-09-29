/**
 * The storage primitive behind the in-memory adapter.
 *
 * Every key embeds the full ownership chain, so a query scoped to Project A
 * cannot reach Project B's records even if the caller asks for an identifier it
 * somehow learned. Isolation is a property of the key layout, not of a filter a
 * future method might forget to apply (A-07).
 */
import type { ProgramId, ProjectId, RunId } from "@nightshift/contracts";

export interface ProjectKey {
  readonly projectId: ProjectId;
}

export interface ProgramKey extends ProjectKey {
  readonly programId: ProgramId;
}

export interface RunKey extends ProgramKey {
  readonly runId: RunId;
}

/** `/` is safe as a separator because no identifier can contain one. */
const SEP = "/";

export const projectPrefix = (scope: ProjectKey): string => `${scope.projectId}${SEP}`;

export const programPrefix = (scope: ProgramKey): string =>
  `${scope.projectId}${SEP}${scope.programId}${SEP}`;

export const runPrefix = (scope: RunKey): string =>
  `${scope.projectId}${SEP}${scope.programId}${SEP}${scope.runId}${SEP}`;

/**
 * A sorted key-value store with prefix scans.
 *
 * Entries are kept in ascending key order on read, which is what makes list
 * results stable across calls and lets a cursor be a simple offset.
 */
export class ScopedMap<T> implements KeyValueTable<T> {
  private readonly entries = new Map<string, T>();

  set(key: string, value: T): void {
    this.entries.set(key, value);
  }

  get(key: string): T | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Every value whose key begins with `prefix`, in ascending key order. */
  scan(prefix: string): readonly T[] {
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((key) => this.entries.get(key) as T);
  }

  /** Every value, in ascending key order. For diagnostics only. */
  all(): readonly T[] {
    return this.scan("");
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Applies a forward-only cursor to an already-ordered list.
 *
 * The cursor is an offset rather than an opaque token because this adapter is
 * for tests; a DynamoDB adapter will carry a real `LastEvaluatedKey` and must
 * still satisfy the same conformance suite.
 */
export const paginate = <T>(
  items: readonly T[],
  options: { readonly limit?: number; readonly cursor?: string } = {},
): { readonly items: readonly T[]; readonly cursor?: string } => {
  const start = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
  if (Number.isNaN(start) || start < 0) {
    throw new RangeError(`invalid cursor: ${String(options.cursor)}`);
  }

  const limit = options.limit ?? items.length;
  if (limit < 0) throw new RangeError(`invalid limit: ${limit}`);

  const page = items.slice(start, start + limit);
  const next = start + page.length;

  return next < items.length ? { items: page, cursor: String(next) } : { items: page };
};

/**
 * The storage the memory store's logic runs over (P12, D-P12-02).
 *
 * `ScopedMap` is the reference implementation; `@nightshift/persistence/local`
 * supplies a SQLite table with the same behaviour, held equal to this one by a
 * property test. Synchronous on purpose: every store method reads and writes
 * with no `await` between, so a sequence of calls is atomic in JavaScript, and
 * `atomically` (below) makes it atomic on disk too.
 */
export interface KeyValueTable<T> {
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  delete(key: string): boolean;
  readonly size: number;
  /** Every value whose key begins with `prefix`, in ascending key order. */
  scan(prefix: string): readonly T[];
  all(): readonly T[];
  clear(): void;
}

/** Makes one table per store, by a stable name. */
export type TableFactory = <T>(name: string) => KeyValueTable<T>;

/** Runs `fn` as one unit of storage: a transaction on disk, a plain call in memory. */
export type Atomically = <T>(fn: () => T) => T;

export const mapTables: TableFactory = <T>() => new ScopedMap<T>();
