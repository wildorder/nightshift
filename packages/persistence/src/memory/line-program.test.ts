import { ProgramContractSchema } from "@nightshift/contracts";
import {
  createFixtures,
  ensureLineProgram,
  isLineProgram,
  LINE_PROGRAM_CRITERION,
  lineProgramId,
  makeProgramContract,
  mayRunContract,
} from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { createInMemoryStores } from "./index.js";

const NOW = "2026-10-01T12:00:00.000Z";
const BRANCH = "nightshift/develop";

const naming = () => {
  const f = createFixtures();
  return { f, contract: makeProgramContract(f, { line: { branch: BRANCH } }) };
};

describe("ensureLineProgram", () => {
  it("writes the honest contract, once, however it is asked", async () => {
    const { f, contract } = naming();
    const stores = createInMemoryStores();
    const input = { projectId: f.scope.projectId, naming: contract, createdAt: NOW };
    const [a, b] = await Promise.all([
      ensureLineProgram(stores, input),
      ensureLineProgram(stores, input),
    ]);
    const c = await ensureLineProgram(stores, input);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(a.programId).toBe(lineProgramId(f.scope.projectId, BRANCH));
    expect(a.repository.programBranch).toBe(BRANCH);
    expect(a.kind).toBe("line");
    expect(a.successCriteria.map((x) => x.outcome)).toEqual([LINE_PROGRAM_CRITERION]);
    expect(a.strands).toBeUndefined();
    expect(ProgramContractSchema.safeParse(a).success).toBe(true);
    expect(isLineProgram(a)).toBe(true);
    expect(isLineProgram(contract)).toBe(false);
    const listed = await stores.programContracts.listByProject(f.scope.projectId);
    expect(listed.items).toHaveLength(1);
  });

  it("returns the winner when a create loses the race", async () => {
    const { f, contract } = naming();
    const stores = createInMemoryStores();
    const input = { projectId: f.scope.projectId, naming: contract, createdAt: NOW };
    const winner = await ensureLineProgram(stores, {
      ...input,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const realGet = stores.programContracts.get.bind(stores.programContracts);
    let first = true;
    stores.programContracts.get = async (p, id) => {
      if (first) {
        first = false;
        return undefined;
      }
      return realGet(p, id);
    };
    expect(await ensureLineProgram(stores, input)).toEqual(winner);
  });
});

describe("mayRunContract", () => {
  it("runs a line contract unratified, and leaves the rest alone", async () => {
    const { f, contract } = naming();
    const stores = createInMemoryStores();
    const line = await ensureLineProgram(stores, {
      projectId: f.scope.projectId,
      naming: contract,
      createdAt: NOW,
    });
    expect(mayRunContract(line)).toBe(true);
    const planned = makeProgramContract(f, {
      status: "planning",
      strands: [
        {
          id: "S-01",
          name: "s",
          scope: { summary: "x", includes: ["a/**"], excludes: [] },
          acceptance: ["g"],
          successCriteria: [],
          dependsOn: [],
          prerequisites: [],
        },
      ],
    });
    expect(mayRunContract(planned)).toBe(false);
    expect(mayRunContract(contract)).toBe(true);
  });
});
