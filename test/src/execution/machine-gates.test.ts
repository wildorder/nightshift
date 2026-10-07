/**
 * The gate audit on a remote run's machine (`auditOnMachine`), against the real
 * control plane: a red base no longer ends the run (P15, D-P15-03). It is
 * recorded as a `gate.red` event on the program node, with each red gate's
 * output kept beside it, and the root starts: its first job is the repair. Everything a machine adds (the volume, the worker
 * users) is out of the picture; the checkout is the fixture repository.
 */
import { join } from "node:path";
import type { CommitSha, Dispatch, ProgramContract } from "@nightshift/contracts";
import { startRun } from "@nightshift/execution";
import { auditOnMachine, type MachineAuditContext } from "@nightshift/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { type BaseWorld, cleanupWorlds, createBaseWorld, localPathsIn } from "./world.js";

afterEach(cleanupWorlds);

const BROKEN = `node -e "console.log('the base is broken');process.exit(1)"`;

const machine = async (program: Partial<ProgramContract>, input: { generation?: number } = {}) => {
  const world: BaseWorld = await createBaseWorld({ program });
  const started = await startRun(
    { stores: world.stores, clock: world.clock, ids: world.ids, git: world.git },
    { program: world.program, repoPath: world.repo },
  );
  const scope = {
    projectId: world.program.projectId,
    programId: world.program.programId,
    runId: started.run.runId,
  };
  const context: MachineAuditContext = {
    scope,
    program: world.program,
    layout: {
      root: world.stateDir,
      mirror: join(world.stateDir, "mirror.git"),
      stores: join(world.stateDir, "stores"),
      checkout: world.repo,
      run: join(world.stateDir, "runs", started.run.runId),
    },
    dispatch: {
      generation: input.generation ?? 1,
      engineAgentId: "agent_01M4ENG1NE000000000000000",
      input: {
        repositoryUrl: "https://github.com/example/fixture",
        branch: world.program.repository.programBranch,
        baseSha: started.baseCommit as CommitSha,
        planHash: "unused",
      },
    } as unknown as Dispatch,
  };
  const lines: string[] = [];
  const runtime = {
    git: world.git,
    stores: world.stores,
    bodies: world.bodies,
    ids: world.ids,
    clock: world.clock,
    paths: localPathsIn(world.stateDir),
  };
  const result = await auditOnMachine(runtime, context, (line) => lines.push(line));
  const run = await world.stores.runs.get(scope, scope.runId);
  return { world, result, run, lines, started };
};

describe("the gate audit on a run's machine", () => {
  it("lets the root start when the base's gates pass", async () => {
    const { result, run } = await machine({
      verification: [{ id: "test", command: `node -e "process.exit(0)"` }],
    });
    expect(result.audit?.red).toBe(false);
    expect(run?.status).toBe("pending");
  });

  it("records gate.red on the program node and lets the root start, keeping each red gate's output", async () => {
    const { world, result, run, started, lines } = await machine({
      verification: [{ id: "build", command: BROKEN }],
    });
    expect(result.audit?.red).toBe(true);
    expect(run?.status).toBe("pending");
    expect(lines.at(-1)).toContain("first job is their repair");
    const scope = {
      projectId: world.program.projectId,
      programId: world.program.programId,
      runId: run?.runId as never,
    };

    const root = await world.stores.executionNodes.get(scope, started.rootNode.executionNodeId);
    expect(root?.status).toBe("validated");
    const red = (await world.stores.events.listByRun(scope)).items.filter(
      (event) => event.type === "gate.red",
    );
    expect(red).toHaveLength(1);
    expect(red[0]?.executionNodeId).toBe(started.rootNode.executionNodeId);
    expect(red[0]?.source).toBe("control-plane");
    expect(red[0]?.payload).toEqual({ baseCommit: started.baseCommit, failing: ["build"] });

    const artifacts = await world.stores.artifacts.listByRun(scope);
    expect(
      artifacts.items
        .filter((artifact) => artifact.executionNodeId === started.rootNode.executionNodeId)
        .map((artifact) => artifact.kind),
    ).toEqual(["verification-log"]);
  });

  it("does not audit again on a replacement machine, whose run has already begun", async () => {
    const { result, lines } = await machine(
      { verification: [{ id: "build", command: BROKEN }] },
      { generation: 2 },
    );
    expect(result).toEqual({});
    expect(lines).toEqual([]);
  });
});
