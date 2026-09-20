/**
 * The Nightshift MCP server, driven by a real MCP client (T6 deliverable 10).
 *
 * The client is the SDK's own, over the SDK's in-process transport pair, so the
 * protocol, the tool schemas and the role split are all genuinely under test —
 * not a function call that resembles them. Behind the server: the real
 * composition, the real execution layer, a real git repository, a real
 * verification runner and the real control plane over loopback HTTP.
 *
 * The one fake is the harness, because the one thing `npm test` must not need is
 * an LLM.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { completeJob, createEventOutbox, nodeGitRunner, revParse } from "@nightshift/execution";
import type { Harness } from "@nightshift/harness";
import {
  createNightshiftServer,
  DEFAULT_JOB_WAIT_CAP_SECONDS,
  MissingWorkerIdentityError,
  type NightshiftServer,
  roleFrom,
  WORKER_IDENTITY_ENV,
  workerIdentityFrom,
} from "@nightshift/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type HarnessScript } from "../execution/fake-harness.js";
import {
  type BaseWorld,
  CONTRACT_FILE,
  cleanupWorlds,
  createBaseWorld,
  localPathsIn,
  PROGRAM_BRANCH,
  workerEnvironmentIn,
} from "../execution/world.js";

afterEach(cleanupWorlds);

const MODEL = "claude-sonnet-5";

interface Harnessed {
  readonly world: BaseWorld;
  readonly client: Client;
  readonly server: NightshiftServer;
  call(name: string, args?: Record<string, unknown>): Promise<Structured>;
  toolNames(): Promise<readonly string[]>;
  stop(): Promise<void>;
}

interface Structured extends Record<string, unknown> {
  readonly ok: boolean;
}

const structured = (result: CallToolResult): Structured =>
  (result.structuredContent ?? { ok: false, code: "no_structured_content" }) as Structured;

/**
 * A server, wired exactly as the binary wires one, with the world's control
 * plane and a fake harness injected through the composition root's own seam.
 */
const start = async (
  world: BaseWorld,
  harness: Harness,
  extraEnv: Record<string, string> = {},
): Promise<Harnessed> => {
  const env: Record<string, string> = {
    NIGHTSHIFT_API_ENDPOINT: world.plane.url,
    NIGHTSHIFT_API_TOKEN: "ignored-by-the-local-plane",
    NIGHTSHIFT_STATE_DIR: world.stateDir,
    ...extraEnv,
  };
  const server = await createNightshiftServer({
    env,
    cwd: world.repo,
    runtime: {
      stores: world.stores,
      bodies: world.bodies,
      tokens: world.tokens,
      harness,
      paths: localPathsIn(world.stateDir),
      git: nodeGitRunner,
      transport: (async () => ({ status: 500, body: undefined })) as never,
      ids: world.ids,
      clock: world.clock,
      endpoint: world.plane.url,
      workerEnvironment: workerEnvironmentIn(world),
      workerLaunch: () => ({
        name: "nightshift",
        command: process.execPath,
        args: ["--version"],
        env: {},
      }),
    },
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.273" });
  await client.connect(clientSide);

  return {
    world,
    client,
    server,
    call: async (name, args = {}) =>
      structured((await client.callTool({ name, arguments: args })) as CallToolResult),
    toolNames: async () => (await client.listTools()).tools.map((tool) => tool.name).sort(),
    stop: async () => {
      await client.close();
      await server.stop("the test finished");
    },
  };
};

/** Adds a median helper and a passing test, then reports completion. */
const implementWell =
  (world: BaseWorld): HarnessScript =>
  async ({ worktree, identity, sink }) => {
    sink.emit({
      type: "tool.called",
      occurredAt: new Date().toISOString(),
      payload: { tool: "Edit", path: "src/math.js" },
    });
    const math = await readFile(join(worktree, "src", "math.js"), "utf8");
    await writeFile(
      join(worktree, "src", "math.js"),
      `${math}export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];\n`,
      "utf8",
    );
    await writeFile(
      join(worktree, "test", "median.test.js"),
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { median } from "../src/math.js";',
        'test("median", () => { assert.equal(median([3, 1, 2]), 2); });',
        "",
      ].join("\n"),
      "utf8",
    );
    const outbox = createEventOutbox({
      events: world.stores.events,
      scope: identity.scope,
      clock: world.clock,
      ids: world.ids,
      writerId: identity.agentId,
      initialDelayMs: 1,
    });
    await completeJob(
      { stores: world.stores, clock: world.clock, git: nodeGitRunner, outbox },
      identity,
      "Added a median helper.",
    );
    await outbox.flush(2_000);
    return { kind: "completed" };
  };

const DELEGATION = {
  objective: "Add a median helper to src/math.js and a test for it.",
  scope: { includes: ["src/**", "test/**"] },
  acceptance: ["median([1,2,3]) is 2", "node --test passes"],
};

describe("the role split (D-P3-01)", () => {
  it("registers the orchestrator surface and no worker-only tool", async () => {
    const world = await createBaseWorld();
    const mcp = await start(
      world,
      createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    );
    expect(await mcp.toolNames()).toEqual([
      "checkpoint.create",
      "decision.record",
      "delegate",
      "execution.status",
      "job.cancel",
      "job.get",
      "job.wait",
      "program.get",
      "program.status",
      "run.attach",
      "run.finish",
      "run.start",
    ]);
    await mcp.stop();
  });

  /**
   * A worker cannot delegate **by construction**: the tool is not registered, so
   * there is nothing to call. Not a check that refuses it — an absence.
   */
  it("registers no delegation tool in the worker role", async () => {
    const world = await createBaseWorld();
    const runId = world.ids.next("run");
    const env: Record<string, string> = {
      NIGHTSHIFT_ROLE: "worker",
      NIGHTSHIFT_API_ENDPOINT: world.plane.url,
      NIGHTSHIFT_API_TOKEN: "ignored",
      NIGHTSHIFT_STATE_DIR: world.stateDir,
      [WORKER_IDENTITY_ENV.projectId]: world.program.projectId,
      [WORKER_IDENTITY_ENV.programId]: world.program.programId,
      [WORKER_IDENTITY_ENV.runId]: runId,
      [WORKER_IDENTITY_ENV.executionNodeId]: world.ids.next("node"),
      [WORKER_IDENTITY_ENV.agentId]: world.ids.next("agent"),
      [WORKER_IDENTITY_ENV.jobContractId]: world.ids.next("job"),
      [WORKER_IDENTITY_ENV.worktree]: world.repo,
    };
    const server = await createNightshiftServer({
      env,
      cwd: world.repo,
      runtime: {
        stores: world.stores,
        bodies: world.bodies,
        tokens: world.tokens,
        harness: createFakeHarness({ script: async () => ({ kind: "completed" }) }),
        paths: localPathsIn(world.stateDir),
        git: nodeGitRunner,
        transport: (async () => ({ status: 500, body: undefined })) as never,
        ids: world.ids,
        clock: world.clock,
        endpoint: world.plane.url,
        workerEnvironment: workerEnvironmentIn(world),
        workerLaunch: () => ({ name: "n", command: "node", args: [], env: {} }),
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "2.1.273" });
    await client.connect(clientSide);

    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "decision.record",
      "job.complete",
      "job.fail",
      "job.get",
      "job.progress",
    ]);
    for (const forbidden of [
      "delegate",
      "run.start",
      "run.attach",
      "checkpoint.create",
      "job.cancel",
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    await client.close();
    await server.stop("done");
  });

  it("refuses to start as a worker without its identity, naming every missing variable", () => {
    expect(() => workerIdentityFrom({ NIGHTSHIFT_ROLE: "worker" })).toThrow(
      MissingWorkerIdentityError,
    );
    const failure = (() => {
      try {
        workerIdentityFrom({ [WORKER_IDENTITY_ENV.projectId]: "proj_01M2K3A96ZZ7EJE93PQWR845T3" });
        return undefined;
      } catch (error) {
        return error as MissingWorkerIdentityError;
      }
    })();
    // Every one, not the first: an operator debugging a launch wants the list.
    expect(failure?.missing).toHaveLength(6);
    expect(failure?.missing).not.toContain(WORKER_IDENTITY_ENV.projectId);
    expect(failure?.message).toContain(WORKER_IDENTITY_ENV.worktree);
  });

  it("defaults to the orchestrator role, because that is what an operator spawns", () => {
    expect(roleFrom({})).toBe("orchestrator");
    expect(roleFrom({ NIGHTSHIFT_ROLE: "" })).toBe("orchestrator");
    expect(roleFrom({ NIGHTSHIFT_ROLE: "worker" })).toBe("worker");
    expect(() => roleFrom({ NIGHTSHIFT_ROLE: "examiner" })).toThrow(/orchestrator/);
  });
});

describe("a run, through the tools", () => {
  it("starts, delegates, waits, and reaches integrated", async () => {
    const world = await createBaseWorld();
    const mcp = await start(world, createFakeHarness({ script: implementWell(world) }));

    const started = await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    expect(String(started.runId)).toMatch(/^run_/);

    const delegated = await mcp.call("delegate", DELEGATION);
    expect(delegated.ok, JSON.stringify(delegated)).toBe(true);
    expect(String(delegated.jobId)).toMatch(/^job_/);
    expect(String(delegated.worktree)).toContain(world.stateDir);
    expect(delegated.model).toBe(MODEL);

    // `job.wait` polls the control plane, so what it says is what the API says.
    let waited = await mcp.call("job.wait", { jobId: delegated.jobId, timeoutSeconds: 30 });
    while (waited.timedOut === true) {
      waited = await mcp.call("job.wait", { jobId: delegated.jobId, timeoutSeconds: 30 });
    }
    expect(waited.status, JSON.stringify(waited)).toBe("integrated");
    expect(waited.settled).toBe(true);

    const verification = waited.verification as { outcome: string } | null;
    expect(verification?.outcome).toBe("passed");
    expect(String(waited.commitSha)).toMatch(/^[0-9a-f]{40}$/);
    // And the operator's branch really moved to that commit.
    expect(await revParse(nodeGitRunner, world.repo, PROGRAM_BRANCH)).toBe(waited.commitSha);

    const status = await mcp.call("execution.status");
    expect(String((status.lines as string[]).join("\n"))).toContain("integrated");

    const finished = await mcp.call("run.finish", { outcome: "succeeded" });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    await mcp.stop();
  });

  it("attaches to a run somebody else authorized, and reports the checkpoint", async () => {
    const world = await createBaseWorld();
    const first = await start(
      world,
      createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    );
    const started = await first.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    await first.stop();

    // A second orchestrator joins the same run, as `run.attach` is for.
    const second = await start(
      world,
      createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    );
    const attached = await second.call("run.attach", { model: MODEL, runId: started.runId });
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    expect(attached.runId).toBe(started.runId);

    const status = await second.call("program.status");
    expect(status.ok).toBe(true);
    expect(status.latestCheckpoint).not.toBeNull();
    await second.stop();
  });

  it("refuses to attach twice in one session", async () => {
    const world = await createBaseWorld();
    const mcp = await start(
      world,
      createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    );
    await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    const again = await mcp.call("run.attach", { model: MODEL });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("already_attached");
    await mcp.stop();
  });

  it("refuses every tool that needs a run before one is attached", async () => {
    const world = await createBaseWorld();
    const mcp = await start(
      world,
      createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    );
    for (const name of ["program.get", "program.status", "execution.status", "checkpoint.create"]) {
      const result = await mcp.call(name);
      expect(result.ok, name).toBe(false);
      expect(result.code, name).toBe("not_attached");
    }
    await mcp.stop();
  });

  it("records a decision and creates a checkpoint", async () => {
    const world = await createBaseWorld();
    const mcp = await start(
      world,
      createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    );
    await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });

    const decision = await mcp.call("decision.record", {
      context: "The parser needs a token buffer.",
      alternatives: [{ summary: "Re-lex on backtrack", rejectedBecause: "quadratic on nesting" }],
      choice: "Buffer two tokens of lookahead.",
      rationale: "Constant memory and enough for the grammar.",
      reversibility: "reversible",
    });
    expect(decision.ok, JSON.stringify(decision)).toBe(true);
    expect(String(decision.decisionId)).toMatch(/^dec_/);

    const checkpoint = await mcp.call("checkpoint.create", { label: "after the parser decision" });
    expect(checkpoint.ok, JSON.stringify(checkpoint)).toBe(true);
    expect(await revParse(nodeGitRunner, world.repo, String(checkpoint.ref))).toBe(
      checkpoint.commitSha,
    );
    await mcp.stop();
  });
});

describe("delegate's refusals are typed (§4.5)", () => {
  const attached = async (world: BaseWorld) => {
    const mcp = await start(
      world,
      createFakeHarness({
        script: async ({ cancelled }) => {
          await cancelled;
          return { kind: "cancelled" };
        },
      }),
    );
    await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    return mcp;
  };

  it("refuses a widening scope, naming the pattern the program does not cover", async () => {
    const world = await createBaseWorld();
    const mcp = await attached(world);
    const result = await mcp.call("delegate", {
      ...DELEGATION,
      scope: { includes: ["docs/**"] },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("scope_widening");
    expect(JSON.stringify(result.reasons)).toContain("docs/**");

    // Nothing was persisted: a refused delegation leaves no node behind.
    const nodes = await world.stores.executionNodes.listByRun({
      projectId: world.program.projectId,
      programId: world.program.programId,
      runId:
        (await world.stores.runs.listByProgram(world.program)).items[0]?.runId ?? ("" as never),
    });
    expect(nodes.items.filter((node) => node.kind === "job")).toEqual([]);
    await mcp.stop();
  });

  it("refuses an invalid contract before anything is persisted", async () => {
    const world = await createBaseWorld();
    const mcp = await attached(world);
    const result = await mcp.call("delegate", { ...DELEGATION, acceptance: [] });
    // The SDK's own schema check catches an empty acceptance list first, which is
    // the same refusal one layer earlier.
    expect(result.ok).toBe(false);
    await mcp.stop();
  });

  it("refuses a risk whose examination policy requires an examiner (D-P3-07)", async () => {
    const world = await createBaseWorld({
      program: {
        examinationPolicy: {
          low: {
            required: false,
            mustDifferModel: false,
            mustDifferProvider: false,
            blockOnMaterialFindings: false,
          },
          medium: {
            required: false,
            mustDifferModel: false,
            mustDifferProvider: false,
            blockOnMaterialFindings: false,
          },
          high: {
            required: true,
            mustDifferModel: true,
            mustDifferProvider: true,
            blockOnMaterialFindings: true,
          },
        },
      },
    });
    const mcp = await attached(world);
    const result = await mcp.call("delegate", { ...DELEGATION, risk: "high" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("examination_unavailable");
    // Refused loudly, and it says what to do instead of pretending.
    expect(String(result.message)).toContain("P7");
    await mcp.stop();
  });

  it("refuses a model the program's policy forbids, rather than substituting one", async () => {
    const world = await createBaseWorld();
    const mcp = await attached(world);
    const result = await mcp.call("delegate", { ...DELEGATION, model: "some-other-model" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("validation_failed");
    expect(String(result.message)).toContain("some-other-model");
    await mcp.stop();
  });

  it("queues a second job past the limit instead of refusing it, and says why it waits (D-P6-02)", async () => {
    const world = await createBaseWorld();
    const mcp = await attached(world);
    const first = await mcp.call("delegate", DELEGATION);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.status).toBe("running");

    // The fixture program allows one job at a time. The second is accepted.
    const second = await mcp.call("delegate", DELEGATION);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.status).toBe("queued");
    const waiting = await mcp.call("job.get", { jobId: second.jobId });
    expect(waiting.status).toBe("queued");
    expect(waiting.waitingFor).toMatchObject({ kind: "parent_full", maxConcurrency: 1 });

    // Either can be cancelled: a queued job is withdrawn, a running one stopped.
    expect((await mcp.call("job.cancel", { jobId: second.jobId })).status).toBe("cancelled");
    await mcp.call("job.cancel", { jobId: first.jobId });
    await mcp.stop();
  });

  it("refuses to finish the run while a job is running", async () => {
    const world = await createBaseWorld();
    const mcp = await attached(world);
    const job = await mcp.call("delegate", DELEGATION);
    const finished = await mcp.call("run.finish", { outcome: "succeeded" });
    expect(finished.ok).toBe(false);
    expect(finished.code).toBe("job_running");
    await mcp.call("job.cancel", { jobId: job.jobId });
    await mcp.stop();
  });
});

describe("job.wait", () => {
  it("returns before its cap with timedOut: true, rather than hitting the harness's timeout", async () => {
    const world = await createBaseWorld();
    const mcp = await start(
      world,
      createFakeHarness({
        script: async ({ cancelled }) => {
          await cancelled;
          return { kind: "cancelled" };
        },
      }),
    );
    await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    const job = await mcp.call("delegate", DELEGATION);

    const started = Date.now();
    const waited = await mcp.call("job.wait", { jobId: job.jobId, timeoutSeconds: 1 });
    expect(waited.timedOut).toBe(true);
    expect(waited.status).toBe("running");
    expect(Date.now() - started).toBeLessThan(10_000);
    // And it still answers everything job.get would, so the wait is never wasted.
    expect(waited.nodeId).toBe(job.nodeId);

    await mcp.call("job.cancel", { jobId: job.jobId });
    await mcp.stop();
  });

  /**
   * The cap is the point, not its default value: a request for an hour must come
   * back in the cap's time, whatever the cap is. Configured down to two seconds
   * here so the assertion costs two seconds rather than the default's
   * fifty-five — `npm test` runs this on every push.
   */
  it("caps a request that asks for longer than the harness would allow", async () => {
    const world = await createBaseWorld();
    const mcp = await start(
      world,
      createFakeHarness({
        script: async ({ cancelled }) => {
          await cancelled;
          return { kind: "cancelled" };
        },
      }),
      { NIGHTSHIFT_JOB_WAIT_CAP_SECONDS: "2" },
    );
    await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    const job = await mcp.call("delegate", DELEGATION);

    const startedAt = Date.now();
    const waited = await mcp.call("job.wait", { jobId: job.jobId, timeoutSeconds: 3600 });
    expect(waited.waitedSeconds).toBe(2);
    expect(waited.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(DEFAULT_JOB_WAIT_CAP_SECONDS).toBeLessThan(60);

    await mcp.call("job.cancel", { jobId: job.jobId });
    await mcp.stop();
  });
});
