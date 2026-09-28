/**
 * Decisions and corrections, for real (P9 T5, SC-P9-12).
 *
 *   AWS_PROFILE=nightshift npm run correction
 *
 * A real Claude Code worker, against the deployed control plane, does a job
 * that records a decision, and plants something a check refuses. The check
 * needs a human prerequisite, so it defers and the run ends deferred. The
 * prerequisite is met; `nightshift-resume` runs the check, which fails, and
 * retries the node as a run would, a real worker told what failed; it lands.
 * Then: the decision is stamped with the commit that landed, the owner's
 * reversal is accepted and a rewrite of the decision refused by the deployed
 * API, and the report shows the decision graph with the reversal.
 *
 * Never part of `npm test`, never in CI.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Decision, ExecutionNodeId } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { gatherReport, renderReport } from "@nightshift/execution";
import { createHttpPlanning } from "@nightshift/persistence/http";
import { startOrchestrator } from "@nightshift/test/slice";
import { sanitizeEnvironment } from "@nightshift/verification";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DeployedSlice, openDeployedSlice } from "./deployed-slice.js";

const RESUME = fileURLToPath(
  new URL("../../../mcp/dist/bin/nightshift-resume.js", import.meta.url),
);

/** Refuses the marker the job is told to plant, once it can run at all. */
const GATE = `import { existsSync } from "node:fs";
if (existsSync("src/marker.txt")) {
  console.error("src/marker.txt must not exist: delete it");
  process.exit(1);
}
`;

const lines: string[] = [];
const startedAt = Date.now();
let slice: DeployedSlice;

const say = (line: string): void => {
  lines.push(line);
  slice?.say(line);
};

beforeAll(async () => {
  slice = await openDeployedSlice({
    label: "correction",
    modelPolicy: {
      allowedProviders: ["anthropic", "openai"],
      allowedModels: [],
      forbiddenModels: [],
    },
    verification: [
      { id: "test", command: "node --test" },
      { id: "gate", command: "node scripts/gate.mjs", requires: ["HP-01"] },
    ],
    files: { "scripts/gate.mjs": GATE },
    prerequisites: [
      {
        id: "HP-01",
        description: "The gate may run.",
        remediation: "Say so.",
        verifyCommand: 'node -e "process.exit(0)"',
        status: "pending",
      },
    ],
  });
});

afterAll(async () => {
  try {
    await slice?.cleanup();
  } finally {
    process.stdout.write(
      `\n[correction] summary\n${lines.map((line) => `  ${line}`).join("\n")}\n` +
        `[correction] total ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`,
    );
  }
});

const resume = (scope: RunScope, repo: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        RESUME,
        "--project",
        scope.projectId,
        "--program",
        scope.programId,
        "--run",
        scope.runId,
        "--repo",
        repo,
      ],
      {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...sanitizeEnvironment({
            platform: process.platform,
            parentEnv: process.env,
            extra: undefined,
          }),
          ...slice.context.serverEnv,
        },
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const last = out.trim().split("\n").at(-1) ?? "";
      try {
        resolve(JSON.parse(last) as Record<string, unknown>);
      } catch {
        reject(new Error(`nightshift-resume exited ${code}: ${err.slice(-1500)}`));
      }
    });
  });

describe("a decision stamped, a failed check retried at resume, and a reversal, against the deployed control plane", () => {
  it("runs, defers, retries at resume with a real worker, stamps, and takes the owner's reversal", async () => {
    const began = Date.now();
    const mcp = await startOrchestrator({ context: slice.context, harness: "claude" });
    const run = await mcp.call("run.start", {
      programContractPath: "nightshift.program.json",
      model: "claude-opus-5-5",
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    const scope: RunScope = {
      projectId: slice.projectId,
      programId: slice.context.program.programId,
      runId: String(run.runId) as never,
    };
    slice.track(scope);

    const delegated = await mcp.call("delegate", {
      objective:
        "Add src/half.js exporting half(n) that returns n / 2, and test/half.test.js testing " +
        "half(8) === 4. Also create src/marker.txt containing the word marker. Before you " +
        "complete, record one decision with decision.record: how you implemented half, with at " +
        "least one alternative you rejected and why.",
      scope: { includes: ["src/**", "test/**"] },
      acceptance: ["half(8) returns 4", "node --test passes"],
      risk: "low",
      ambiguity: "low",
      testability: "strong",
      jobKind: "implement",
    });
    expect(delegated.ok, JSON.stringify(delegated)).toBe(true);
    const jobId = String(delegated.jobId);
    const nodeId = String(delegated.nodeId) as ExecutionNodeId;
    let waited = await mcp.call("job.wait", { jobId });
    while (waited.settled !== true) waited = await mcp.call("job.wait", { jobId });
    say(`first attempt: ${String(waited.status)} in ${((Date.now() - began) / 1000).toFixed(1)} s`);
    expect(waited.status).toBe("deferred");
    // An unplanned run has no provisional strand to finish as deferred: the
    // session ends, and the deferred node waits on the line for resume.
    await mcp.close().catch(() => {});

    // The human is back.
    await createHttpPlanning({ transport: slice.context.transport }).recordCheck(
      { projectId: scope.projectId, programId: scope.programId },
      "HP-01",
      0,
    );
    const resumed = await resume(scope, slice.context.fixture.repo);
    say(`resume: ${JSON.stringify(resumed)} after ${((Date.now() - began) / 1000).toFixed(1)} s`);
    expect(resumed).toMatchObject({ landed: [nodeId], retried: [nodeId], failed: [] });

    // Stamped with the commit that landed.
    const stores = slice.context.stores;
    const node = await stores.executionNodes.get(scope, nodeId as never);
    expect(node?.status).toBe("integrated");
    const decisions = (await stores.decisions.listByRun(scope)).items;
    const decision = decisions.find(
      (candidate) => candidate.executionNodeId === nodeId && candidate.authority === "agent",
    ) as Decision | undefined;
    say(
      `decision: ${decision?.context} → ${decision?.choice}; produced ${JSON.stringify(decision?.produced)}`,
    );
    expect(decision?.produced).toEqual({ commits: [node?.commitSha] });
    expect(decision?.checkpointAfter).toBeDefined();

    // The owner's reversal, accepted; a rewrite of the decision, refused.
    const reversal: Decision = {
      ...(decision as Decision),
      decisionId: slice.context.ids.next("dec") as never,
      agentId: null,
      context: `The owner reversed ${decision?.decisionId}`,
      alternatives: [
        { summary: String(decision?.choice), rejectedBecause: "the live suite says so" },
      ],
      choice: "the rejected alternative",
      rationale: "the live suite says so",
      authority: "human",
      supersedesDecisionId: decision?.decisionId ?? null,
      checkpointAfter: undefined,
      produced: undefined,
    };
    const { checkpointAfter: _a, produced: _p, ...record } = reversal;
    await stores.decisions.put(record as Decision);
    await expect(
      stores.decisions.put({ ...(decision as Decision), rationale: "rewritten" }),
    ).rejects.toThrow();

    const report = renderReport(await gatherReport(stores, scope));
    expect(report).toContain("## Decision graph");
    expect(report).toContain("**Reversed by you**");
    say(`report: decision graph with the reversal; ${report.length} characters`);
  }, 1_800_000);
});
