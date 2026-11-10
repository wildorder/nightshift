/**
 * `nightshift run` of a planned program whose program already has a live run
 * (PIP-9): the refusal is plain, and nothing launches or dispatches.
 */
import type { Dispatch, ExecutionNode, Run } from "@nightshift/contracts";
import {
  createFixtures,
  makeDispatch,
  makeProgramContract,
  makeRootNode,
  makeRun,
  ProgramRunLiveError,
} from "@nightshift/core";
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

/** What the live run is, as the plane holds it: its record, its dispatch, its plan. */
interface LiveRun {
  readonly location: "local" | "remote";
  readonly dispatch?: Partial<Dispatch>;
  /** The plan the live run runs; absent, the one being run now. */
  readonly planHash?: string;
}

const attempt = async (remote: boolean, liveRun: LiveRun = { location: "local" }) => {
  const f = createFixtures();
  const contract = makeProgramContract(f, {
    repository: {
      url: "https://github.com/wildorder/fixture",
      baseBranch: "main",
      programBranch: "program/fixture",
    },
    planHash: "a".repeat(64) as never,
  });
  mocks.ratified = contract;
  mocks.startRun.mockRejectedValue(new ProgramRunLiveError(contract.programId, "run_LIVE"));
  const run: Run = makeRun(f, { status: "running", location: liveRun.location });
  const root: ExecutionNode = makeRootNode(f, {
    plan: {
      planHash: (liveRun.planHash ?? contract.planHash) as never,
      planDocument: { uri: "s3://plans/plan.md", sha256: "b".repeat(64), sizeBytes: 4 },
    },
  });
  const dispatch = liveRun.dispatch === undefined ? undefined : makeDispatch(f, liveRun.dispatch);
  const sent: { method: string; path: string; body?: unknown }[] = [];
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
  const session = {
    stores: {
      runs: { get: async () => run },
      dispatches: { get: async () => dispatch },
      executionNodes: { get: async () => root },
    },
    transport: async (request: { method: string; path: string; body?: unknown }) => {
      sent.push(request);
      return { status: 200, body: {} };
    },
  } as unknown as Session;
  const result = await runProgram(
    environment,
    session,
    { id: "fixture", directory: "docs/programs/fixture", contract, planText: "plan" } as never,
    { repoPath: created.environment.cwd, attended: false, remote },
  );
  return { result, created, exec, contract, sent };
};

describe.each([
  ["nightshift run", false],
  ["nightshift run --remote", true],
])("%s when the program already has a live run", (_name, remote) => {
  it("names the program and the live run, exits non-zero, and launches and dispatches nothing", async () => {
    const { result, created, exec, contract } = await attempt(remote);
    expect(result.exitCode).toBe(1);
    expect(result.started).toBeUndefined();
    void contract;
    expect(created.err).toContain(
      "program fixture already has a live run: run_LIVE, a local run still in progress. Wait for it to end.",
    );
    expect(created.out).toEqual(expect.not.arrayContaining([expect.stringContaining("run_")]));
    expect(exec).not.toHaveBeenCalled();
    expect(mocks.dispatchRun).not.toHaveBeenCalled();
    expect(mocks.watchDispatch).not.toHaveBeenCalled();
  });
});

describe("nightshift run when the program's live run is remote (A-68)", () => {
  it("names a run still on its machine, and the verbs that stop it", async () => {
    const { result, created, sent } = await attempt(true, {
      location: "remote",
      dispatch: { status: "running" },
    });
    expect(result.exitCode).toBe(1);
    expect(created.err.join("\n")).toContain("run_LIVE is running on its machine");
    expect(created.err.join("\n")).toContain("`nightshift remote pause fixture`");
    expect(created.err.join("\n")).toContain("`nightshift remote cancel fixture`");
    expect(sent).toEqual([]);
  });

  it("names a paused run of this plan: resume it, or cancel it", async () => {
    const { result, created, sent } = await attempt(true, {
      location: "remote",
      dispatch: {
        status: "stopped",
        failure: { code: "paused", message: "paused by the operator" },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(created.err.join("\n")).toContain(
      "run_LIVE is paused, its machine stopped (paused by the operator)",
    );
    expect(created.err.join("\n")).toContain("`nightshift remote resume fixture`");
    expect(sent).toEqual([]);
  });

  it("cancels by itself a paused run of an earlier plan, says so, and starts again", async () => {
    const { created, sent } = await attempt(true, {
      location: "remote",
      dispatch: {
        status: "stopped",
        failure: { code: "paused", message: "paused by the operator" },
      },
      planHash: "c".repeat(64),
    });
    expect(created.out.join("\n")).toContain(
      "run_LIVE was paused under an earlier plan; it is cancelled",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST" });
    expect(sent[0]?.path).toMatch(/\/runs\/run_LIVE\/dispatch\/cancel$/);
    expect(sent[0]?.body).toEqual({
      reason: "Superseded: the program was run again under a newer ratified plan.",
    });
    expect(mocks.startRun).toHaveBeenCalledTimes(2);
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
