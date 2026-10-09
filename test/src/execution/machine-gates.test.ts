/**
 * The gate audit on a remote run's machine (`auditOnMachine`), against the real
 * control plane: a red base no longer ends the run (P15, D-P15-03). It is
 * recorded as a `gate.red` event on the program node, with each red gate's
 * output kept beside it, and the root starts: its first job is the repair. Everything a machine adds (the volume, the worker
 * users) is out of the picture; the checkout is the fixture repository.
 */
import { join } from "node:path";
import { encodeTestPrincipal } from "@nightshift/api/testing";
import type {
  CheckDispatch,
  CommitSha,
  Dispatch,
  Prerequisite,
  ProgramContract,
} from "@nightshift/contracts";
import { createFixtures, makeDispatch } from "@nightshift/core";
import { startRun } from "@nightshift/execution";
import { auditOnMachine, type MachineAuditContext, type Runtime } from "@nightshift/mcp";
import {
  createFetchTransport,
  createHttpPlanning,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import { type BaseWorld, cleanupWorlds, createBaseWorld, localPathsIn } from "./world.js";

afterEach(cleanupWorlds);

const BROKEN = `node -e "console.log('the base is broken');process.exit(1)"`;

/** What `prerequisite.put` was asked, in order. */
type Recorded = { prerequisiteId: string; exitCode: number; dispatch: CheckDispatch };

const machine = async (
  program: Partial<ProgramContract>,
  input: {
    generation?: number;
    projectEnv?: Readonly<Record<string, string>>;
    /**
     * Record the machine's checks through the real `prerequisite.put`, with an
     * engine token under this run's dispatch, noting each here.
     */
    recorded?: Recorded[];
  } = {},
) => {
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
  const generation = input.generation ?? 1;
  const engineAgentId = world.ids.next("agent");
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
      generation,
      engineAgentId,
      input: {
        repositoryUrl: "https://github.com/example/fixture",
        branch: world.program.repository.programBranch,
        baseSha: started.baseCommit as CommitSha,
        planHash: "unused",
      },
    } as unknown as Dispatch,
    ...(input.projectEnv === undefined ? {} : { projectEnv: input.projectEnv }),
  };
  let prerequisites: Runtime["prerequisites"];
  if (input.recorded !== undefined) {
    // The engine's own view of the plane: its dispatch on record, its token.
    await world.backing.dispatches.put(
      makeDispatch(createFixtures(), { ...scope, engineAgentId, generation }),
    );
    const planning = createHttpPlanning({
      transport: createFetchTransport({
        endpoint: world.plane.url,
        tokens: staticTokenProvider(
          encodeTestPrincipal({
            kind: "execution",
            ...scope,
            nodeId: started.rootNode.executionNodeId,
            agentId: engineAgentId,
            role: "engine",
            generation,
          }),
        ),
      }),
    });
    const recorded = input.recorded;
    prerequisites = {
      ...planning,
      recordMachineCheck: (target, prerequisiteId, exitCode, dispatch) => {
        recorded.push({ prerequisiteId, exitCode, dispatch });
        return planning.recordMachineCheck(target, prerequisiteId, exitCode, dispatch);
      },
    };
  }
  const lines: string[] = [];
  const runtime = {
    git: world.git,
    stores: world.stores,
    bodies: world.bodies,
    ids: world.ids,
    clock: world.clock,
    paths: localPathsIn(world.stateDir),
    ...(prerequisites === undefined ? {} : { prerequisites }),
  };
  const result = await auditOnMachine(runtime, context, (line) => lines.push(line));
  const run = await world.stores.runs.get(scope, scope.runId);
  return { world, result, run, lines, started };
};

describe("the gate audit on a run's machine", () => {
  it("runs the gates in the project environment (P16 S-01)", async () => {
    const { result } = await machine(
      {
        verification: [
          {
            id: "stores",
            command: `node -e "process.exit(process.env.npm_config_cache === '/stores/npm' ? 0 : 1)"`,
          },
        ],
      },
      { projectEnv: { npm_config_cache: "/stores/npm" } },
    );
    expect(result.audit?.red).toBe(false);
  });

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

  describe("the prerequisites, checked on the machine itself (P16, D-08)", () => {
    const SATISFIED_ON_LAPTOP: Prerequisite = {
      id: "HP-01",
      description: "Docker is running.",
      remediation: "Start Docker.",
      verifyCommand: `node -e "process.exit(process.env.MACHINE_HAS_DOCKER === 'yes' ? 0 : 1)"`,
      status: "satisfied",
      lastCheck: { exitCode: 0, checkedAt: "2026-10-08T00:00:00.000Z", where: "laptop" },
    };
    const PENDING_ON_LAPTOP: Prerequisite = {
      id: "HP-02",
      description: "A token exists.",
      remediation: "Make one.",
      verifyCommand: `node -e "process.exit(process.env.MACHINE_HAS_TOKEN === 'yes' ? 0 : 1)"`,
      status: "pending",
    };
    const gated = {
      prerequisites: [SATISFIED_ON_LAPTOP, PENDING_ON_LAPTOP],
      verification: [
        { id: "docker", command: `node -e "process.exit(0)"`, requires: ["HP-01"] },
        { id: "token", command: `node -e "process.exit(0)"`, requires: ["HP-02"] },
      ],
    };

    it("builds the audit's unmet set from its own checks: the laptop's satisfied one fails here, the laptop's pending one passes", async () => {
      const recorded: Recorded[] = [];
      const { world, result, lines, run } = await machine(gated, {
        recorded,
        projectEnv: { MACHINE_HAS_TOKEN: "yes" },
      });
      const dispatch = { runId: run?.runId, generation: 1 };
      // Every prerequisite, recorded as a machine check under this dispatch.
      expect(recorded).toEqual([
        { prerequisiteId: "HP-01", exitCode: 1, dispatch },
        { prerequisiteId: "HP-02", exitCode: 0, dispatch },
      ]);
      const verdicts = Object.fromEntries(
        (result.audit?.gates ?? []).map((gate) => [gate.id, gate.verdict]),
      );
      expect(verdicts).toEqual({ docker: "waiting", token: "passed" });
      expect(result.audit?.gates.find((gate) => gate.id === "docker")?.waitingOn).toEqual([
        "HP-01",
      ]);
      expect(lines).toContain("prerequisites: HP-01 unmet (exited 1) on this machine");
      expect(lines).toContain("prerequisites: HP-02 met on this machine");

      // The laptop's status is the laptop's: the machine's checks moved neither.
      const stored = await world.stores.programContracts.get(
        world.program.projectId,
        world.program.programId,
      );
      expect(stored?.prerequisites?.map((p) => [p.id, p.status, p.lastCheck])).toEqual([
        ["HP-01", "satisfied", SATISFIED_ON_LAPTOP.lastCheck],
        ["HP-02", "pending", undefined],
      ]);
      expect(stored?.prerequisites?.map((p) => p.machineChecks?.[0]?.exitCode)).toEqual([1, 0]);
    });

    it("runs the checks in the project environment, and meets what the machine has", async () => {
      const { result } = await machine(gated, {
        recorded: [],
        projectEnv: { MACHINE_HAS_DOCKER: "yes", MACHINE_HAS_TOKEN: "yes" },
      });
      expect(result.audit?.gates.map((gate) => gate.verdict)).toEqual(["passed", "passed"]);
    });
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
