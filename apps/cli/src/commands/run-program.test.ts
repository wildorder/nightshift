/**
 * `nightshift run` of a planned program whose program already has a live run
 * (PIP-9): the refusal is plain, and nothing launches or dispatches.
 */
import { createFixtures, makeProgramContract, ProgramRunLiveError } from "@nightshift/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../session.js";
import { createTestEnvironment, type TestEnvironment } from "../testing/harness.js";

const mocks = vi.hoisted(() => ({
  startRun: vi.fn(),
  dispatchRun: vi.fn(),
  assertDispatchable: vi.fn(),
  watchDispatch: vi.fn(),
  ratified: undefined as unknown,
}));

vi.mock("@nightshift/execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nightshift/execution")>()),
  requireRatifiedPlan: async () => mocks.ratified,
  runPreflight: async () => ({ pending: [] }),
  startRun: mocks.startRun,
}));
vi.mock("./gates.js", () => ({
  auditProgramGates: async () => ({ red: false, failing: [] }),
  describeAudit: () => undefined,
}));
vi.mock("../program-branch.js", () => ({
  ensureProgramBranch: async () => undefined,
  checkOutProgramBranch: async () => undefined,
}));
vi.mock("./remote.js", () => ({
  assertRemoteReady: async () => ({
    repositoryUrl: "https://github.com/wildorder/fixture",
    branch: "program/fixture",
    baseSha: "a".repeat(40),
    tier: "good",
    source: "default",
  }),
  dispatchRun: mocks.dispatchRun,
  assertDispatchable: mocks.assertDispatchable,
}));
vi.mock("./watch.js", () => ({ watchDispatch: mocks.watchDispatch }));

const { runProgram } = await import("./run-program.js");

const live: TestEnvironment[] = [];
beforeEach(() => {
  mocks.startRun.mockReset();
  mocks.dispatchRun.mockReset();
  mocks.assertDispatchable.mockReset();
  mocks.watchDispatch.mockReset();
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
});

const attempt = async (remote: boolean) => {
  const f = createFixtures();
  const contract = makeProgramContract(f, {
    repository: {
      url: "https://github.com/wildorder/fixture",
      baseBranch: "main",
      programBranch: "program/fixture",
    },
  });
  mocks.ratified = contract;
  mocks.startRun.mockRejectedValue(new ProgramRunLiveError(contract.programId, "run_LIVE"));
  const created = await createTestEnvironment({
    git: async () => ({ stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 }),
  });
  live.push(created);
  const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const environment = {
    ...created.environment,
    exec,
    assets: { orchestratePath: "orchestrate.js", skillsDir: "skills", mcpServerPath: "mcp.js" },
  } as typeof created.environment;
  const session = { stores: {}, transport: {} } as unknown as Session;
  const result = await runProgram(
    environment,
    session,
    { id: "fixture", directory: "docs/programs/fixture", contract, planText: "plan" } as never,
    { repoPath: created.environment.cwd, attended: false, remote },
  );
  return { result, created, exec, contract };
};

describe.each([
  ["nightshift run", false],
  ["nightshift run --remote", true],
])("%s when the program already has a live run", (_name, remote) => {
  it("names the program and the live run, exits non-zero, and launches and dispatches nothing", async () => {
    const { result, created, exec, contract } = await attempt(remote);
    expect(result.exitCode).toBe(1);
    expect(result.started).toBeUndefined();
    expect(created.err).toContain(
      `program ${contract.programId} already has a live run run_LIVE; ` +
        "wait for it to end or cancel it before starting another",
    );
    expect(created.out).toEqual(expect.not.arrayContaining([expect.stringContaining("run_")]));
    expect(exec).not.toHaveBeenCalled();
    expect(mocks.dispatchRun).not.toHaveBeenCalled();
    expect(mocks.watchDispatch).not.toHaveBeenCalled();
  });
});

describe("nightshift run --remote that the CLI can refuse", () => {
  it("refuses before the run exists, so no run holds the program (2026-10-28)", async () => {
    mocks.assertDispatchable.mockRejectedValue(new Error("the tier is over the org's ceiling"));
    await expect(attempt(true)).rejects.toThrow("the tier is over the org's ceiling");
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.dispatchRun).not.toHaveBeenCalled();
  });
});
