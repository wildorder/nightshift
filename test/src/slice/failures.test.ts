/**
 * SC-P3-07 and SC-P3-13: the two ways a job that *finished* still does not
 * integrate.
 *
 * Both are cases where the worker did its job and reported success. One wrote a
 * test that fails; the other touched a file it had no authority over. Neither is
 * caught by asking the worker — which is the point of having verification and a
 * scope check at all.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeGitRunner, revParse, sealedRef, tryRevParse } from "@nightshift/execution";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalContext,
  type Orchestrator,
  type SliceContext,
  startOrchestrator,
} from "./context.js";
import { PROGRAM_BRANCH } from "./fixture-repo.js";

let context: SliceContext | undefined;
let mcp: Orchestrator | undefined;

const ctx = (): SliceContext => {
  if (context === undefined) throw new Error("the slice context did not start");
  return context;
};

beforeEach(async () => {
  context = await createLocalContext();
});

afterEach(async () => {
  await mcp?.close().catch(() => {});
  mcp = undefined;
  await context?.close().catch(() => {});
});

const runJobWith = async (script: "implement-broken" | "out-of-scope") => {
  mcp = await startOrchestrator({ context: ctx(), script });
  const started = await mcp.call("run.start", {
    programContractPath: "nightshift.program.json",
    model: "claude-sonnet-5",
  });
  const job = await mcp.call("delegate", {
    objective: "Add a median helper to src/math.js, with tests.",
    scope: { includes: ["src/**", "test/**"] },
    acceptance: ["median([3,1,2]) is 2", "the existing tests still pass"],
  });
  expect(job.ok, JSON.stringify(job)).toBe(true);

  let report = await mcp.call("job.wait", { jobId: job.jobId });
  while (report.timedOut === true) report = await mcp.call("job.wait", { jobId: job.jobId });

  return {
    report,
    job,
    scope: {
      projectId: ctx().program.projectId,
      programId: ctx().program.programId,
      runId: String(started.runId) as never,
    },
  };
};

/** The branch has not moved, nothing is sealed, and no checkpoint was added. */
const expectNothingIntegrated = async (
  scope: Awaited<ReturnType<typeof runJobWith>>["scope"],
  nodeId: string,
) => {
  expect(await revParse(nodeGitRunner, ctx().fixture.repo, PROGRAM_BRANCH)).toBe(
    ctx().fixture.baseCommit,
  );
  expect(await tryRevParse(nodeGitRunner, ctx().fixture.repo, sealedRef(nodeId))).toBeUndefined();
  const checkpoints = await ctx().stores.checkpoints.listByRun(scope);
  // Only the one `run.start` created, at the base.
  expect(checkpoints.items).toHaveLength(1);
  expect(checkpoints.items[0]?.commitSha).toBe(ctx().fixture.baseCommit);
};

describe("SC-P3-07: an intentionally failing test blocks integration", () => {
  it("ends verification_failed, names the step, keeps the log, and moves nothing", async () => {
    const { report, scope } = await runJobWith("implement-broken");

    expect(report.status, JSON.stringify(report)).toBe("verification_failed");
    expect(String(report.outcomeReason)).toContain("test");

    // The worker's own claim was `implemented` — and that was not enough.
    const verifications = await ctx().stores.verifications.listByNode(
      scope,
      String(report.nodeId) as never,
    );
    expect(verifications).toHaveLength(1);
    const verification = verifications[0];
    expect(verification?.outcome).toBe("failed");

    const failing = (verification?.commands ?? []).filter((command) => command.exitCode !== 0);
    expect(failing.map((command) => command.stepId)).toEqual(["test"]);
    // The second step still ran: a reader wants to know whether the shape check
    // also broke, not only that the first thing that failed failed.
    expect(verification?.commands).toHaveLength(2);

    // The log is an artifact, and it holds what `node --test` actually printed.
    const artifactId = failing[0]?.logArtifactId;
    expect(artifactId).toBeDefined();
    const log = await ctx().readArtifact(scope, String(artifactId));
    expect(log).toContain("# fail 1");

    await expectNothingIntegrated(scope, String(report.nodeId));
    // And the operator's checkout never saw the median helper at all.
    const math = await readFile(join(ctx().fixture.repo, "src", "math.js"), "utf8");
    expect(math).not.toContain("median");
  });
});

describe("SC-P3-13: a change outside the effective scope never integrates", () => {
  it("fails at completion, names the offending path, and moves nothing", async () => {
    const { report, scope } = await runJobWith("out-of-scope");

    expect(report.status, JSON.stringify(report)).toBe("failed");
    expect(String(report.outcomeReason)).toContain("README.md");
    expect(String(report.outcomeReason)).toContain("outside the job's effective scope");

    // It never reached `implemented`, so it was never verified — the scope check
    // is before verification, not a filter after it.
    expect(
      await ctx().stores.verifications.listByNode(scope, String(report.nodeId) as never),
    ).toEqual([]);

    await expectNothingIntegrated(scope, String(report.nodeId));

    // The operator's README is exactly as it was, and so is src/math.js: the
    // in-scope part of the job is discarded with the out-of-scope part, because
    // the commit is all-or-nothing.
    const readme = await readFile(join(ctx().fixture.repo, "README.md"), "utf8");
    expect(readme).not.toContain("a worker that strayed");
    const math = await readFile(join(ctx().fixture.repo, "src", "math.js"), "utf8");
    expect(math).not.toContain("median");
  });
});
