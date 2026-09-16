/**
 * The job lifecycle, row by row (contract §4.3), against a real control plane,
 * real git and a real verification runner.
 *
 * Every assertion here reads the **control plane**, never process memory. A test
 * that asked the runner what it thought had happened would prove nothing about
 * the thing the whole program exists to provide: a run whose state is legible
 * from records alone.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobContract, RouteChoice } from "@nightshift/contracts";
import { JobContractSchema } from "@nightshift/contracts";
import { nowIso, rejectionOf } from "@nightshift/core";
import {
  checkChangedPaths,
  checkpointRef,
  completeJob,
  createEventOutbox,
  type EventOutbox,
  failJob,
  git,
  jobBranch,
  nodeGitRunner,
  P3_MAX_CONCURRENT_CHILDREN,
  reportProgress,
  revParse,
  runJob,
  type StartedJob,
  sealedRef,
  shutdown,
  tryRevParse,
  type WorkerEnvironment,
  type WorkerIdentity,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type HarnessScript } from "./fake-harness.js";
import { cleanupWorlds, createWorld, eventTypesOf, PROGRAM_BRANCH, type World } from "./world.js";

afterEach(cleanupWorlds);

const ROUTE: RouteChoice = {
  target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
  eligibleOptions: [
    {
      target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
      eligible: true,
    },
  ],
  ruleId: "p3-fixed",
  wasOverride: false,
};

const jobFor = (world: World, overrides: Partial<JobContract> = {}): JobContract =>
  JobContractSchema.parse({
    schemaVersion: 1,
    ...world.scope,
    jobContractId: world.ids.next("job"),
    objective: "Add a median helper to src/math.js and a test for it.",
    scope: { includes: ["src/**", "test/**"] },
    acceptance: ["median([1,2,3]) is 2", "node --test passes"],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: nowIso(world.environment.clock),
    ...overrides,
  });

/** A worker's own outbox and environment, as the worker MCP server would build. */
const workerEnvironment = (world: World, identity: WorkerIdentity): WorkerEnvironment => {
  const outbox: EventOutbox = createEventOutbox({
    events: world.stores.events,
    scope: identity.scope,
    clock: world.environment.clock,
    ids: world.ids,
    // The worker's own agent id: its events are its own writer's (A-30).
    writerId: identity.agentId,
    initialDelayMs: 1,
  });
  return { stores: world.stores, clock: world.environment.clock, git: world.git, outbox };
};

const delegate = (world: World, job: JobContract): Promise<StartedJob> =>
  runJob(world.environment, {
    session: world.session,
    job,
    scope: world.session.program.scope,
    depth: 1,
    parentNodeId: world.session.rootNodeId,
    route: ROUTE,
    mcp: (identity) => ({
      name: "nightshift",
      command: process.execPath,
      args: ["--version"],
      env: {
        NIGHTSHIFT_ROLE: "worker",
        NIGHTSHIFT_PROJECT_ID: identity.projectId,
        NIGHTSHIFT_PROGRAM_ID: identity.programId,
        NIGHTSHIFT_RUN_ID: identity.runId,
        NIGHTSHIFT_NODE_ID: identity.nodeId,
        NIGHTSHIFT_AGENT_ID: identity.agentId,
        NIGHTSHIFT_JOB_ID: identity.jobContractId,
        NIGHTSHIFT_WORKTREE: identity.worktree,
      },
    }),
  });

/** Adds a working median helper and a passing test, then reports completion. */
const implementWell: HarnessScript = async ({ worktree, identity, sink }) => {
  sink.emit({
    type: "tool.called",
    occurredAt: new Date().toISOString(),
    payload: { tool: "Read", path: "src/math.js" },
  });
  const math = await readFile(join(worktree, "src", "math.js"), "utf8");
  await writeFile(
    join(worktree, "src", "math.js"),
    `${math}export const median = (xs) => {\n  const s = [...xs].sort((a, b) => a - b);\n  const m = Math.floor(s.length / 2);\n  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];\n};\n`,
    "utf8",
  );
  await writeFile(
    join(worktree, "test", "median.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { median } from "../src/math.js";',
      "",
      'test("median of odd", () => {',
      "  assert.equal(median([3, 1, 2]), 2);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  sink.emit({
    type: "tool.completed",
    occurredAt: new Date().toISOString(),
    payload: { tool: "Write", ok: true },
  });
  void identity;
  return { kind: "completed" };
};

describe("the happy path, end to end", () => {
  it("runs the whole lifecycle table and leaves it all readable from the API", async () => {
    let reported: WorkerIdentity | undefined;
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          reported = context.identity;
          const worker = workerEnvironment(world, context.identity);
          reportProgress(worker, context.identity, "reading src/math.js");
          const exit = await implementWell(context);
          reportProgress(worker, context.identity, "tests added");
          const result = await completeJob(worker, context.identity, "Added a median helper.");
          expect(result.kind).toBe("implemented");
          await worker.outbox.flush();
          return exit;
        },
        transcript: '{"type":"system"}\n{"type":"result"}\n',
      }),
    });

    const job = jobFor(world);
    const started = await delegate(world, job);
    await started.completion;
    await world.outbox.flush();

    // --- The node reached `integrated` -------------------------------------
    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("integrated");
    expect(node?.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // --- The agent completed ------------------------------------------------
    const agent = await world.stores.agents.get(world.scope, started.agentId);
    expect(agent?.status).toBe("completed");
    expect(agent?.startedAt).toBeDefined();
    expect(agent?.endedAt).toBeDefined();

    // --- The verification is Nightshift's, and it passed ---------------------
    const verifications = await world.stores.verifications.listByNode(world.scope, started.nodeId);
    expect(verifications).toHaveLength(1);
    const verification = verifications[0];
    expect(verification?.outcome).toBe("passed");
    expect(verification?.commitSha).toBe(node?.commitSha);
    expect(verification?.commands.map((c) => c.stepId)).toEqual(["test", "shape"]);
    expect(verification?.commands.every((c) => c.exitCode === 0)).toBe(true);
    // Every step's output is an artifact, never inline (A-08).
    for (const command of verification?.commands ?? []) {
      expect(command.logArtifactId).toBeDefined();
    }

    // --- Sealed, integrated, checkpointed, all at one commit ----------------
    const sha = node?.commitSha ?? "";
    expect(await revParse(nodeGitRunner, world.repo, sealedRef(started.nodeId))).toBe(sha);
    expect(await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH)).toBe(sha);

    const checkpoints = await world.stores.checkpoints.listByRun(world.scope);
    // One at run start, one at integration.
    expect(checkpoints.items).toHaveLength(2);
    const integrationCheckpoint = checkpoints.items.find((c) => c.commitSha === sha);
    expect(integrationCheckpoint).toBeDefined();
    expect(
      await revParse(
        nodeGitRunner,
        world.repo,
        checkpointRef(integrationCheckpoint?.checkpointId ?? ""),
      ),
    ).toBe(sha);

    // --- The commit is Nightshift's, and names the work --------------------
    const body = await git(nodeGitRunner, ["log", "-1", "--format=%an%n%B", sha], {
      cwd: world.repo,
    });
    expect(body).toContain("Nightshift");
    expect(body).toContain(`Nightshift-Run: ${world.scope.runId}`);
    expect(body).toContain(`Nightshift-Node: ${started.nodeId}`);
    expect(body).toContain(`Nightshift-Job: ${job.jobContractId}`);

    // --- The worker was told who it was ------------------------------------
    expect(reported?.executionNodeId).toBe(started.nodeId);
    expect(reported?.jobContractId).toBe(job.jobContractId);
    expect(reported?.worktree).toBe(started.worktree);

    // --- The transcript was uploaded ----------------------------------------
    const artifacts = await world.stores.artifacts.listByRun(world.scope);
    expect(artifacts.items.filter((a) => a.kind === "transcript")).toHaveLength(1);
    expect(artifacts.items.filter((a) => a.kind === "verification-log")).toHaveLength(2);

    // --- The whole lifecycle is in the event stream -------------------------
    const types = await eventTypesOf(world);
    for (const expected of [
      "run.created",
      "node.delegated",
      "node.queued",
      "agent.created",
      "routing.decided",
      "node.started",
      "agent.started",
      "node.progress",
      "node.implemented",
      "agent.completed",
      "verification.requested",
      "artifact.recorded",
      "verification.completed",
      "node.integrated",
      "checkpoint.created",
    ]) {
      expect(types, expected).toContain(expected);
    }

    // --- And the worktree is gone, because it is no longer needed ------------
    expect(
      await tryRevParse(nodeGitRunner, world.repo, jobBranch(world.scope.runId, started.nodeId)),
    ).toBeUndefined();
  });

  /**
   * SC-P3-02, asserted from inside `start`. The fake harness calls this before
   * it does anything else, so if the runner ever moved a write after the launch
   * this fails rather than passing quietly.
   */
  it("has the job, the node and the agent in the control plane before the worker starts", async () => {
    const seen: Record<string, unknown> = {};
    const world = await createWorld({
      harness: createFakeHarness({
        onStart: async (input) => {
          const scope = {
            projectId: input.node.projectId,
            programId: input.node.programId,
            runId: input.node.runId,
          };
          seen.job = await world.stores.jobContracts.get(scope, input.job.jobContractId);
          seen.node = await world.stores.executionNodes.get(scope, input.node.executionNodeId);
          seen.agent = await world.stores.agents.get(scope, input.agent.agentId);
          seen.routing = await world.stores.routingDecisions.listByNode(
            scope,
            input.node.executionNodeId,
          );
        },
        script: async () => ({ kind: "completed" }),
      }),
    });

    const job = jobFor(world);
    const started = await delegate(world, job);
    await started.completion;

    expect(seen.job, "the Job Contract is persisted before execution (A-03)").toMatchObject({
      jobContractId: job.jobContractId,
    });
    // Stronger than SC-P3-02 asks: by the time a process exists, the node has
    // been through `validated` and `queued` and says `running`, and the agent
    // says `started`. The record leads the process, never trails it.
    expect(seen.node, "the node is past queued before the worker starts").toMatchObject({
      status: "running",
    });
    expect(seen.agent, "the execution identity exists before the process (A-04)").toMatchObject({
      status: "started",
      role: "worker",
    });
    expect(seen.routing, "and routing is recorded before the run it explains").toHaveLength(1);
  });

  /** SC-P3-03 and SC-P3-04, from the two sides that matter. */
  it("gives the worker an isolated worktree and leaves the program checkout alone until integration", async () => {
    let checkoutDuringJob: string | undefined;
    let worktreeBranch: string | undefined;
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          await implementWell(context);
          // The operator's checkout, while the worker's edits exist in the worktree.
          checkoutDuringJob = await readFile(join(world.repo, "src", "math.js"), "utf8");
          worktreeBranch = (
            await git(nodeGitRunner, ["rev-parse", "--abbrev-ref", "HEAD"], {
              cwd: context.worktree,
            })
          ).trim();
          await completeJob(worker, context.identity, "Added a median helper.");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));

    // On its own branch, under the state directory, never in the checkout.
    expect(started.worktree.startsWith(world.stateDir)).toBe(true);
    expect(started.worktree.startsWith(world.repo)).toBe(false);

    await started.completion;
    expect(worktreeBranch).toBe(jobBranch(world.scope.runId, started.nodeId));
    expect(checkoutDuringJob, "SC-P3-04: not in the checkout before integration").not.toContain(
      "median",
    );
    // And after integration, it is.
    expect(await readFile(join(world.repo, "src", "math.js"), "utf8")).toContain("median");
  });

  /** SC-P3-05 and SC-P3-06: progress arrives during the run, and before verification. */
  it("reports progress as mcp events, and is implemented but not verified at completion", async () => {
    let statusAtCompletion: string | undefined;
    let verificationsAtCompletion = -1;
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          reportProgress(worker, context.identity, "starting");
          await worker.outbox.flush();

          // Progress is readable from the control plane *during* the run.
          world.settle();
          const during = (await world.stores.events.listByRun(context.identity.scope)).items;
          expect(
            during.filter((e) => e.type === "node.progress" && e.source === "mcp"),
          ).not.toHaveLength(0);
          expect(during.some((e) => e.type === "node.implemented")).toBe(false);

          await implementWell(context);
          await completeJob(worker, context.identity, "done");
          await worker.outbox.flush();

          const node = await world.stores.executionNodes.get(
            context.identity.scope,
            context.identity.executionNodeId,
          );
          statusAtCompletion = node?.status;
          verificationsAtCompletion = (
            await world.stores.verifications.listByNode(
              context.identity.scope,
              context.identity.executionNodeId,
            )
          ).length;
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    // SC-P3-06: a worker's own report is `implemented` and nothing more, and no
    // evidence exists yet to make it anything else.
    expect(statusAtCompletion).toBe("implemented");
    expect(verificationsAtCompletion).toBe(0);
  });
});

/**
 * The exit gate's second finding (T10).
 *
 * The runner writes the agent record — only the execution layer may — but the
 * *event* that says how the agent ended belongs to whoever observed it. Both
 * were emitting one, so the first integrated run carried two `agent.completed`
 * events for one agent, the second with an empty payload. The rule is now: the
 * adapter's if there is one, the runner's if there is not, never both.
 */
describe("the ending is emitted exactly once", () => {
  it("does not repeat an ending the adapter already emitted", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          const exit = await implementWell(context);
          await completeJob(worker, context.identity, "Added a median helper.");
          await worker.outbox.flush();
          return exit;
        },
      }),
    });
    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    const endings = (await eventTypesOf(world)).filter((type) => type === "agent.completed");
    expect(endings).toEqual(["agent.completed"]);
  });

  it("emits one itself when the adapter emitted none (D-P3-09)", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        // An adapter that observes a process and says nothing about it: the
        // case terminal state must survive anyway.
        silentEnding: true,
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          const exit = await implementWell(context);
          await completeJob(worker, context.identity, "Added a median helper.");
          await worker.outbox.flush();
          return exit;
        },
      }),
    });
    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    const endings = (await eventTypesOf(world)).filter((type) => type === "agent.completed");
    expect(endings).toEqual(["agent.completed"]);
    // And the record moved regardless, which is the half that was never in doubt.
    const agent = await world.stores.agents.get(world.scope, started.agentId);
    expect(agent?.status).toBe("completed");
  });
});

describe("concurrency", () => {
  it("refuses a second job while one is running, and says P5 lifts it", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async ({ cancelled }) => {
          await cancelled;
          return { kind: "cancelled" };
        },
      }),
    });

    const first = await delegate(world, jobFor(world));
    const refusal = await rejectionOf(delegate(world, jobFor(world)));

    expect(refusal.message).toContain("one job at a time");
    expect(refusal.message).toContain("P5");
    expect(P3_MAX_CONCURRENT_CHILDREN).toBe(1);

    // Exactly one child was created: the refusal happened before any write.
    const children = await world.stores.executionNodes.listChildren(
      world.scope,
      world.session.rootNodeId,
    );
    expect(children).toHaveLength(1);

    await first.cancel();
  });
});

describe("shutdown", () => {
  it("cancels the worker, leaves interrupted state, and spills what it could not send", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async ({ cancelled, identity }) => {
          const worker = workerEnvironment(world, identity);
          reportProgress(worker, identity, "working, and about to be interrupted");
          await worker.outbox.flush();
          await cancelled;
          return { kind: "interrupted", signal: "SIGTERM" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    const result = await shutdown(world.environment, {
      session: world.session,
      job: started,
      reason: "the orchestrator's session ended",
      flushDeadlineMs: 500,
    });

    expect(result.cancelledJob).toBe(started.nodeId);

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    // `interrupted`, not `cancelled`: nobody decided to stop this work, so it
    // stays retryable. And with a reason — killing a worker must never leave
    // silence (architecture §4).
    expect(node?.status).toBe("interrupted");
    expect(node?.outcomeReason).toContain("session ended");

    const agent = await world.stores.agents.get(world.scope, started.agentId);
    expect(agent?.status).toBe("interrupted");
    expect(agent?.outcomeReason).toContain("session ended");

    const run = await world.stores.runs.get(world.scope, world.scope.runId);
    expect(run?.status).toBe("interrupted");
    expect(run?.outcomeReason).toContain("session ended");

    // The worktree is kept, because a human may want to see what was in it.
    expect(
      await tryRevParse(nodeGitRunner, world.repo, jobBranch(world.scope.runId, started.nodeId)),
    ).toBeDefined();
  });

  it("is idempotent: stdin closing and a signal can both arrive", async () => {
    const world = await createWorld({
      harness: createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    });
    const first = await shutdown(world.environment, {
      session: world.session,
      reason: "stdin closed",
      flushDeadlineMs: 200,
    });
    const second = await shutdown(world.environment, {
      session: world.session,
      reason: "SIGTERM",
      flushDeadlineMs: 200,
    });
    expect(first.cancelledJob).toBeUndefined();
    expect(second.cancelledJob).toBeUndefined();
    const run = await world.stores.runs.get(world.scope, world.scope.runId);
    // The first outcome wins; the second does not rewrite it.
    expect(run?.outcomeReason).toContain("stdin closed");
  });
});

describe("the worker-side half", () => {
  it("cannot move a node past implemented, and writes no Verification", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          await implementWell(context);
          await completeJob(worker, context.identity, "done");

          // Everything a worker holds is in `worker`. There is no function on it
          // that writes a Verification or seals a node — that absence is A-05 in
          // code, not a check someone remembered to write.
          expect(Object.keys(worker).sort()).toEqual(["clock", "git", "outbox", "stores"]);
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });
    const started = await delegate(world, jobFor(world));
    await started.completion;
    expect((await world.stores.executionNodes.get(world.scope, started.nodeId))?.status).toBe(
      "integrated",
    );
  });

  it("records a worker's own failure with its reason", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          await failJob(
            worker,
            context.identity,
            "the job asks for a database that does not exist",
          );
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("failed");
    expect(node?.outcomeReason).toContain("database that does not exist");
    // Nothing verified, nothing sealed, and the branch did not move.
    expect(await world.stores.verifications.listByNode(world.scope, started.nodeId)).toEqual([]);
    expect(await tryRevParse(nodeGitRunner, world.repo, sealedRef(started.nodeId))).toBeUndefined();
    expect(await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH)).toBe(world.baseCommit);
  });

  it("computes the same scope answer the delegation-time check would", () => {
    // One implementation of include-and-exclude semantics, in `core`, used by
    // both. This is a guard against a second one appearing here.
    const scope = {
      includes: ["src/**"],
      excludes: ["src/generated/**"],
      permissions: [],
      forbiddenActions: [],
    };
    expect(checkChangedPaths(scope, ["src/a.ts"]).allowed).toBe(true);
    expect(checkChangedPaths(scope, ["src/generated/a.ts"]).allowed).toBe(false);
  });
});
