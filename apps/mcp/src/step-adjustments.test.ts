/**
 * `step.timeout` and `step.skip` in the root's and a strand's servers (P19 S-02).
 *
 * The tools' own handlers over in-memory stores: what is under test is what each
 * server reads, refuses and records. The strand's server reads the contract in
 * its checkout at HEAD (a temp git repo) and the verifications it can see.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExecutionNode, Verification } from "@nightshift/contracts";
import {
  createFixtures,
  type Fixtures,
  makeCheckpoint,
  makeEvent,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
  makeVerification,
} from "@nightshift/core";
import { nodeGitRunner } from "@nightshift/execution";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterAll, describe, expect, it } from "vitest";
import { endGatesFailedMessage, registerOrchestratorTools } from "./orchestrator.js";
import type { AttachedRun, OrchestratorSession } from "./session.js";
import { registerSubOrchestratorTools } from "./sub-orchestrator.js";

type Handler = (input: Record<string, unknown>) => Promise<{
  readonly structuredContent?: Record<string, unknown>;
  readonly content?: readonly { readonly text?: string }[];
}>;

const toolsOf = (register: (server: McpServer) => void): ReadonlyMap<string, Handler> => {
  const tools = new Map<string, Handler>();
  register({
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer);
  return tools;
};

const WALL_CLOCK = 3600;
const STEPS = [
  { id: "unit", command: "npm test" },
  { id: "trial", command: "npm run trial" },
];

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const T = (minute: number) => `2026-10-07T03:${String(minute).padStart(2, "0")}:00.000Z`;

interface World {
  readonly f: Fixtures;
  readonly stores: ReturnType<typeof createInMemoryStores>;
  /** The node the role's decisions are recorded on. */
  readonly ownNodeId: string;
  readonly call: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** A verification on `node`, with an event naming it when `announce` is true. */
  readonly verify: (
    node: ExecutionNode,
    results: Record<string, number>,
    minute: number,
    announce?: boolean,
  ) => Promise<Verification>;
  /** A node outside the role's own subtree (a sibling job under the root). */
  readonly sibling: () => Promise<ExecutionNode>;
  readonly ownNode: ExecutionNode;
}

const common = async (kind: "root" | "strand") => {
  const f = createFixtures();
  const stores = createInMemoryStores();
  const program = makeProgramContract(f, {
    verification: STEPS,
    costPolicy: { maxUsd: 50, maxWallClockSeconds: WALL_CLOCK },
  });
  const run = makeRun(f);
  await stores.runs.put(run);
  const root = makeRootNode(f);
  await stores.executionNodes.put(root);
  await stores.checkpoints.put(makeCheckpoint(f, f.rootNodeId));
  const strandNode =
    kind === "strand"
      ? makeNode(f, f.rootNodeId, { kind: "sub-program", status: "running", depth: 1 })
      : undefined;
  if (strandNode !== undefined) await stores.executionNodes.put(strandNode);
  const ownNode = strandNode ?? root;
  const verify: World["verify"] = async (node, results, minute, announce = true) => {
    const commands = Object.entries(results).map(([stepId, exitCode]) => ({
      stepId,
      command: stepId,
      exitCode,
      durationMs: 1,
    }));
    const verification = makeVerification(f, node, {
      commands,
      outcome: commands.every((c) => c.exitCode === 0) ? "passed" : "failed",
      startedAt: T(minute),
      endedAt: T(minute),
    });
    await stores.verifications.put(verification);
    if (announce) {
      await stores.events.append(
        makeEvent(f, {
          type: "verification.completed",
          executionNodeId: node.executionNodeId,
          payload: { verificationId: verification.verificationId },
        }),
      );
    }
    return verification;
  };
  const sibling: World["sibling"] = async () => {
    const node = makeNode(f, f.rootNodeId, { status: "integrated" });
    await stores.executionNodes.put(node);
    return node;
  };
  return { f, stores, program, ownNode, verify, sibling };
};

const rootWorld = async (): Promise<World> => {
  const { f, stores, program, ownNode, verify, sibling } = await common("root");
  const attached = {
    session: {
      scope: f.scope,
      program,
      run: makeRun(f),
      rootNodeId: f.rootNodeId,
      orchestratorAgentId: f.ids.next("agent"),
      repoPath: "/nowhere",
    },
    environment: { stores },
    engine: { idle: () => true },
    outbox: { emit: () => undefined, flush: async () => undefined },
  } as unknown as AttachedRun;
  const state = {
    current: attached,
    runtime: { stores, ids: f.ids, clock: { now: () => Date.parse(T(30)) } },
  } as unknown as OrchestratorSession;
  const tools = toolsOf((server) => registerOrchestratorTools(server, { state, env: {} }));
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await (tools.get(name) as Handler)(input);
    return { ...result.structuredContent, text: result.content?.[0]?.text };
  };
  return { f, stores, ownNodeId: f.rootNodeId, ownNode, call, verify, sibling };
};

const strandWorld = async (): Promise<World> => {
  const { f, stores, program, ownNode, verify, sibling } = await common("strand");
  const repo = mkdtempSync(join(tmpdir(), "step-adjustments-"));
  temporary.push(repo);
  writeFileSync(
    join(repo, "nightshift.program.json"),
    JSON.stringify({
      programId: program.programId,
      verification: STEPS,
      costPolicy: program.costPolicy,
    }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "contract");
  const tools = toolsOf((server) =>
    registerSubOrchestratorTools(server, {
      identity: {
        scope: f.scope,
        executionNodeId: ownNode.executionNodeId,
        jobContractId: f.ids.next("job"),
        agentId: f.ids.next("agent"),
        worktree: repo,
      },
      environment: {
        stores,
        clock: { now: () => Date.parse(T(30)) },
        git: nodeGitRunner,
        outbox: { emit: () => undefined },
      },
      ids: f.ids,
      waitCapSeconds: 1,
      env: {},
    } as never),
  );
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await (tools.get(name) as Handler)(input);
    return { ...result.structuredContent, text: result.content?.[0]?.text };
  };
  return { f, stores, ownNodeId: ownNode.executionNodeId, ownNode, call, verify, sibling };
};

const decisionsOf = async (world: World) =>
  (await world.stores.decisions.listByRun(world.f.scope)).items;

describe.each([
  ["the root's server", rootWorld],
  ["a strand's server", strandWorld],
])("step.timeout and step.skip in %s", (_name, build) => {
  it("refuses a raise past the fixed maximum, naming it", async () => {
    const world = await build();
    const result = await world.call("step.timeout", {
      stepId: "trial",
      timeoutSeconds: 7201,
      reason: "slow",
    });
    expect(result.ok).toBe(false);
    expect(String(result.message)).toContain("7200");
    expect(await decisionsOf(world)).toEqual([]);
  });

  it("refuses a raise whose timeout plus cleanup exceeds the wall clock", async () => {
    const world = await build();
    const result = await world.call("step.timeout", {
      stepId: "trial",
      timeoutSeconds: 3600,
      reason: "slow",
    });
    expect(result.ok).toBe(false);
    expect(String(result.message)).toContain("maxWallClockSeconds of 3600");
  });

  it("refuses a raise without a reason, and an unknown step", async () => {
    const world = await build();
    const noReason = await world.call("step.timeout", { stepId: "trial", timeoutSeconds: 1800 });
    expect(noReason.ok).toBe(false);
    const unknown = await world.call("step.timeout", {
      stepId: "nope",
      timeoutSeconds: 1800,
      reason: "x",
    });
    expect(unknown.ok).toBe(false);
    expect(String(unknown.message)).toContain('"nope"');
    expect((await world.call("step.skip", { stepId: "trial" })).ok).toBe(false);
  });

  it("refuses to skip a step that ran and failed", async () => {
    const world = await build();
    await world.verify(world.ownNode, { unit: 1 }, 1);
    const result = await world.call("step.skip", { stepId: "unit", reason: "red" });
    expect(result.ok).toBe(false);
    expect(String(result.message)).toContain(
      "ran and failed with exit 1; fix it, it cannot be skipped",
    );
    expect(await decisionsOf(world)).toEqual([]);
  });

  it("refuses to skip a step that passed", async () => {
    const world = await build();
    await world.verify(world.ownNode, { unit: 0 }, 1);
    const result = await world.call("step.skip", { stepId: "unit", reason: "green" });
    expect(result.ok).toBe(false);
    expect(String(result.message)).toContain("passed");
  });

  it("records a skip of a step whose most recent run timed out, on the role's node", async () => {
    const world = await build();
    await world.verify(world.ownNode, { trial: 124 }, 1);
    const result = await world.call("step.skip", {
      stepId: "trial",
      reason: "waiting longer failed",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const decisions = await decisionsOf(world);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.context.startsWith("STEP SKIPPED:")).toBe(true);
    expect(decisions[0]?.executionNodeId).toBe(world.ownNodeId);
    expect(decisions[0]?.rationale).toBe("waiting longer failed");
    expect(result.decisionId).toBe(decisions[0]?.decisionId);
  });

  it("records a raise from 600 to 1800", async () => {
    const world = await build();
    const result = await world.call("step.timeout", {
      stepId: "trial",
      timeoutSeconds: 1800,
      reason: "the trial is real work",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const decisions = await decisionsOf(world);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.context).toContain("1800");
    expect(String(result.text)).toContain("next verification applies it");
    expect(decisions[0]?.executionNodeId).toBe(world.ownNodeId);
  });
});

describe("a strand's skip, from the history it can read", () => {
  it("is refused when a newer run outside its subtree, known by its event, passed", async () => {
    const world = await strandWorld();
    await world.verify(world.ownNode, { trial: 124 }, 1);
    const other = await world.sibling();
    await world.verify(other, { trial: 0 }, 2);
    const result = await world.call("step.skip", { stepId: "trial", reason: "timed out" });
    expect(result.ok).toBe(false);
    expect(String(result.message)).toContain("passed");
    expect(await decisionsOf(world)).toEqual([]);
  });

  it("is refused when a newer run outside its subtree exited 1", async () => {
    const world = await strandWorld();
    await world.verify(world.ownNode, { trial: 124 }, 1);
    const other = await world.sibling();
    await world.verify(other, { trial: 1 }, 2);
    const result = await world.call("step.skip", { stepId: "trial", reason: "timed out" });
    expect(result.ok).toBe(false);
    expect(String(result.message)).toContain("ran and failed with exit 1");
  });

  it("does not see a newer run on another node that no event names, and says the engine decides", async () => {
    const world = await strandWorld();
    await world.verify(world.ownNode, { trial: 124 }, 1);
    const other = await world.sibling();
    await world.verify(other, { trial: 0 }, 2, false);
    const result = await world.call("step.skip", { stepId: "trial", reason: "timed out" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(String(result.text)).toContain("complete history agrees");
    expect(String(result.text)).toContain("announced on this strand's node");
  });

  it("refuses with a clear message when its checkout holds no contract", async () => {
    const world = await strandWorld();
    // A program id the checkout's contract does not name.
    const tools = toolsOf((server) =>
      registerSubOrchestratorTools(server, {
        identity: {
          scope: world.f.scope,
          executionNodeId: world.ownNode.executionNodeId,
          jobContractId: world.f.ids.next("job"),
          agentId: world.f.ids.next("agent"),
          worktree: tmpdir(),
        },
        environment: {
          stores: world.stores,
          clock: { now: () => 0 },
          git: nodeGitRunner,
          outbox: { emit: () => undefined },
        },
        ids: world.f.ids,
        waitCapSeconds: 1,
        env: {},
      } as never),
    );
    const result = (
      await (tools.get("step.timeout") as Handler)({
        stepId: "trial",
        timeoutSeconds: 1800,
        reason: "x",
      })
    ).structuredContent;
    expect(result?.ok).toBe(false);
    expect(String(result?.message)).toContain("contract could not be read");
  });
});

describe("run.finish's answer leads with what was not verified (P19 S-02)", () => {
  it("names a skipped step and a raised timeout, in its text and in notVerified", async () => {
    const world = await rootWorld();
    await world.verify(world.ownNode, { trial: 124 }, 1);
    const raised = await world.call("step.timeout", {
      stepId: "trial",
      timeoutSeconds: 1800,
      reason: "the trial is real work",
    });
    await world.verify(world.ownNode, { trial: 124 }, 2);
    const skipped = await world.call("step.skip", { stepId: "trial", reason: "still too slow" });
    expect(skipped.ok, JSON.stringify(skipped)).toBe(true);
    const landing = makeVerification(world.f, world.ownNode, {
      commands: [
        { stepId: "unit", command: "unit", exitCode: 0, durationMs: 1 },
        {
          stepId: "trial",
          command: "trial",
          skipped: { decisionId: skipped.decisionId as string },
          durationMs: 0,
        },
      ],
      outcome: "passed",
      startedAt: T(3),
      endedAt: T(3),
    });
    await world.stores.verifications.put(landing);

    const result = await world.call("run.finish", { outcome: "failed", reason: "testing" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const text = String(result.text);
    expect(text.startsWith("Step trial was skipped by decision")).toBe(true);
    expect(text).toContain(skipped.decisionId as string);
    expect(text).toContain("still too slow");
    expect(text).toContain("the engine honoured it");
    expect(text).toContain("from 600 to 1800");
    expect(result.notVerified).toEqual({
      skipped: [
        {
          stepId: "trial",
          decisionId: skipped.decisionId,
          reason: "still too slow",
          commits: [landing.commitSha],
          honoured: true,
        },
      ],
      raised: [
        {
          stepId: "trial",
          decisionId: raised.decisionId,
          field: "timeoutSeconds",
          from: 600,
          to: 1800,
          reason: "the trial is real work",
        },
      ],
    });
  });

  it("says nothing was skipped when nothing was", async () => {
    const world = await rootWorld();
    const result = await world.call("run.finish", { outcome: "failed", reason: "testing" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(String(result.text)).toContain("Nothing was skipped and no timeout was raised.");
    expect(result.notVerified).toEqual({ skipped: [], raised: [] });
  });
});

describe("the end_gates_failed refusal's text", () => {
  it("names both tools and the timeout for a gate that timed out, and fixes a failed one", () => {
    const text = endGatesFailedMessage(
      "abcdef0123456789",
      [
        { stepId: "trial", exitCode: 124 },
        { stepId: "unit", exitCode: 1 },
      ],
      [{ stepId: "trial", timeoutSeconds: 1800 }],
    );
    expect(text).toContain("trial timed out after 1800 seconds");
    expect(text).toContain("unit exited 1");
    expect(text.indexOf("step.timeout")).toBeGreaterThan(-1);
    expect(text.indexOf("step.skip")).toBeGreaterThan(text.indexOf("step.timeout"));
    expect(text).toContain("Never skip a step that failed: fix it.");
    expect(text).toContain("then call run.finish again".replace("then", "Then"));
  });

  it("does not mention the tools when nothing timed out", () => {
    const text = endGatesFailedMessage("abcdef0123456789", [{ stepId: "unit", exitCode: 1 }], []);
    expect(text).not.toContain("step.skip");
  });
});
