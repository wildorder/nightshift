/**
 * The route table against `core`'s operation union (T1 deliverable 4, T3
 * deliverable 3).
 *
 * `core` cannot import `apps/api`, so this is the half that lives here: every
 * route names an `Operation`, and the table is **total** over the union — no
 * operation exists that no route serves, and no route names one twice. That is
 * what makes `EXECUTION_ACCESS` in `core` a complete statement about the API
 * rather than a list of the routes someone remembered.
 */
import { ALL_OPERATIONS, type Operation } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { ROUTES } from "./handler.js";

const declared = ROUTES.map((route) => route.operation);

describe("the route table", () => {
  it("names an operation on every route", () => {
    for (const route of ROUTES) {
      expect(route.operation, `${route.method} ${route.path}`).toBeTruthy();
    }
  });

  it("is total over the operation union: every operation has a route", () => {
    const missing = ALL_OPERATIONS.filter((operation) => !declared.includes(operation));
    expect(missing).toEqual([]);
  });

  it("names no operation that `core` does not know", () => {
    const unknown = declared.filter(
      (operation) => !(ALL_OPERATIONS as readonly string[]).includes(operation),
    );
    expect(unknown).toEqual([]);
  });

  it("uses each operation exactly once, so an authorisation decision names one route", () => {
    const seen = new Map<Operation, number>();
    for (const operation of declared) seen.set(operation, (seen.get(operation) ?? 0) + 1);
    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
  });

  it("has as many routes as operations", () => {
    expect(ROUTES).toHaveLength(ALL_OPERATIONS.length);
  });
});
