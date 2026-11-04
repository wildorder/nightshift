/** The words a person reads for the line's candidate (P25, D-P25-13). */
import type { LineCandidate } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { candidateWords } from "./line-row.js";

const MAIN = "9".repeat(40);
const candidate = (overrides: Partial<LineCandidate>): LineCandidate =>
  ({
    candidateId: "cand_01J00000000000000000000000",
    commit: "abcdef1234".padEnd(40, "0"),
    mainAt: MAIN,
    programs: [{ program: "prog_01J00000000000000000000000", upTo: "2".repeat(40) }],
    state: "qualified",
    runId: "run_01J00000000000000000000000",
    createdAt: "2026-11-04T12:00:00.000Z",
    updatedAt: "2026-11-04T12:00:00.000Z",
    ...overrides,
  }) as LineCandidate;
const pr = { number: 7, url: "https://github.com/x/y/pull/7", branch: "b" };
const waiting = { mainSeen: MAIN as never, undeployed: [{} as never] };

describe("candidateWords", () => {
  it("offers Deploy only for a qualified candidate with its pull request that main has not moved past", () => {
    expect(candidateWords(waiting, candidate({ pr }))).toMatchObject({
      says: "Ready to deploy.",
      deployable: true,
    });
    expect(
      candidateWords({ ...waiting, mainSeen: "8".repeat(40) as never }, candidate({ pr })),
    ).toMatchObject({
      says: "Updating: main changed, Nightshift is re-checking.",
      deployable: false,
    });
    expect(candidateWords(waiting, candidate({}))).toMatchObject({
      says: "Opening its pull request.",
      deployable: false,
    });
  });

  it("says when an engineer is needed, and why", () => {
    expect(
      candidateWords(waiting, candidate({ state: "failed", detail: "failing gates: e2e" })).says,
    ).toBe("Needs an engineer: failing gates: e2e.");
    expect(
      candidateWords(
        waiting,
        candidate({ prDetail: "the Nightshift App has not been granted Pull requests" }),
      ),
    ).toMatchObject({ tone: "attention", deployable: false });
  });

  it("says what is happening otherwise", () => {
    expect(candidateWords(waiting, candidate({ state: "qualifying" })).says).toContain("Checking");
    expect(candidateWords(waiting, candidate({ state: "deploying", pr })).says).toContain(
      "Deploying",
    );
    expect(candidateWords({ undeployed: [] }, undefined).says).toBe("Nothing is waiting to ship.");
    expect(candidateWords(waiting, undefined).says).toContain("Preparing");
    expect(candidateWords({ undeployed: [] }, candidate({ state: "deployed" })).says).toBe(
      "Deployed. Nothing new is waiting to ship.",
    );
  });
});
