/**
 * One `TableClient` over several fake tables, routed by `TableName` (P10).
 *
 * The credentials table (D-P10-23) is a second DynamoDB table reached through
 * the same client as the main one. A `FakeTable` is one table, so the offline
 * suites that hold the adapter to both need this: each call goes to the fake
 * whose name it carries, and a name nobody registered is the same
 * `ResourceNotFoundException` DynamoDB would raise. A transaction may name one
 * table only, which is all the adapter ever asks of one.
 */
import type { TableClient } from "../table-client.js";
import type { FakeTable } from "./fake-table.js";

const notFound = (tableName: string | undefined): Error =>
  Object.assign(new Error(`Requested resource not found: ${String(tableName)}`), {
    name: "ResourceNotFoundException",
  });

export const routingTableClient = (tables: Readonly<Record<string, FakeTable>>): TableClient => {
  const of = (tableName: string | undefined): FakeTable => {
    const table = tableName === undefined ? undefined : tables[tableName];
    if (table === undefined) throw notFound(tableName);
    return table;
  };
  return {
    get: (input) => of(input.TableName).get(input),
    put: (input) => of(input.TableName).put(input),
    update: (input) => of(input.TableName).update(input),
    delete: (input) => of(input.TableName).delete(input),
    query: (input) => of(input.TableName).query(input),
    scan: (input) => of(input.TableName).scan(input),
    transactWrite: (input) => {
      const names = new Set(
        (input.TransactItems ?? []).map(
          (item) =>
            item.Put?.TableName ??
            item.Update?.TableName ??
            item.Delete?.TableName ??
            item.ConditionCheck?.TableName,
        ),
      );
      if (names.size !== 1) {
        throw Object.assign(new Error("a transaction here names exactly one table"), {
          name: "ValidationException",
        });
      }
      return of([...names][0]).transactWrite(input);
    },
  };
};
