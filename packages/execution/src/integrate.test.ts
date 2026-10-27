/** Which verifications integrate accepts as evidence for landing. */
import { describe, expect, it } from "vitest";
import { integrateNode } from "./integrate.js";

const COMMIT = "a".repeat(40);

const integrateWith = (phase: string | undefined) => {
  const node = { status: "verified", commitSha: COMMIT };
  const verification = { commitSha: COMMIT, outcome: "passed", ...(phase ? { phase } : {}) };
  const environment = {
    stores: {
      executionNodes: { get: async () => node },
      verifications: { listByNode: async () => [verification] },
    },
  };
  const input = { session: { scope: {} }, nodeId: "n", commitSha: COMMIT };
  return integrateNode(environment as never, input as never);
};

describe("integrate's evidence", () => {
  it("refuses a passing candidate verification for the commit", async () => {
    expect(await integrateWith("candidate")).toEqual({
      kind: "refused",
      reason: "no passing queue verification exists for this commit",
    });
  });

  it("refuses a passing run verification for the commit", async () => {
    expect(await integrateWith("run")).toMatchObject({ kind: "refused" });
  });
});
