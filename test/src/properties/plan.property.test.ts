/**
 * P7 — the overlap rule and strand gating, as properties (T1 §3, §4; SC-P7-07).
 *
 * The overlap rule is the check a planner will argue with, so what it promises
 * is pinned: it is symmetric, a dependency in either direction clears a pair,
 * and an exclude that removes the intersection clears it. It is also sound
 * against the matcher the engine enforces scope with: two scopes that both
 * allow some concrete path always overlap.
 */
import type { ProgramContract, Strand, StrandScope } from "@nightshift/contracts";
import {
  blockedBy,
  createFixtures,
  downstreamCone,
  independentOverlaps,
  makeProgramContract,
  mayStartStrand,
  type StrandOutcomes,
  scopeAllowsPath,
  scopesOverlap,
} from "@nightshift/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { literalPath, segment } from "../arbitraries.js";

const globSegment = (): fc.Arbitrary<string> =>
  fc.oneof(
    { weight: 4, arbitrary: segment() },
    { weight: 1, arbitrary: fc.constantFrom("*", "**", "*.ts", "a*", "?pi") },
  );

const glob = (): fc.Arbitrary<string> =>
  fc.array(globSegment(), { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"));

const strandScope = (): fc.Arbitrary<StrandScope> =>
  fc.record({
    summary: fc.constant("generated"),
    includes: fc.array(glob(), { minLength: 1, maxLength: 3 }),
    excludes: fc.array(glob(), { maxLength: 2 }),
  });

/** A glob that matches `path`: each segment kept, loosened to `*`, or the rest cut to `**`. */
const globOver = (path: string): fc.Arbitrary<string> => {
  const parts = path.split("/");
  return fc
    .tuple(
      fc.array(fc.boolean(), { minLength: parts.length, maxLength: parts.length }),
      fc.integer({ min: 1, max: parts.length + 1 }),
    )
    .map(([loosen, cut]) =>
      [
        ...parts.slice(0, cut).map((part, index) => (loosen[index] === true ? "*" : part)),
        ...(cut <= parts.length ? ["**"] : []),
      ].join("/"),
    );
};

/** A scope with an include that matches `path`, among others. */
const scopeOver = (path: string): fc.Arbitrary<StrandScope> =>
  fc.tuple(strandScope(), globOver(path)).map(([scope, include]) => ({
    ...scope,
    includes: [...scope.includes, include],
  }));

const strandOf = (index: number, scope: StrandScope, dependsOn: readonly number[]): Strand => ({
  id: idOf(index),
  name: `Strand ${index}`,
  scope,
  acceptance: ["green"],
  successCriteria: [],
  dependsOn: dependsOn.map(idOf),
  prerequisites: [],
});

const idOf = (index: number): string => `S-${String(index + 1).padStart(2, "0")}`;

/** A random DAG: strand `i` may depend only on strands before it. */
const dag = (): fc.Arbitrary<readonly Strand[]> =>
  fc
    .array(fc.tuple(strandScope(), fc.array(fc.nat(), { maxLength: 3 })), {
      minLength: 1,
      maxLength: 7,
    })
    .map((drawn) =>
      drawn.map(([scope, picks], index) =>
        strandOf(index, scope, index === 0 ? [] : [...new Set(picks.map((pick) => pick % index))]),
      ),
    );

const fixtures = createFixtures();
const contractOf = (strands: readonly Strand[]): ProgramContract =>
  makeProgramContract(fixtures, { status: "planning", strands });

const asScope = (scope: StrandScope) => ({ ...scope, permissions: [], forbiddenActions: [] });

describe("scopesOverlap", () => {
  it("is symmetric", () => {
    fc.assert(
      fc.property(strandScope(), strandScope(), (a, b) => {
        expect(scopesOverlap(a, b)).toBe(scopesOverlap(b, a));
      }),
    );
  });

  it("never misses two scopes that both allow some path", () => {
    fc.assert(
      fc.property(
        literalPath().chain((path) =>
          fc.tuple(fc.constant(path), scopeOver(path), scopeOver(path)),
        ),
        ([path, a, b]) => {
          // Built to allow the path; an unlucky exclude is the only way it would not.
          fc.pre(scopeAllowsPath(asScope(a), path) && scopeAllowsPath(asScope(b), path));
          expect(scopesOverlap(a, b)).toBe(true);
        },
      ),
    );
  });

  it("is cleared by an exclude that removes the intersection", () => {
    fc.assert(
      fc.property(strandScope(), strandScope(), (a, b) => {
        // Excluding everything the other includes removes whatever the two share.
        const fenced = { ...a, excludes: [...a.excludes, ...b.includes] };
        expect(scopesOverlap(fenced, b)).toBe(false);
        expect(scopesOverlap(b, fenced)).toBe(false);
      }),
    );
  });
});

describe("independentOverlaps", () => {
  it("is cleared by a dependsOn in either direction", () => {
    fc.assert(
      fc.property(strandScope(), strandScope(), fc.boolean(), (a, b, forwards) => {
        const pair = forwards
          ? [strandOf(0, a, []), strandOf(1, b, [0])]
          : [strandOf(0, a, [1]), strandOf(1, b, [])];
        expect(independentOverlaps(pair)).toEqual([]);
      }),
    );
  });

  it("reports exactly the overlapping pairs when nothing depends on anything", () => {
    fc.assert(
      fc.property(fc.array(strandScope(), { minLength: 2, maxLength: 5 }), (scopes) => {
        const strands = scopes.map((scope, index) => strandOf(index, scope, []));
        const expected = strands.flatMap((a, i) =>
          strands
            .slice(i + 1)
            .filter((b) => scopesOverlap(a.scope, b.scope))
            .map((b) => [a.id, b.id]),
        );
        expect(independentOverlaps(strands).map((o) => [o.a.id, o.b.id])).toEqual(expected);
      }),
    );
  });
});

type Outcomes = Record<string, StrandOutcomes[string]>;

/**
 * One move of a scheduler that starts and finishes strands in an arbitrary
 * order. Returns the strand it failed, if it failed one; `false` when stuck.
 */
const step = (
  contract: ProgramContract,
  strands: readonly Strand[],
  outcomes: Outcomes,
  pick: number,
  fail: boolean,
): string | boolean => {
  const running = strands.filter((s) => outcomes[s.id] === "running");
  const startable = strands.filter((s) => mayStartStrand(contract, outcomes, s.id).start);
  const moves = [...running, ...startable];
  const strand = moves[pick % Math.max(moves.length, 1)];
  if (strand === undefined) return false;

  if (outcomes[strand.id] === "running") {
    outcomes[strand.id] = fail ? "failed" : "succeeded";
    return fail ? strand.id : true;
  }
  // The property: whatever order things finished in, its dependencies succeeded first.
  for (const dependency of strand.dependsOn) expect(outcomes[dependency]).toBe("succeeded");
  outcomes[strand.id] = "running";
  return true;
};

/** Blocked is exactly the cone of what failed, and none of it ever started. */
const expectExactlyTheConesParked = (
  contract: ProgramContract,
  outcomes: Outcomes,
  failed: readonly string[],
): void => {
  const cones = new Set(failed.flatMap((id) => downstreamCone(contract, id)));
  const blocked = blockedBy(contract, outcomes);
  expect([...blocked.keys()].sort()).toEqual([...cones].sort());
  for (const [id, blockers] of blocked) {
    expect(outcomes[id]).toBeUndefined();
    for (const blocker of blockers) expect(failed).toContain(blocker);
  }
};

describe("SC-P7-07: a strand never starts before what it depends on has succeeded", () => {
  it("holds under any finishing order, and parks exactly the cone of what fails", () => {
    fc.assert(
      fc.property(
        dag(),
        fc.array(fc.tuple(fc.nat(), fc.boolean()), { minLength: 40, maxLength: 40 }),
        (strands, moves) => {
          const contract = contractOf(strands);
          const outcomes: Outcomes = {};
          const failed: string[] = [];
          for (const [pick, fail] of moves) {
            const moved = step(contract, strands, outcomes, pick, fail);
            if (moved === false) break;
            if (typeof moved === "string") failed.push(moved);
          }

          expectExactlyTheConesParked(contract, outcomes, failed);
        },
      ),
    );
  });
});
