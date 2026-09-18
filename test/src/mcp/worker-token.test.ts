/**
 * A worker on its execution token, end to end (T4 deliverable 5; SC-P4-04,
 * SC-P4-06).
 *
 * The **real** worker-role MCP server, built through the **real** composition
 * root, reaching the control plane over loopback with the token the control
 * plane minted for its agent — and nothing else. No profile, no credentials
 * file, no operator session.
 *
 * What this adds over the offline matrix in `apps/api`: that matrix proves the
 * API refuses what it should, with principals a suite constructed. This proves
 * the worker *is* one of those principals in the first place, because its
 * transport carries a token it was handed rather than an identity it inherited.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Agent, ExecutionNode, JobContract, Run } from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import { createNightshiftServer, EXECUTION_TOKEN_ENV, WORKER_IDENTITY_ENV } from "@nightshift/mcp";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BaseWorld,
  cleanupWorlds,
  createBaseWorld,
  PROGRAM_BRANCH,
} from "../execution/world.js";

afterEach(cleanupWorlds);

interface Seeded {
  readonly world: BaseWorld;
  readonly run: Run;
  readonly node: ExecutionNode;
  readonly agent: Agent;
  readonly job: JobContract;
  readonly token: string;
  readonly worktree: string;
}

/**
 * A run with one job node and one worker agent, and that agent's token — the
 * state the execution layer leaves behind just before it launches a worker.
 */
const seed = async (): Promise<Seeded> => {
  const world = await createBaseWorld();
  const { ids, clock, program } = world;
  const scope = {
    projectId: program.projectId,
    programId: program.programId,
    runId: ids.next("run"),
  };
  const rootNodeId = ids.next("node");
  const at = nowIso(clock);

  // The base world authors and commits the contract but does not store it; the
  // CLI's `run` does that. A worker needs it stored, because `job.complete`
  // reads the program through the run.
  await world.stores.programContracts.put(program);

  const run: Run = {
    schemaVersion: 1,
    ...scope,
    status: "running",
    location: "local",
    rootNodeId,
    startedAt: at,
  };
  await world.stores.runs.put(run);
  await world.stores.executionNodes.put({
    schemaVersion: 1,
    ...scope,
    executionNodeId: rootNodeId,
    kind: "program",
    parentNodeId: null,
    depth: 0,
    scope: program.scope,
    status: "running",
    jobContractId: null,
    commitSha: null,
    createdAt: at,
    updatedAt: at,
  });

  const job: JobContract = {
    schemaVersion: 1,
    ...scope,
    jobContractId: ids.next("job"),
    objective: "Prove a worker runs on its own credential.",
    scope: { includes: ["src/**"] },
    acceptance: ["It holds only an execution token."],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: at,
  };
  await world.stores.jobContracts.put(job);

  const nodeId = ids.next("node");
  const node: ExecutionNode = {
    schemaVersion: 1,
    ...scope,
    executionNodeId: nodeId,
    kind: "job",
    parentNodeId: rootNodeId,
    depth: 1,
    scope: program.scope,
    status: "running",
    jobContractId: job.jobContractId,
    commitSha: null,
    createdAt: at,
    updatedAt: at,
  };
  await world.stores.executionNodes.put(node);

  const agent: Agent = {
    schemaVersion: 1,
    ...scope,
    agentId: ids.next("agent"),
    executionNodeId: nodeId,
    role: "worker",
    harness: "claude",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: "started",
    startedAt: at,
    createdAt: at,
  };
  await world.stores.agents.put(agent);

  // Minted exactly as the runner mints it: the orchestrator's session, the real
  // route, the real signer.
  const { token } = await world.tokens.mint(scope, agent.agentId);

  // The path the runner would cut a worktree at. Left uncreated: the one test
  // that needs a real worktree cuts one with `git worktree add`, which insists
  // on creating the directory itself.
  const worktree = join(world.stateDir, "worktrees", nodeId);
  await mkdir(join(world.stateDir, "worktrees"), { recursive: true });

  return { world, run, node, agent, job, token, worktree };
};

/** The environment the execution layer hands a worker, written out in full. */
const workerEnv = (s: Seeded, overrides: Record<string, string | undefined> = {}) => {
  const env: Record<string, string> = {
    NIGHTSHIFT_ROLE: "worker",
    NIGHTSHIFT_API_ENDPOINT: s.world.plane.url,
    [EXECUTION_TOKEN_ENV]: s.token,
    NIGHTSHIFT_STATE_DIR: s.world.stateDir,
    [WORKER_IDENTITY_ENV.projectId]: s.node.projectId,
    [WORKER_IDENTITY_ENV.programId]: s.node.programId,
    [WORKER_IDENTITY_ENV.runId]: s.node.runId,
    [WORKER_IDENTITY_ENV.executionNodeId]: s.node.executionNodeId,
    [WORKER_IDENTITY_ENV.agentId]: s.agent.agentId,
    [WORKER_IDENTITY_ENV.jobContractId]: s.job.jobContractId,
    [WORKER_IDENTITY_ENV.worktree]: s.worktree,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
};

const structured = (result: CallToolResult): Record<string, unknown> & { ok: boolean } =>
  (result.structuredContent ?? { ok: false }) as Record<string, unknown> & { ok: boolean };

/** A worker server built through the real composition root — no runtime injected. */
const startWorker = async (s: Seeded, overrides: Record<string, string | undefined> = {}) => {
  const server = await createNightshiftServer({ env: workerEnv(s, overrides), cwd: s.worktree });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.273" });
  await client.connect(clientSide);
  return {
    server,
    client,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      structured((await client.callTool({ name, arguments: args })) as CallToolResult),
    stop: async () => {
      await client.close();
      await server.stop("done");
    },
  };
};

describe("a worker holding only its execution token", () => {
  it("reads its own job through the control plane", async () => {
    const s = await seed();
    const worker = await startWorker(s);
    const result = await worker.call("job.get");
    expect(result.ok).toBe(true);
    expect(result.jobContractId).toBe(s.job.jobContractId);
    expect(result.objective).toBe(s.job.objective);
    await worker.stop();
  });

  it("reports progress, and the event is written as the execution principal", async () => {
    const s = await seed();
    const worker = await startWorker(s);
    expect((await worker.call("job.progress", { message: "halfway" })).ok).toBe(true);
    await worker.stop();

    s.world.backing.materializeSequences();
    const events = await s.world.stores.events.listByRun(
      { projectId: s.node.projectId, programId: s.node.programId, runId: s.node.runId },
      {},
    );
    const progress = events.items.filter((event) => event.type === "node.progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]?.executionNodeId).toBe(s.node.executionNodeId);
    expect(progress[0]?.agentId).toBe(s.agent.agentId);
    expect(progress[0]?.source).toBe("mcp");
  });

  it("completes its job: the node reaches implemented on a commit Nightshift authored", async () => {
    const s = await seed();
    // A real worktree cut from the program branch, and the base ref beside it —
    // exactly what the runner leaves for a worker to find.
    await s.world.git(["worktree", "add", "-B", "job-under-test", s.worktree, PROGRAM_BRANCH], {
      cwd: s.world.repo,
    });
    const base = await s.world.git(["rev-parse", "HEAD"], { cwd: s.worktree });
    await s.world.git(
      ["update-ref", `refs/nightshift/base/${s.node.executionNodeId}`, base.stdout.trim()],
      { cwd: s.world.repo },
    );
    await mkdir(join(s.worktree, "src"), { recursive: true });
    await writeFile(join(s.worktree, "src", "worked.txt"), "done\n", "utf8");

    const worker = await startWorker(s);
    const result = await worker.call("job.complete", { summary: "Wrote the file." });
    await worker.stop();

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.outcome).toBe("implemented");

    const node = await s.world.stores.executionNodes.get(
      { projectId: s.node.projectId, programId: s.node.programId, runId: s.node.runId },
      s.node.executionNodeId,
    );
    expect(node?.status).toBe("implemented");
    expect(node?.commitSha).toBe(result.commitSha);
  });

  /**
   * SC-P4-04, through the worker's **own** transport rather than a constructed
   * principal: the credential it actually holds cannot write a verification,
   * cannot create a node, and cannot mint another token.
   */
  it("is refused every operation outside the four it was given", async () => {
    const s = await seed();
    const scope = {
      projectId: s.node.projectId,
      programId: s.node.programId,
      runId: s.node.runId,
    };
    const base = `${s.world.plane.url}/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}`;
    const attempts: readonly (readonly [string, string, string])[] = [
      ["PUT", `${base}/verifications/${s.world.ids.next("ver")}`, "execution_forbidden_operation"],
      // Creating a node: refused as out of scope rather than outright, because
      // `node.put` is how a worker reports its **own** node implemented. A node
      // it was not issued for is not its node, which is the same refusal.
      ["PUT", `${base}/nodes/${s.world.ids.next("node")}`, "execution_out_of_scope"],
      ["PUT", `${base}/agents/${s.world.ids.next("agent")}`, "execution_forbidden_operation"],
      ["POST", `${base}/agents/${s.agent.agentId}/token`, "execution_forbidden_operation"],
      ["PUT", `${base}/checkpoints/${s.world.ids.next("ckpt")}`, "execution_forbidden_operation"],
      ["GET", `${s.world.plane.url}/projects`, "execution_forbidden_operation"],
      ["GET", `${s.world.plane.url}/projects/${scope.projectId}`, "execution_forbidden_operation"],
      ["GET", `${base}/state`, "execution_forbidden_operation"],
    ];

    for (const [method, url, code] of attempts) {
      const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      const body = (await response.json()) as { error?: { code?: string } };
      expect(response.status, `${method} ${url}`).toBe(403);
      expect(body.error?.code, `${method} ${url}`).toBe(code);
    }
  });

  it("cannot reach another run with its own token", async () => {
    const s = await seed();
    const other = await seed();
    // A genuinely valid token — same signer, same issuer — pointed at a run it
    // was not issued for. The signature is fine; the chain is not.
    const response = await fetch(
      `${other.world.plane.url}/projects/${other.node.projectId}` +
        `/programs/${other.node.programId}/runs/${other.node.runId}`,
      { headers: { authorization: `Bearer ${s.token}` } },
    );
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("execution_out_of_scope");
  });
});

describe("SC-P4-06 — a worker reads no credentials file", () => {
  it("refuses to start without a token, even with a perfectly good session beside it", async () => {
    const s = await seed();
    // A real, readable, valid operator session — planted exactly where a worker
    // would have found one before P4.
    const configDir = await mkdtemp(join(tmpdir(), "nightshift-planted-"));
    await writeFile(
      join(configDir, "profile.json"),
      JSON.stringify({
        apiEndpoint: s.world.plane.url,
        authDomain: "planted.auth.example.invalid",
        clientId: "planted-client",
        stage: "test",
      }),
      "utf8",
    );
    await writeFile(
      join(configDir, "credentials.json"),
      JSON.stringify({
        refreshToken: "the-operators-refresh-token-a-worker-must-never-use",
        subject: "11111111-2222-3333-4444-555555555555",
        clientId: "planted-client",
        obtainedAt: nowIso(s.world.clock),
      }),
      "utf8",
    );

    try {
      await expect(
        createNightshiftServer({
          env: {
            ...workerEnv(s, { [EXECUTION_TOKEN_ENV]: undefined }),
            NIGHTSHIFT_CONFIG_DIR: configDir,
          },
          cwd: s.worktree,
        }),
      ).rejects.toThrow(/execution token/i);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("never opens the credentials file when it does have a token", async () => {
    const s = await seed();
    const configDir = await mkdtemp(join(tmpdir(), "nightshift-canary-"));
    // A canary: valid JSON that `readCredentials` would refuse. If the worker
    // read it, it would fail; it starts and works, so it did not.
    await writeFile(join(configDir, "credentials.json"), '{"not":"credentials"}', "utf8");
    await writeFile(join(configDir, "profile.json"), '{"not":"a profile"}', "utf8");

    try {
      const worker = await startWorker(s, { NIGHTSHIFT_CONFIG_DIR: configDir });
      expect((await worker.call("job.get")).ok).toBe(true);
      await worker.stop();
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
