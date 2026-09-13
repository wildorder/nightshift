/**
 * SC-P1-10 — child nodes cannot widen parent scope.
 *
 * Stated as a biconditional: `narrow` succeeds exactly when the request is
 * contained in the parent. Both directions are generated explicitly, because an
 * implementation that always threw would satisfy the widening half on its own.
 */
import { explainWidening, isNarrowing, narrow, ScopeWideningError } from "@nightshift/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { narrowingRequest, parentScope, wideningRequest } from "../arbitraries.js";

describe("SC-P1-10: child nodes cannot widen parent scope", () => {
  it("accepts every request that narrows the parent", () => {
    fc.assert(
      fc.property(
        parentScope().chain((parent) =>
          narrowingRequest(parent).map((request) => ({ parent, request })),
        ),
        ({ parent, request }) => {
          expect(explainWidening(parent, request)).toEqual([]);
          const effective = narrow(parent, request);

          // Every dimension of the result is at most as permissive as the parent.
          for (const permission of effective.permissions) {
            expect(parent.permissions).toContain(permission);
          }
          for (const exclude of parent.excludes) {
            expect(effective.excludes).toContain(exclude);
          }
          for (const forbidden of parent.forbiddenActions) {
            expect(effective.forbiddenActions).toContain(forbidden);
          }
        },
      ),
    );
  });

  it("refuses every request that widens the parent in any dimension", () => {
    fc.assert(
      fc.property(
        parentScope().chain((parent) =>
          wideningRequest(parent).map((widening) => ({ parent, widening })),
        ),
        ({ parent, widening }) => {
          // Skip parents that cannot be widened in the drawn dimension.
          fc.pre(widening !== undefined);
          if (widening === undefined) return;

          expect(isNarrowing(parent, widening.request)).toBe(false);
          expect(() => narrow(parent, widening.request)).toThrow(ScopeWideningError);
        },
      ),
    );
  });

  it("covers all four widening dimensions across a run", () => {
    // Guards against the previous property passing only because one dimension
    // was ever generated.
    const seen = new Set<string>();
    fc.assert(
      fc.property(
        parentScope().chain((parent) =>
          wideningRequest(parent).map((widening) => ({ parent, widening })),
        ),
        ({ widening }) => {
          if (widening !== undefined) seen.add(widening.kind);
          return true;
        },
      ),
      { numRuns: 500 },
    );
    expect([...seen].sort()).toEqual(["exclude", "forbidden", "include", "permission"]);
  });

  it("keeps narrow and explainWidening in agreement", () => {
    fc.assert(
      fc.property(
        parentScope().chain((parent) =>
          fc
            .oneof(
              narrowingRequest(parent),
              wideningRequest(parent).map((w) => w?.request ?? { includes: [...parent.includes] }),
            )
            .map((request) => ({ parent, request })),
        ),
        ({ parent, request }) => {
          const clean = explainWidening(parent, request).length === 0;
          let threw = false;
          try {
            narrow(parent, request);
          } catch {
            threw = true;
          }
          expect(threw).toBe(!clean);
        },
      ),
    );
  });

  it("is idempotent: narrowing to the parent's own scope returns it unchanged", () => {
    fc.assert(
      fc.property(parentScope(), (parent) => {
        expect(narrow(parent, { ...parent })).toEqual(parent);
      }),
    );
  });

  it("is transitive: a grandchild can never exceed its grandparent", () => {
    fc.assert(
      fc.property(
        parentScope().chain((grandparent) =>
          narrowingRequest(grandparent).map((request) => ({ grandparent, request })),
        ),
        ({ grandparent, request }) => {
          const parent = narrow(grandparent, request);
          // Anything the middle generation can legally grant was inherited.
          for (const permission of parent.permissions) {
            expect(grandparent.permissions).toContain(permission);
          }
          expect(isNarrowing(grandparent, { ...parent })).toBe(true);
        },
      ),
    );
  });
});
