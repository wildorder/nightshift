/**
 * The gate audit on a remote run's machine (`auditOnMachine`), against the real
 * control plane: a red base no longer ends the run (P15, D-P15-03). It is
 * recorded as a `gate.red` event on the program node, with each red gate's
 * output kept beside it, and the root starts: its first job is the repair. Everything a machine adds (the volume, the worker
 * users) is out of the picture; the checkout is the fixture repository.
 */
import { join } from "node:path";
import { encodeTestPrincipal } from "@nightshift/api/testing";
import {
  type ArtifactId,
  type CheckDispatch,
  type CommitSha,
  type Dispatch,
  EnvironmentFaultPayloadSchema,
  type Prerequisite,
  type ProgramContract,
  type ReferenceGate,
} from "@nightshift/contracts";
import { createFixtures, gatherReport, makeDispatch, renderReport } from "@nightshift/core";
import { startRun } from "@nightshift/execution";
import { auditThenRoot, type MachineAuditContext, type Runtime } from "@nightshift/mcp";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
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
    /** The laptop's reference audit (P16 D-06): its gates, and its Node. */
    reference?: { gates: ReferenceGate[]; node?: string };
    /**
     * Bodies as a machine's runtime has them (`createRuntime`): the plane's
     * signed upload, and no way to read one back.
     */
    writeOnlyBodies?: boolean;
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
        ...(input.reference === undefined
          ? {}
          : {
              reference: {
                base: started.baseCommit,
                auditedAt: "2026-10-09T00:00:00.000Z",
                ...input.reference,
              },
            }),
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
    bodies:
      input.writeOnlyBodies === true
        ? createHttpArtifactBodyStore({
            transport: createFetchTransport({
              endpoint: world.plane.url,
              tokens: staticTokenProvider("ignored-by-the-local-plane"),
            }),
          })
        : world.bodies,
    ids: world.ids,
    clock: world.clock,
    paths: localPathsIn(world.stateDir),
    ...(prerequisites === undefined ? {} : { prerequisites }),
  };
  // The runner's work: the audit, then the root, which is only noted here.
  let rootStarted = false;
  const { audited: result, ended } = await auditThenRoot(
    runtime,
    context,
    (line) => lines.push(line),
    async () => {
      rootStarted = true;
    },
  );
  const run = await world.stores.runs.get(scope, scope.runId);
  return { world, result, run, lines, started, ended, rootStarted };
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

  it("gives the audit's setup and checks, and the prerequisite checks, the project environment whole, adopting none of it (P16, D-10)", async () => {
    const before = { ...process.env };
    const projectEnv = {
      NS_PROJECT_ONLY: "from-project",
      DOCKER_HOST: "unix:///run/ns-machine-test/docker.sock",
      npm_config_cache: "/ns-machine-test/stores/npm",
      CARGO_HOME: "/ns-machine-test/stores/cargo",
      RUSTUP_TOOLCHAIN: "1.82.0",
    };
    const probe = `node -e "const e=process.env;process.exit(e.NS_PROJECT_ONLY==='from-project'&&e.DOCKER_HOST==='unix:///run/ns-machine-test/docker.sock'&&e.npm_config_cache==='/ns-machine-test/stores/npm'&&e.CARGO_HOME==='/ns-machine-test/stores/cargo'&&e.RUSTUP_TOOLCHAIN==='1.82.0'?0:1)"`;
    const recorded: Recorded[] = [];
    const { result } = await machine(
      {
        prerequisites: [
          {
            id: "HP-01",
            description: "The project environment.",
            remediation: "None.",
            verifyCommand: probe,
            status: "pending",
          },
        ],
        setup: [{ id: "install", command: probe }],
        verification: [{ id: "probe", command: probe, requires: ["HP-01"] }],
      },
      { recorded, projectEnv },
    );
    expect(recorded.map((check) => [check.prerequisiteId, check.exitCode])).toEqual([["HP-01", 0]]);
    expect(result.audit?.gates.map((gate) => [gate.id, gate.verdict])).toEqual([
      ["setup:install", "passed"],
      ["probe", "passed"],
    ]);
    expect({ ...process.env }).toEqual(before);
    expect(process.env.NS_PROJECT_ONLY).toBeUndefined();
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

  describe("compared with the laptop's reference (P16 S-02, D-07)", () => {
    const REFERENCE_OUTPUT = "art_01M4AAAAAAAAAAAAAAAAAAAAAA" as ArtifactId;
    const program = {
      verification: [
        { id: "build", command: `node -e "process.exit(0)"` },
        { id: "unit", command: BROKEN },
        { id: "lint", command: BROKEN },
      ],
    };
    const eventsOf = async (world: BaseWorld, runId: string) =>
      (
        await world.stores.events.listByRun({
          projectId: world.program.projectId,
          programId: world.program.programId,
          runId: runId as never,
        })
      ).items;

    it("passed on the reference and failed here is an environment fault: no gate.red, the run cancelled, the root never started", async () => {
      const { world, result, run, started, lines, ended, rootStarted } = await machine(program, {
        reference: {
          node: "20.0.1",
          gates: [
            { id: "build", kind: "check", verdict: "passed" },
            { id: "unit", kind: "check", verdict: "passed", outputArtifactId: REFERENCE_OUTPUT },
            // Red on both: still no gate.red, since the fault outranks it.
            { id: "lint", kind: "check", verdict: "failed" },
          ],
        },
      });
      const machineNode = process.versions.node;
      expect(result.comparison?.faults.map((gate) => gate.id)).toEqual(["unit"]);

      expect(rootStarted).toBe(false);
      expect(ended?.failure.code).toBe("environment_fault");
      expect(ended?.failure.message).toContain("unit");
      expect(ended?.failure.message).toContain("20.0.1");
      expect(ended?.failure.message).toContain(machineNode);
      expect(ended?.failure.message).not.toContain("lint");

      expect(run?.status).toBe("cancelled");
      expect(run?.outcomeReason).toBe(ended?.failure.message);
      expect(run?.outcomeReason).toContain("environment fault");
      expect(lines.join("\n")).toContain("environment fault");

      const events = await eventsOf(world, started.run.runId);
      expect(events.some((event) => event.type === "gate.red")).toBe(false);
      const faults = events.filter((event) => event.type === "environment.fault");
      expect(faults).toHaveLength(1);
      expect(faults[0]?.executionNodeId).toBe(started.rootNode.executionNodeId);
      expect(faults[0]?.source).toBe("control-plane");
      const payload = EnvironmentFaultPayloadSchema.parse(faults[0]?.payload);
      expect(payload).toMatchObject({
        baseCommit: started.baseCommit,
        referenceNode: "20.0.1",
        machineNode,
        gates: [
          {
            id: "unit",
            command: BROKEN,
            kind: "check",
            reference: "passed",
            machine: "failed",
            referenceOutputArtifactId: REFERENCE_OUTPUT,
          },
        ],
      });
      const machineOutput = payload.gates[0]?.machineOutputArtifactId;
      expect(machineOutput).toMatch(/^art_/);
      const artifact = await world.stores.artifacts.get(
        {
          projectId: world.program.projectId,
          programId: world.program.programId,
          runId: started.run.runId,
        },
        machineOutput as ArtifactId,
      );
      expect(artifact).toMatchObject({
        executionNodeId: started.rootNode.executionNodeId,
        kind: "verification-log",
      });
    });

    it("records the fault with both outputs' tails on a machine whose bodies cannot be read back (F-01)", async () => {
      const { world, started, ended, rootStarted } = await machine(
        {
          verification: [
            { id: "build", command: `node -e "process.exit(0)"` },
            { id: "unit", command: BROKEN },
          ],
        },
        {
          writeOnlyBodies: true,
          reference: {
            node: "20.0.1",
            gates: [
              { id: "build", kind: "check", verdict: "passed" },
              {
                id: "unit",
                kind: "check",
                verdict: "passed",
                // Kept on the laptop, and unreadable here: the tail travels inline.
                outputArtifactId: REFERENCE_OUTPUT,
                outputTail: "Tests  12 passed (12)",
              },
            ],
          },
        },
      );
      expect(rootStarted).toBe(false);
      expect(ended?.failure.code).toBe("environment_fault");
      const events = await eventsOf(world, started.run.runId);
      const payload = EnvironmentFaultPayloadSchema.parse(
        events.find((event) => event.type === "environment.fault")?.payload,
      );
      expect(payload.gates).toHaveLength(1);
      expect(payload.gates[0]).toMatchObject({
        id: "unit",
        reference: "passed",
        machine: "failed",
        referenceOutputArtifactId: REFERENCE_OUTPUT,
        referenceTail: "Tests  12 passed (12)",
      });
      expect(payload.gates[0]?.machineTail).toContain("the base is broken");

      // The report reads it from the event alone, side by side.
      const report = await gatherReport(world.stores, {
        projectId: world.program.projectId,
        programId: world.program.programId,
        runId: started.run.runId,
      });
      expect(report.gateHealth.environmentFault?.gates[0]?.referenceTail).toBe(
        "Tests  12 passed (12)",
      );
      const text = renderReport(report);
      expect(text).toContain("| `unit` |");
      expect(text).toContain("Tests  12 passed (12)");
      expect(text).toContain("the base is broken");
      expect(text).toContain("Node 20.0.1");
    });

    it("still records the fault when the reference carried no tail and its artifact cannot be read", async () => {
      const { world, started, ended } = await machine(
        { verification: [{ id: "unit", command: BROKEN }] },
        {
          writeOnlyBodies: true,
          reference: {
            gates: [
              { id: "unit", kind: "check", verdict: "passed", outputArtifactId: REFERENCE_OUTPUT },
            ],
          },
        },
      );
      expect(ended?.failure.code).toBe("environment_fault");
      const events = await eventsOf(world, started.run.runId);
      const payload = EnvironmentFaultPayloadSchema.parse(
        events.find((event) => event.type === "environment.fault")?.payload,
      );
      expect(payload.gates[0]?.referenceTail).toBeUndefined();
      expect(payload.gates[0]?.machineTail).toContain("the base is broken");
    });

    it("failed on both is a red base as today: gate.red, and the root starts", async () => {
      const { world, run, started, ended, rootStarted } = await machine(
        { verification: [{ id: "unit", command: BROKEN }] },
        {
          reference: {
            node: "20.0.1",
            gates: [{ id: "unit", kind: "check", verdict: "failed" }],
          },
        },
      );
      expect(ended).toBeUndefined();
      expect(rootStarted).toBe(true);
      expect(run?.status).toBe("pending");
      const events = await eventsOf(world, started.run.runId);
      expect(events.some((event) => event.type === "environment.fault")).toBe(false);
      expect(events.find((event) => event.type === "gate.red")?.payload).toEqual({
        baseCommit: started.baseCommit,
        failing: ["unit"],
      });
    });

    it("without a reference behaves as before: gate.red, and the root starts", async () => {
      const { world, run, started, ended, rootStarted, result } = await machine({
        verification: [{ id: "unit", command: BROKEN }],
      });
      expect(result.comparison?.faults).toEqual([]);
      expect(ended).toBeUndefined();
      expect(rootStarted).toBe(true);
      expect(run?.status).toBe("pending");
      const events = await eventsOf(world, started.run.runId);
      expect(events.some((event) => event.type === "environment.fault")).toBe(false);
      expect(events.filter((event) => event.type === "gate.red")).toHaveLength(1);
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
