/**
 * The deployed slice (T9 deliverable 4, T10 deliverables 1 and 2).
 *
 * The same job, the same fixture and the same real server binary as the offline
 * suite — against the **deployed control plane**, with a real Cognito token,
 * real DynamoDB, real S3 and real presigned uploads.
 *
 *   AWS_PROFILE=nightshift npm run slice
 *
 * ## Why it lives here rather than in `test/`
 *
 * It needs the AWS SDK: a machine token, S3 reads for artifact bodies, and
 * cleanup. `test/` may not import `@nightshift/persistence/aws` (AR-4), and
 * quite rightly — so the *shape* of a slice context is exported from
 * `@nightshift/test/slice` and the AWS-specific construction is here, beside the
 * smoke suite, in the one package allowed to reach AWS.
 *
 * ## What it writes, and what it removes
 *
 * A throwaway `slice-<ulid>` project, a membership for the machine principal if
 * it needs one, and everything one run produces. Cleanup runs even when an
 * assertion fails, and **reports its own failure rather than swallowing it**
 * (P2 T7): litter in the only account matters more with one account, not less.
 */
import type { ModelPolicy } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { git, nodeGitRunner, revParse, sealedRef, tryRevParse } from "@nightshift/execution";
import {
  type MaterialisedRepo,
  type Orchestrator,
  PROGRAM_BRANCH,
  type SliceContext,
  sliceHarness,
  startOrchestrator,
} from "@nightshift/test/slice";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DeployedSlice, openDeployedSlice } from "./deployed-slice.js";

const startedAt = Date.now();
const harness = sliceHarness();

/**
 * Harness choice is configuration (SC-P5-16): the `codex` phase changes the
 * program's model policy and nothing else. The job, the fixture, the server and
 * every assertion below are the ones the `claude` phase runs.
 */
const POLICY_FOR: Readonly<Record<string, ModelPolicy | undefined>> = {
  codex: { allowedProviders: ["openai"], allowedModels: [], forbiddenModels: [] },
};

let slice: DeployedSlice;
let fixture: MaterialisedRepo;
let context: SliceContext;
let environment: { readonly apiEndpoint: string };
let projectId: DeployedSlice["projectId"];
let stores: SliceContext["stores"];
let mcp: Orchestrator | undefined;
/** Every run this file created, so cleanup can find their partitions. */
const runScopes: RunScope[] = [];

const say = (line: string): void => slice.say(line);

beforeAll(async () => {
  const modelPolicy = POLICY_FOR[harness];
  slice = await openDeployedSlice({
    label: "slice",
    ...(modelPolicy === undefined ? {} : { modelPolicy }),
  });
  say(`harness ${harness}`);
  context = slice.context;
  fixture = context.fixture;
  stores = context.stores;
  projectId = slice.projectId;
  environment = { apiEndpoint: slice.apiEndpoint };
});

afterAll(async () => {
  await mcp?.close().catch(() => {});
  try {
    await slice?.cleanup();
  } finally {
    slice?.say(`runtime ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  }
});

const DELEGATION = {
  objective: "Add a median helper to src/math.js, with tests for odd and even lengths.",
  acceptance: ["median([3,1,2]) is 2", "median([1,2,3,4]) is 2.5", "the existing tests still pass"],
};

describe(`the deployed slice, with the ${harness} harness`, () => {
  it("runs one job from delegation to an integrated, checkpointed commit", async () => {
    const started = Date.now();
    mcp = await startOrchestrator({ context, script: "implement", harness });

    const run = await mcp.call("run.start", {
      programContractPath: "nightshift.program.json",
      model: "claude-sonnet-5",
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    const scope: RunScope = {
      projectId,
      programId: context.program.programId,
      runId: String(run.runId) as never,
    };
    runScopes.push(scope);
    slice.track(scope);
    say(`run ${scope.runId}; root node ${String(run.rootNodeId)}`);

    const delegatedAt = Date.now();
    const job = await mcp.call("delegate", DELEGATION);
    expect(job.ok, JSON.stringify(job)).toBe(true);
    say(
      `job ${String(job.jobId)}; node ${String(job.nodeId)}; agent ${String(job.agentId)}; ` +
        `worker started in ${Date.now() - delegatedAt} ms`,
    );

    let report = await mcp.call("job.wait", { jobId: job.jobId });
    while (report.timedOut === true) report = await mcp.call("job.wait", { jobId: job.jobId });
    say(`job settled as ${String(report.status)} after ${Date.now() - delegatedAt} ms`);

    expect(report.status, JSON.stringify(report)).toBe("integrated");
    const sha = String(report.commitSha);

    // --- The same assertions the offline suite makes, against real AWS -------
    expect(await revParse(nodeGitRunner, fixture.repo, PROGRAM_BRANCH)).toBe(sha);
    expect(await tryRevParse(nodeGitRunner, fixture.repo, sealedRef(String(report.nodeId)))).toBe(
      sha,
    );
    const commit = await git(nodeGitRunner, ["log", "-1", "--format=%an%n%B", sha], {
      cwd: fixture.repo,
    });
    expect(commit).toContain("Nightshift");
    expect(commit).toContain(`Nightshift-Run: ${scope.runId}`);

    const verifications = await stores.verifications.listByNode(
      scope,
      String(report.nodeId) as never,
    );
    expect(verifications[0]?.outcome).toBe("passed");
    expect(verifications[0]?.commands).toHaveLength(2);

    // The log really is in S3, fetched by its recorded key.
    const logArtifactId = verifications[0]?.commands[0]?.logArtifactId;
    expect(logArtifactId).toBeDefined();
    const log = await context.readArtifact(scope, String(logArtifactId));
    expect(log, "the verification log is readable from S3 by its recorded URI").toContain("# pass");

    const artifacts = await stores.artifacts.listByRun(scope);
    say(
      `artifacts: ${artifacts.items.map((artifact) => `${artifact.kind}=${artifact.sizeBytes}B`).join(", ")}`,
    );

    // --- Routing usage, for the as-built -------------------------------------
    const routing = await stores.routingDecisions.listByNode(scope, String(report.nodeId) as never);
    say(
      `routing ${routing[0]?.ruleId ?? "?"} chose ${routing[0]?.chosen.model ?? "?"}; ` +
        `usage ${JSON.stringify(routing[0]?.usage ?? {})}`,
    );

    const finished = await mcp.call("run.finish", { outcome: "succeeded" });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);

    say(`total wall clock ${((Date.now() - started) / 1000).toFixed(1)} s`);
    say(
      `READ IT BACK: GET ${environment.apiEndpoint}/projects/${projectId}/programs/${scope.programId}/runs/${scope.runId}/state`,
    );
  });

  /**
   * The lifecycle, reconstructed from the event stream alone (SC-P3-16's
   * "readable from `GET …/state` and `GET …/events`").
   */
  it("leaves a lifecycle a reader can reconstruct from events alone", async () => {
    const scope = runScopes[0];
    expect(scope, "the first test must have run").toBeDefined();
    if (scope === undefined) return;

    await context.settle();
    const events = (await stores.events.listByRun(scope)).items;
    const types = events.map((event) => event.type);

    for (const expected of [
      "run.created",
      "run.started",
      "node.delegated",
      "node.queued",
      "agent.created",
      "routing.decided",
      "node.started",
      "agent.started",
      "node.implemented",
      "verification.requested",
      "verification.completed",
      "node.integrated",
      "checkpoint.created",
      "run.completed",
    ]) {
      expect(types, expected).toContain(expected);
    }

    // Numbered densely from zero, with nothing left pending.
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index));
  });

  /**
   * The worker wrote as itself, on its own execution token (P4, T6; SC-P4-11).
   *
   * Two halves, and the second is the one that matters.
   *
   * The record half: `node.implemented` carries `source: "mcp"` — the worker
   * chose to say it — and names the worker's own agent and node. An event's
   * `agentId` is written by whoever appends it, so on its own this says the
   * worker reported; it does not say what credential it held.
   *
   * The structural half: it could not have held anything else. A worker-role
   * server builds its transport in `createWorkerTransport`, which has no
   * fallback — no profile, no credentials file, no `??` — and throws
   * `MissingExecutionTokenError` without a token. So a worker that reached the
   * control plane at all had a valid execution token, and its environment
   * carries no `NIGHTSHIFT_CONFIG_DIR` and no `NIGHTSHIFT_API_TOKEN` to have
   * used instead (`apps/mcp/src/compose.test.ts` asserts those absences; this
   * run proves the path works end to end against the deployed authorizer).
   */
  it("was reported by the worker's own agent, which held only an execution token", async () => {
    const scope = runScopes[0];
    expect(scope, "the first test must have run").toBeDefined();
    if (scope === undefined) return;

    const events = (await stores.events.listByRun(scope)).items;
    const implemented = events.find((event) => event.type === "node.implemented");
    expect(implemented, "the worker must have reported completion").toBeDefined();
    if (implemented === undefined) return;

    expect(implemented.source).toBe("mcp");
    expect(implemented.agentId).toBeDefined();
    expect(implemented.executionNodeId).toBeDefined();

    // The agent it names is a worker, on the node it names, in this run.
    const agent = await stores.agents.get(
      scope,
      implemented.agentId as NonNullable<typeof implemented.agentId>,
    );
    expect(agent, "the reporting agent must be a stored execution identity (A-04)").toBeDefined();
    expect(agent?.role).toBe("worker");
    expect(agent?.executionNodeId).toBe(implemented.executionNodeId);

    // And the orchestrator is a different agent entirely: the worker did not
    // report as the human's proxy.
    const orchestrators = events.filter(
      (event) => event.type === "run.started" && event.agentId !== undefined,
    );
    for (const event of orchestrators) {
      expect(event.agentId).not.toBe(implemented.agentId);
    }
    say(`worker agent ${String(implemented.agentId)} reported node.implemented as source=mcp`);
  });
});
