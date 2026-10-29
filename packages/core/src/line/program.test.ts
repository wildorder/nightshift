import { ProgramIdSchema } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, makeProgramContract } from "../testing/index.js";
import { isLineProgram, lineProgramId } from "./program.js";

const BRANCH = "nightshift/develop";

const naming = () => {
  const f = createFixtures();
  return { f, contract: makeProgramContract(f, { line: { branch: BRANCH } }) };
};

describe("lineProgramId", () => {
  it("is a valid, stable ProgramId that differs by branch", () => {
    const { f } = naming();
    const id = lineProgramId(f.scope.projectId, BRANCH);
    expect(ProgramIdSchema.safeParse(id).success).toBe(true);
    expect(lineProgramId(f.scope.projectId, BRANCH)).toBe(id);
    expect(lineProgramId(f.scope.projectId, "other")).not.toBe(id);
  });

  it("is derived from a SHA-256 of the project and branch", () => {
    // Fixed so a stored line program is found again: the derivation never changes.
    expect(lineProgramId("proj_01J0000000000000000000000A" as never, "nightshift/develop")).toBe(
      "prog_9HAW3NPFREA27HCFGYNAPYMG0R",
    );
  });
});

describe("isLineProgram", () => {
  it("tells a line contract from the contract that named it", () => {
    const { contract } = naming();
    expect(isLineProgram(contract)).toBe(false);
    expect(isLineProgram({ ...contract, kind: "line" })).toBe(true);
  });
});
