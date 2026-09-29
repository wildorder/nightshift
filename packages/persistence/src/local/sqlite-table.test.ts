import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultOrgConfig } from "@nightshift/contracts";
import {
  createFixtures,
  makeEvent,
  makeProgramContract,
  makeProject,
  makeRun,
} from "@nightshift/core";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { ScopedMap } from "../memory/scoped-map.js";
import { createLocalStores } from "./index.js";
import { createSqliteTable, prefixUpperBound } from "./sqlite-table.js";

/** Keys in the alphabet Nightshift's own keys use: identifiers, `_`, `/`. */
const key = fc.stringMatching(/^[a-z0-9_/]{0,6}$/);
const value = fc.jsonValue();
const op = fc.oneof(
  fc.record({ kind: fc.constant("set" as const), key, value }),
  fc.record({ kind: fc.constant("delete" as const), key }),
  fc.record({ kind: fc.constant("clear" as const) }),
);

describe("the SQLite table (D-P12-02)", () => {
  it("behaves as ScopedMap does, over any sequence of operations", () => {
    fc.assert(
      fc.property(
        fc.array(op, { maxLength: 40 }),
        fc.array(key, { maxLength: 5 }),
        (ops, prefixes) => {
          const db = new DatabaseSync(":memory:");
          const sqlite = createSqliteTable<unknown>(db, "t");
          const reference = new ScopedMap<unknown>();
          for (const o of ops) {
            if (o.kind === "set") {
              // JSON is what is stored; compare against what JSON can hold.
              const v = JSON.parse(JSON.stringify(o.value)) as unknown;
              sqlite.set(o.key, v);
              reference.set(o.key, v);
            } else if (o.kind === "delete") {
              expect(sqlite.delete(o.key)).toBe(reference.delete(o.key));
            } else {
              sqlite.clear();
              reference.clear();
            }
            expect(sqlite.size).toBe(reference.size);
          }
          expect(sqlite.all()).toEqual(reference.all());
          for (const prefix of ["", ...prefixes]) {
            expect(sqlite.scan(prefix)).toEqual(reference.scan(prefix));
          }
          for (const o of ops) {
            if (o.kind === "clear") continue;
            expect(sqlite.get(o.key)).toEqual(reference.get(o.key));
            expect(sqlite.has(o.key)).toBe(reference.has(o.key));
          }
          db.close();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("bounds a prefix scan above by the next string", () => {
    expect(prefixUpperBound("")).toBeUndefined();
    expect(prefixUpperBound("proj_1/")).toBe("proj_10");
  });

  it("refuses a table name it did not choose", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => createSqliteTable(db, 'x"; DROP TABLE y; --')).toThrow(/not a table name/);
  });
});

describe("the local stores on disk (SC-P12-05)", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("keeps every record, event sequence and config version across a reopen", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-local-"));
    const file = join(dir, "state", "nightshift.sqlite");
    const f = createFixtures();
    const orgId = f.ids.next("org");

    const first = createLocalStores({ file });
    await first.projects.put(makeProject(f, { orgId }));
    await first.programContracts.put(makeProgramContract(f));
    await first.runs.put(makeRun(f));
    const a = await first.events.append(makeEvent(f, { idempotencyKey: "a" }));
    const b = await first.events.append(makeEvent(f, { idempotencyKey: "b" }));
    await first.orgConfigs.put({
      ...defaultOrgConfig(orgId, "2026-09-28T00:00:00.000Z"),
      version: 1,
    });
    expect([a.event.sequence, b.event.sequence]).toEqual([0, 1]);
    first.close();

    const second = createLocalStores({ file });
    expect((await second.projects.listByOrg(orgId)).items).toHaveLength(1);
    expect(await second.runs.get(f.scope, f.scope.runId)).toBeDefined();
    const events = (await second.events.listByRun(f.scope)).items;
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
    // Numbering carries on where it stopped, and the idempotency key still holds.
    const c = await second.events.append(makeEvent(f, { idempotencyKey: "c" }));
    expect(c.event.sequence).toBe(2);
    expect((await second.events.append(makeEvent(f, { idempotencyKey: "a" }))).stored).toBe(false);
    expect((await second.orgConfigs.get(orgId))?.version).toBe(1);
    expect(second.size).toBeGreaterThan(0);
    second.close();
  });
});
