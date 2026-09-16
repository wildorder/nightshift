/**
 * Every failure path in the lifecycle table (contract §4.3).
 *
 * The point of this file is the word **durable**. For each way a job can go
 * wrong, three things must be true afterwards, and all three are read from the
 * control plane rather than from process memory:
 *
 * 1. the node is in a terminal status, never left `running`;
 * 2. it carries an `outcomeReason` a human can act on;
 * 3. nothing was sealed, nothing integrated, and the program branch did not move.
 *
 * Silence is the failure mode this guards against. A job that stops with no
 * record of why is the one outcome nobody can do anything about.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobContract, RouteChoice } from "@nightshift/contracts";
import { JobContractSchema } from "@nightshift/contracts";
import { nowIso, rejectionOf } from "@nightshift/core";
import {
  completeJob,
  createEventOutbox,
  git,
  jobBranch,
  nodeGitRunner,
  reportProgress,
  revParse,
  runJob,
  type StartedJob,
  sealedRef,
  tryRevParse,
  type WorkerEnvironment,
  type WorkerIdentity,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness } from "./fake-harness.js";
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
    objective: "Add a median helper.",
    scope: { includes: ["src/**", "test/**"] },
    acceptance: ["it works"],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: nowIso(world.environment.clock),
    ...overrides,
  });

const workerEnvironment = (world: World, identity: WorkerIdentity): WorkerEnvironment => ({
  stores: world.stores,
  clock: world.environment.clock,
  git: world.git,
  outbox: createEventOutbox({
    events: world.stores.events,
    scope: identity.scope,
    clock: world.environment.clock,
    ids: world.ids,
    writerId: identity.agentId,
    initialDelayMs: 1,
  }),
});

const delegate = (world: World, job: JobContract): Promise<StartedJob> =>
  runJob(world.environment, {
    session: world.session,
    job,
    scope: world.session.program.scope,
    depth: 1,
    parentNodeId: world.session.rootNodeId,
    route: ROUTE,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
  });

/** Nothing sealed, nothing integrated, the operator's branch exactly where it was. */
const expectNothingIntegrated = async (world: World, nodeId: string): Promise<void> => {
  expect(await tryRevParse(nodeGitRunner, world.repo, sealedRef(nodeId))).toBeUndefined();
  expect(await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH)).toBe(world.baseCommit);
  const checkpoints = await world.stores.checkpoints.listByRun(world.scope);
  // Only the one `nightshift run` made; integration never added its own.
  expect(checkpoints.items).toHaveLength(1);
};

/** The worktree is kept on every failure, because it is the only place to look. */
const expectWorktreeKept = async (world: World, nodeId: string): Promise<void> => {
  expect(
    await tryRevParse(nodeGitRunner, world.repo, jobBranch(world.scope.runId, nodeId)),
  ).toBeDefined();
};

describe("verification fails (SC-P3-07)", () => {
  it("records the failing step and its log, seals nothing, and leaves the branch alone", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          // A test that is added and fails: exactly what an over-confident
          // worker produces, and what SC-P3-07 exists for.
          await writeFile(
            join(context.worktree, "test", "broken.test.js"),
            [
              'import { test } from "node:test";',
              'import assert from "node:assert/strict";',
              'test("this one is wrong", () => {',
              "  assert.equal(1, 2);",
              "});",
              "",
            ].join("\n"),
            "utf8",
          );
          const result = await completeJob(worker, context.identity, "Added a test.");
          // The worker's own report succeeded. Its work is still not verified.
          expect(result.kind).toBe("implemented");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("verification_failed");
    expect(node?.outcomeReason).toContain("test");

    const verifications = await world.stores.verifications.listByNode(world.scope, started.nodeId);
    expect(verifications).toHaveLength(1);
    const verification = verifications[0];
    expect(verification?.outcome).toBe("failed");
    const failing = verification?.commands.filter((command) => command.exitCode !== 0) ?? [];
    expect(failing.map((command) => command.stepId)).toEqual(["test"]);

    // The log is an artifact, and it contains what the command actually said.
    const logArtifactId = failing[0]?.logArtifactId;
    if (logArtifactId === undefined) throw new Error("the failing step recorded no log artifact");
    const artifact = await world.stores.artifacts.get(world.scope, logArtifactId);
    expect(artifact?.kind).toBe("verification-log");
    const body = world.plane.bodies.text(
      `${world.scope.projectId}/${world.scope.programId}/${world.scope.runId}/${logArtifactId}`,
    );
    expect(body).toContain("this one is wrong");

    await expectNothingIntegrated(world, started.nodeId);
    await expectWorktreeKept(world, started.nodeId);
    expect(await eventTypesOf(world)).toContain("verification.completed");
  });
});

describe("a change outside the effective scope (SC-P3-13)", () => {
  it("fails the job at completion, naming the path, and nothing integrates", async () => {
    let result: Awaited<ReturnType<typeof completeJob>> | undefined;
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          // Inside scope, and would have passed verification.
          await writeFile(join(context.worktree, "src", "ok.js"), "export const ok = 1;\n", "utf8");
          // And one file outside it. `package.json` is not under `src/` or `test/`.
          await writeFile(join(context.worktree, "package.json"), '{"name":"hijacked"}\n', "utf8");
          result = await completeJob(worker, context.identity, "Added a helper.");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    expect(result?.kind).toBe("scope_violation");
    if (result?.kind === "scope_violation") {
      expect(result.offending).toEqual(["package.json"]);
    }

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("failed");
    expect(node?.outcomeReason).toContain("package.json");
    expect(node?.outcomeReason).toContain("outside the job's effective scope");

    // Never verified, because it never reached `implemented`.
    expect(await world.stores.verifications.listByNode(world.scope, started.nodeId)).toEqual([]);
    await expectNothingIntegrated(world, started.nodeId);
    // And the operator's `package.json` is untouched.
    expect(await readFile(join(world.repo, "package.json"), "utf8")).toContain("slice-fixture");
  });

  it("refuses a change an exclude knocks out, even though an include covers it", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          // `src/**` includes it; `src/generated/**` excludes it. An exclude is
          // authority, not a hint, so it wins.
          await mkdir(join(context.worktree, "src", "generated"), { recursive: true });
          await writeFile(
            join(context.worktree, "src", "generated", "schema.js"),
            "export const schema = 1;\n",
            "utf8",
          );
          await completeJob(worker, context.identity, "Regenerated the schema.");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("failed");
    expect(node?.outcomeReason).toContain("src/generated/schema.js");
  });
});

describe("a worker that stops without reporting", () => {
  it("exits zero having said nothing: failed, with the one reason nobody can act on named", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async ({ worktree }) => {
          await writeFile(join(worktree, "src", "half-done.js"), "export const x = 1;\n", "utf8");
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("failed");
    expect(node?.outcomeReason).toBe("the worker exited 0 without reporting completion");
    await expectNothingIntegrated(world, started.nodeId);
    await expectWorktreeKept(world, started.nodeId);
  });

  it("exits non-zero: failed, with the exit code on the agent", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async ({ identity }) => {
          const worker = workerEnvironment(world, identity);
          reportProgress(worker, identity, "about to crash");
          await worker.outbox.flush();
          return { kind: "failed", exitCode: 7 };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("failed");
    expect(node?.outcomeReason).toContain("exited 7");

    const agent = await world.stores.agents.get(world.scope, started.agentId);
    expect(agent?.status).toBe("failed");
    expect(agent?.exitCode).toBe(7);
    expect(agent?.outcomeReason).toContain("7");

    // A worker that never reached verification never reaches it.
    expect(await world.stores.verifications.listByNode(world.scope, started.nodeId)).toEqual([]);
    await expectNothingIntegrated(world, started.nodeId);
  });

  /** SC-P3-11: a killed worker leaves durable interruption state. */
  it("is killed by a signal: interrupted, on both the node and the agent", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async () => ({ kind: "interrupted", signal: "SIGKILL" }),
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("interrupted");
    expect(node?.outcomeReason).toContain("SIGKILL");

    const agent = await world.stores.agents.get(world.scope, started.agentId);
    expect(agent?.status).toBe("interrupted");
    expect(agent?.outcomeReason).toContain("SIGKILL");

    // Readable from records alone, with no process still around to ask.
    const types = await eventTypesOf(world);
    expect(types).toContain("node.interrupted");
    expect(types).toContain("agent.interrupted");
    await expectNothingIntegrated(world, started.nodeId);
    await expectWorktreeKept(world, started.nodeId);
  });
});

describe("cancellation", () => {
  it("leaves cancelled state, which is terminal rather than retryable", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async ({ cancelled }) => {
          await cancelled;
          return { kind: "cancelled" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.cancel();

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("cancelled");
    expect(node?.outcomeReason).toContain("cancelled");

    const agent = await world.stores.agents.get(world.scope, started.agentId);
    expect(agent?.status).toBe("cancelled");

    expect(await eventTypesOf(world)).toContain("node.cancelled");
    await expectNothingIntegrated(world, started.nodeId);
  });

  it("is idempotent: cancelling twice is not an error", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async ({ cancelled }) => {
          await cancelled;
          return { kind: "cancelled" };
        },
      }),
    });
    const started = await delegate(world, jobFor(world));
    await started.cancel();
    await expect(started.cancel()).resolves.toBeUndefined();
  });
});

describe("the program checkout at integration time", () => {
  /** Verified work, and a checkout nobody may fast-forward over. */
  it("refuses a dirty checkout, keeps the sealed ref, and says which", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          await writeFile(
            join(context.worktree, "src", "extra.js"),
            "export const extra = 1;\n",
            "utf8",
          );
          await completeJob(worker, context.identity, "Added extra.");
          await worker.outbox.flush();
          // The operator leaves work in progress while the job finishes.
          await writeFile(join(world.repo, "scratch.txt"), "my notes\n", "utf8");
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    // Verified and sealed; it was the *integration* that was refused.
    expect(node?.status).toBe("cancelled");
    expect(node?.outcomeReason).toContain("program_checkout_dirty");

    // The commit is verified and still addressable, for P5 to pick up.
    expect(await tryRevParse(nodeGitRunner, world.repo, sealedRef(started.nodeId))).toBe(
      node?.commitSha,
    );
    const verifications = await world.stores.verifications.listByNode(world.scope, started.nodeId);
    expect(verifications[0]?.outcome).toBe("passed");
    // And the operator's notes are exactly where they left them.
    expect(await readFile(join(world.repo, "scratch.txt"), "utf8")).toBe("my notes\n");
    expect(await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH)).toBe(world.baseCommit);
  });

  it("refuses a moved program branch as stale_base, naming both commits", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          await writeFile(
            join(context.worktree, "src", "ours.js"),
            "export const ours = 1;\n",
            "utf8",
          );
          await completeJob(worker, context.identity, "Our work.");
          await worker.outbox.flush();

          // Somebody else commits to the program branch while the job runs.
          await writeFile(join(world.repo, "src", "theirs.js"), "export const t = 1;\n", "utf8");
          await git(nodeGitRunner, ["add", "-A"], { cwd: world.repo, atMs: 0 });
          await git(nodeGitRunner, ["commit", "-m", "meanwhile, elsewhere"], {
            cwd: world.repo,
            atMs: 0,
          });
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;
    const moved = await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH);

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("cancelled");
    expect(node?.outcomeReason).toContain("stale_base");
    // Both commits named, so a human can see the divergence without digging.
    expect(node?.outcomeReason).toContain(world.baseCommit);
    expect(node?.outcomeReason).toContain(moved);
    // And P5 is named as what fixes it, rather than leaving a reader guessing.
    expect(node?.outcomeReason).toContain("P5");

    // No merge commit was created: `--ff-only` means refused, never merged.
    expect(await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH)).toBe(moved);
    expect(await tryRevParse(nodeGitRunner, world.repo, sealedRef(started.nodeId))).toBe(
      node?.commitSha,
    );
  });

  it("refuses a checkout on the wrong branch", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        script: async (context) => {
          const worker = workerEnvironment(world, context.identity);
          await writeFile(join(context.worktree, "src", "x.js"), "export const x = 1;\n", "utf8");
          await completeJob(worker, context.identity, "x");
          await worker.outbox.flush();
          // The operator wanders off to another branch mid-job.
          await git(nodeGitRunner, ["checkout", "-q", "main"], { cwd: world.repo, atMs: 0 });
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.outcomeReason).toContain("program_checkout_wrong_branch");
    expect(await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH)).toBe(world.baseCommit);
  });
});

describe("the harness itself failing to start", () => {
  it("ends the node durably rather than leaving it running forever", async () => {
    const world = await createWorld({
      harness: {
        id: "broken",
        start: async () => {
          throw new Error("claude: command not found");
        },
        cancel: async () => {},
        status: async () => "failed",
      },
    });

    const failure = await rejectionOf(delegate(world, jobFor(world)));
    expect(failure.message).toContain("command not found");

    const children = await world.stores.executionNodes.listChildren(
      world.scope,
      world.session.rootNodeId,
    );
    expect(children).toHaveLength(1);
    const node = children[0];
    if (node === undefined) throw new Error("the refused delegation left no node");
    expect(node.status).toBe("failed");
    expect(node.outcomeReason).toContain("could not start the worker");

    const agents = await world.stores.agents.listByNode(world.scope, node.executionNodeId);
    expect(agents[0]?.status).toBe("failed");
  });
});

describe("the transcript", () => {
  it("is uploaded as an artifact after the process that wrote it has stopped", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        transcript: '{"type":"system","subtype":"init"}\n{"type":"result","is_error":false}\n',
        script: async () => ({ kind: "completed" }),
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;

    const artifacts = await world.stores.artifacts.listByRun(world.scope);
    const transcript = artifacts.items.find((artifact) => artifact.kind === "transcript");
    expect(transcript).toBeDefined();
    expect(transcript?.contentType).toBe("application/x-ndjson");
    const body = world.plane.bodies.text(
      `${world.scope.projectId}/${world.scope.programId}/${world.scope.runId}/${transcript?.artifactId}`,
    );
    expect(body).toContain('"type":"result"');
  });

  it("is simply absent when the adapter kept none", async () => {
    const world = await createWorld({
      harness: createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    });
    const started = await delegate(world, jobFor(world));
    await started.completion;
    const artifacts = await world.stores.artifacts.listByRun(world.scope);
    expect(artifacts.items.filter((artifact) => artifact.kind === "transcript")).toEqual([]);
  });
});

describe("hook events arrive without the worker's cooperation (SC-P3-12)", () => {
  it("records agent.started and an ending for a worker that calls nothing", async () => {
    const world = await createWorld({
      harness: createFakeHarness({
        // Calls no tool, reports nothing, exits non-zero. The worst-behaved
        // worker there is, and the lifecycle is still observable.
        script: async () => ({ kind: "failed", exitCode: 1 }),
      }),
    });
    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    const events = (await world.stores.events.listByRun(world.scope)).items;
    const hookEvents = events.filter((event) => event.source === "hook");
    expect(hookEvents.map((event) => event.type)).toContain("agent.started");
    expect(hookEvents.map((event) => event.type)).toContain("agent.failed");
    // And no `mcp` event at all, because the worker said nothing.
    expect(
      events.filter((event) => event.source === "mcp" && event.type === "node.progress"),
    ).toEqual([]);
  });
});

describe("the fixture repository is left tidy", () => {
  it("removes nothing the operator owns", async () => {
    const world = await createWorld({
      harness: createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    });
    const before = await readFile(join(world.repo, "src", "math.js"), "utf8");
    const started = await delegate(world, jobFor(world));
    await started.completion;
    expect(await readFile(join(world.repo, "src", "math.js"), "utf8")).toBe(before);
    // And nothing was left behind in the checkout: no worktree, no stray file.
    expect(await readFile(join(world.repo, "package.json"), "utf8")).toContain("slice-fixture");
  });
});
