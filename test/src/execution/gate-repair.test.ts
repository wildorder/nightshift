/**
 * Gate definitions that change when a repair lands (P15, D-P15-04, D-P15-07,
 * D-P15-11, SC-P15-07), over the fake harness, real git, a real verification
 * runner and the production API handler on loopback.
 *
 * A repair's commit changes `nightshift.config.json`; the engine reads the
 * merged definitions at the program head when it lands, records
 * `gate.repaired` (and a decision when they changed), uses them for every
 * verification after, prepares the program checkout as the setup reference,
 * and rewrites the project's gate-health record. None of it touches the
 * stored Program Contract.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutionNodeId,
  type GateHealth,
  type JobContract,
  JobContractSchema,
  type Prerequisite,
  type ProgramContract,
  type RouteChoice,
} from "@nightshift/contracts";
import { nowIso, type ProjectStores } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createEventOutbox,
  createMergeQueue,
  type Engine,
  type ExecutionEnvironment,
  fingerprintAtCommit,
  gateDefinitions,
  gitBlobReader,
  type MergeQueue,
  type RunSession,
  resumeDeferred,
  revParse,
} from "@nightshift/execution";
import { lockfileHashes, readInstallMarker } from "@nightshift/verification";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness, type ScriptContext } from "./fake-harness.js";
import { cleanupWorlds, createWorld, eventsOf, PROGRAM_BRANCH, type World } from "./world.js";

afterEach(cleanupWorlds);

const ROUTE: RouteChoice = {
  target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
  eligibleOptions: [
    {
      target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
      eligible: true,
    },
  ],
  ruleId: "p15-fixed",
  wasOverride: false,
};

const mcp = () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} });

/** An install step by its command (`isInstallStep`), and quick: npm prints its version. */
const INSTALL = "npm i --version";
/** The gate a repair adds: a command no ratified definition has. */
const REPAIRED_GATE = `node -e "console.log('the repaired gate')"`;
const LOCKFILE = `${JSON.stringify({ name: "slice-fixture", lockfileVersion: 3, packages: {} })}\n`;

type Work = (context: ScriptContext) => Promise<void>;

const write = (worktree: string, path: string, text: string): Promise<void> =>
  writeFile(join(worktree, path), text, "utf8");

const addModule =
  (name: string): Work =>
  async ({ worktree }) => {
    await write(worktree, `src/${name}.js`, `export const ${name} = () => "${name}";\n`);
  };

/** The project's defaults as a repair writes them: the program's gates and one more. */
const configWithRepairedGate = (program: ProgramContract): string =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      projectId: program.projectId,
      contextDocs: [],
      verification: [
        ...program.verification.map(({ id, command }) => ({ id, command })),
        { id: "lint", command: REPAIRED_GATE },
      ],
      modelPolicy: program.modelPolicy,
      delegationLimits: program.delegationLimits,
      costPolicy: program.costPolicy,
    },
    null,
    2,
  )}\n`;

const changeTheGates =
  (world: () => World): Work =>
  async ({ worktree }) => {
    await write(worktree, "nightshift.config.json", configWithRepairedGate(world().program));
    await write(worktree, "package-lock.json", LOCKFILE);
  };

const flakyRepair: Partial<JobContract> = {
  repair: {
    cause: "flaky",
    gates: ["test"],
    decisionId: "dec_01M4REPA1R0000000000000000" as never,
  },
};

const harnessFor = (world: () => World, work: Readonly<Record<string, Work>>) =>
  createFakeHarness({
    script: async (context) => {
      const name = context.input.job.objective.split(" ")[0] ?? "";
      await (work[name] ?? (async () => {}))(context);
      const w = world();
      const outbox = createEventOutbox({
        events: w.stores.events,
        scope: context.identity.scope,
        clock: w.environment.clock,
        ids: w.ids,
        writerId: context.identity.agentId,
        initialDelayMs: 1,
      });
      await completeJob(
        { stores: w.stores, clock: w.environment.clock, git: w.git, outbox },
        context.identity,
        `${name}: done`,
      );
      await outbox.flush();
      return { kind: "completed" };
    },
  });

const PROGRAM: Partial<ProgramContract> = {
  setup: [{ id: "install", command: INSTALL }],
  scope: {
    includes: ["src/**", "test/**", "nightshift.config.json", "package-lock.json"],
    excludes: [],
    permissions: ["fs.read", "fs.write", "shell.exec"],
    forbiddenActions: [],
  },
  delegationLimits: { maxDepth: 2, maxConcurrency: 1 },
};

interface Rig {
  readonly world: World;
  readonly environment: ExecutionEnvironment;
  readonly engine: Engine;
  readonly queue: MergeQueue;
  submit(
    objective: string,
    extra?: Partial<JobContract>,
    engine?: Engine,
  ): Promise<{ jobId: JobContract["jobContractId"]; nodeId: ExecutionNodeId }>;
  until(nodeId: ExecutionNodeId, status: string): Promise<void>;
}

const rig = async (
  work: (world: () => World) => Readonly<Record<string, Work>>,
  options: {
    readonly program?: Partial<ProgramContract>;
    readonly stores?: (stores: ProjectStores) => ProjectStores;
    readonly prerequisites?: () => readonly Prerequisite[];
  } = {},
): Promise<Rig> => {
  let world: World | undefined;
  const made = await createWorld({
    harness: harnessFor(
      () => world as World,
      work(() => world as World),
    ),
    program: { ...PROGRAM, ...options.program },
  });
  world = made;
  const prerequisites = options.prerequisites;
  const environment: ExecutionEnvironment = {
    ...made.environment,
    ...(options.stores === undefined ? {} : { stores: options.stores(made.stores) }),
    ...(prerequisites === undefined
      ? {}
      : {
          prerequisites: {
            prerequisites: async () => prerequisites(),
            recordDiscovered: async () => {
              throw new Error("nothing is discovered here");
            },
          },
        }),
  };
  const queue = createMergeQueue(environment);
  const engine = createEngine({
    environment,
    session: made.session,
    mcp,
    mergeQueue: queue,
    prepareReference: true,
  });
  const submit: Rig["submit"] = async (objective, extra, on = engine) => {
    const job = JobContractSchema.parse({
      schemaVersion: 1,
      ...made.scope,
      jobContractId: made.ids.next("job"),
      objective,
      scope: { includes: PROGRAM.scope?.includes ?? [] },
      acceptance: ["the gates pass"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      ...extra,
      createdAt: nowIso(made.environment.clock),
    });
    const submitted = await on.submit({
      job,
      scope: made.session.program.scope,
      depth: 1,
      parentNodeId: made.session.rootNodeId,
      route: ROUTE,
    });
    return { jobId: job.jobContractId, nodeId: submitted.nodeId };
  };
  return {
    world: made,
    environment,
    engine,
    queue,
    submit,
    until: async (nodeId, status) => {
      const deadline = Date.now() + 45_000;
      for (;;) {
        const now = (await made.stores.executionNodes.get(made.scope, nodeId))?.status;
        if (now === status) return;
        if (now !== undefined && ["failed", "verification_failed", "cancelled"].includes(now)) {
          throw new Error(`node ${nodeId} ended ${now}, not ${status}`);
        }
        if (Date.now() > deadline) throw new Error(`node ${nodeId} is still ${now}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
};

/** Lands a job: integrated, and the merge queue done with everything its landing does. */
const land = async (r: Rig, objective: string, extra?: Partial<JobContract>, engine?: Engine) => {
  const submitted = await r.submit(objective, extra, engine);
  await r.until(submitted.nodeId, "integrated");
  await r.queue.idle();
  await r.world.outbox.flush();
  return submitted;
};

const repairedEvents = async (world: World) =>
  (await eventsOf(world)).filter((event) => event.type === "gate.repaired");

const commandsOf = async (world: World, nodeId: ExecutionNodeId) =>
  ((await world.stores.verifications.listByNode(world.scope, nodeId)).at(-1)?.commands ?? []).map(
    (command) => [command.stepId, command.command],
  );

const gateHealthRecord = (world: World): GateHealth => ({
  schemaVersion: 1,
  projectId: world.program.projectId,
  programId: world.program.programId,
  commit: world.baseCommit,
  fingerprint: "a".repeat(64),
  verdict: "repairing",
  findings: [
    {
      id: "F-01",
      rule: 3,
      found: "the test gate flakes",
      decisionId: "dec_01M4REPA1R0000000000000000",
      paths: ["package.json"],
    },
  ],
  machinery: ["package.json"],
  auditedBy: {
    kind: "user",
    userId: world.subject as never,
    orgId: "org_01M4REPA1R0000000000000000" as never,
  },
  auditedAt: nowIso(world.clock),
});

describe("a repair that changes a gate definition (P15, D-P15-04, SC-P15-07)", () => {
  it("records the change, verifies later work with it, and leaves the Program Contract alone", async () => {
    const r = await rig((world) => ({ repair: changeTheGates(world), alpha: addModule("alpha") }));
    const { world } = r;
    const storedBefore = await world.stores.programContracts.get(
      world.program.projectId,
      world.program.programId,
    );
    const rootBefore = await world.stores.executionNodes.get(world.scope, world.session.rootNodeId);
    await world.stores.gateHealth.put(gateHealthRecord(world));
    // Beside the operator's clone, and none of Nightshift's business.
    await mkdir(`${world.repo}.tmp`, { recursive: true });
    await write(`${world.repo}.tmp`, "keep", "the operator's own\n");

    const repair = await land(r, "repair the flaky test", flakyRepair);
    const repairHead = await revParse(world.git, world.repo, PROGRAM_BRANCH);

    // gate.repaired, on the repair's node, with the new verification only.
    const [repaired, ...more] = await repairedEvents(world);
    expect(more).toEqual([]);
    expect(repaired?.executionNodeId).toBe(repair.nodeId);
    const newVerification = [...world.program.verification, { id: "lint", command: REPAIRED_GATE }];
    expect(repaired?.payload).toEqual({
      jobContractId: repair.jobId,
      decisionId: flakyRepair.repair?.decisionId,
      cause: "flaky",
      definitionsChanged: true,
      verification: newVerification,
    });

    // A decision names the repair's own and says what the gates were and are.
    const decisions = (await world.stores.decisions.listByRun(world.scope)).items;
    expect(decisions).toHaveLength(1);
    const [decision] = decisions;
    expect(decision?.executionNodeId).toBe(repair.nodeId);
    expect(decision?.authority).toBe("agent");
    expect(decision?.context).toContain(flakyRepair.repair?.decisionId);
    expect(decision?.choice).toContain("test: node --test; shape:");
    expect(decision?.choice).toContain(`lint: ${REPAIRED_GATE}`);

    // The next job is verified with the new gate.
    const alpha = await land(r, "alpha module");
    expect(await commandsOf(world, alpha.nodeId)).toContainEqual(["lint", REPAIRED_GATE]);
    expect(await commandsOf(world, repair.nodeId)).not.toContainEqual(["lint", REPAIRED_GATE]);

    // A run decision, not a re-ratification: the stored contract is as it was.
    expect(
      await world.stores.programContracts.get(world.program.projectId, world.program.programId),
    ).toEqual(storedBefore);
    expect(
      (await world.stores.executionNodes.get(world.scope, world.session.rootNodeId))?.plan,
    ).toEqual(rootBefore?.plan);

    // The program checkout is the setup reference: at the start, and after the repair.
    const progress = (await eventsOf(world)).filter(
      (event) => event.type === "node.progress" && "setupReference" in event.payload,
    );
    expect(progress.map((event) => event.executionNodeId)).toEqual([
      world.session.rootNodeId,
      repair.nodeId,
    ]);
    expect(await readFile(join(`${world.repo}.tmp`, "keep"), "utf8")).toBe("the operator's own\n");
    const marker = await readInstallMarker(world.repo);
    expect(marker).toEqual(await lockfileHashes(world.repo));
    expect(Object.keys(marker ?? {})).toEqual(["package-lock.json"]);

    // The gate-health record stands at the head the repair made, fingerprinted
    // there; a later landing that is not a repair leaves it be.
    const head = repairHead;
    const record = await world.stores.gateHealth.get(world.program.projectId);
    expect(record?.commit).toBe(head);
    expect(record?.fingerprint).toBe(
      await fingerprintAtCommit(
        gitBlobReader(world.repo),
        head,
        { setup: [{ id: "install", command: INSTALL }], verification: newVerification },
        ["package.json"],
      ),
    );
    expect(record?.verdict).toBe("repairing");
    expect(record?.findings).toEqual(gateHealthRecord(world).findings);

    // An engine attaching later reads the same definitions from the records.
    await r.engine.close("test over");
    world.settle();
    const fresh: ExecutionEnvironment = { ...r.environment, stores: { ...world.stores } };
    expect((await gateDefinitions(fresh, world.session)).verification).toEqual(newVerification);
    const attached = createEngine({
      environment: fresh,
      session: { ...world.session } as RunSession,
      mcp,
      mergeQueue: r.queue,
    });
    const beta = await land(r, "beta module", undefined, attached);
    expect(await commandsOf(world, beta.nodeId)).toContainEqual(["lint", REPAIRED_GATE]);
    await attached.close("test over");
    // Still one event and one decision: the attach reconciled, and found nothing to add.
    expect(await repairedEvents(world)).toHaveLength(1);
    expect((await world.stores.decisions.listByRun(world.scope)).items).toHaveLength(1);
  }, 120_000);

  it("records a repair that left the gates as they were, and no decision", async () => {
    const r = await rig(() => ({ repair: addModule("steadier") }));
    const repair = await land(r, "repair the flaky test", flakyRepair);
    const [repaired] = await repairedEvents(r.world);
    expect(repaired?.payload).toEqual({
      jobContractId: repair.jobId,
      decisionId: flakyRepair.repair?.decisionId,
      cause: "flaky",
      definitionsChanged: false,
    });
    expect((await r.world.stores.decisions.listByRun(r.world.scope)).items).toEqual([]);
    expect((await gateDefinitions(r.environment, r.world.session)).verification).toEqual(
      r.world.program.verification,
    );
    await r.engine.close("test over");
  }, 120_000);

  it("rewrites the gate-health record on a later reconciliation when the first put failed", async () => {
    let refused = 0;
    const r = await rig((world) => ({ repair: changeTheGates(world) }), {
      stores: (stores) => ({
        ...stores,
        gateHealth: {
          get: (projectId) => stores.gateHealth.get(projectId),
          put: async () => {
            refused += 1;
            throw new Error("the control plane is unreachable");
          },
        },
      }),
    });
    const { world } = r;
    await world.stores.gateHealth.put(gateHealthRecord(world));
    await land(r, "repair the flaky test", flakyRepair);
    expect(refused).toBe(1);
    expect((await world.stores.gateHealth.get(world.program.projectId))?.commit).toBe(
      world.baseCommit,
    );
    await r.engine.close("test over");

    // The event is on the record already; the record is still behind, and an
    // engine attaching with a working store brings it up to date.
    world.settle();
    const attached = createEngine({
      environment: { ...world.environment, stores: { ...world.stores } },
      session: world.session,
      mcp,
    });
    await attached.settled();
    const head = await revParse(world.git, world.repo, PROGRAM_BRANCH);
    expect((await world.stores.gateHealth.get(world.program.projectId))?.commit).toBe(head);
    expect(await repairedEvents(world)).toHaveLength(1);
    await attached.close("test over");
  }, 120_000);

  it.each([
    ["the gate.repaired event", "event"],
    ["the decision", "decision"],
  ] as const)(
    "holds the gate-health record back when %s could not be written, then writes both",
    async (_what, lost) => {
      let refused = 0;
      let healthWrites = 0;
      const unreachable = () => {
        refused += 1;
        throw new Error("the control plane is unreachable");
      };
      const r = await rig((world) => ({ repair: changeTheGates(world) }), {
        stores: (stores) => ({
          ...stores,
          events: {
            ...stores.events,
            append: async (event) =>
              lost === "event" && event.type === "gate.repaired"
                ? unreachable()
                : stores.events.append(event),
          },
          decisions: {
            ...stores.decisions,
            put: async (decision) =>
              lost === "decision" ? unreachable() : stores.decisions.put(decision),
          },
          gateHealth: {
            get: (projectId) => stores.gateHealth.get(projectId),
            put: async (record) => {
              healthWrites += 1;
              return stores.gateHealth.put(record);
            },
          },
        }),
      });
      const { world } = r;
      await world.stores.gateHealth.put(gateHealthRecord(world));
      await land(r, "repair the flaky test", flakyRepair);
      expect(refused).toBe(1);
      expect(await repairedEvents(world)).toEqual([]);
      // Not fingerprinted over the definitions the lost write left stale.
      expect(healthWrites).toBe(0);
      expect((await world.stores.gateHealth.get(world.program.projectId))?.commit).toBe(
        world.baseCommit,
      );
      await r.engine.close("test over");

      // An engine attaching with working stores records the repair, then the record.
      world.settle();
      const attached = createEngine({
        environment: { ...world.environment, stores: { ...world.stores } },
        session: world.session,
        mcp,
      });
      await attached.settled();
      const newVerification = [
        ...world.program.verification,
        { id: "lint", command: REPAIRED_GATE },
      ];
      const [repaired, ...more] = await repairedEvents(world);
      expect(more).toEqual([]);
      expect(repaired?.payload).toMatchObject({
        definitionsChanged: true,
        verification: newVerification,
      });
      expect((await world.stores.decisions.listByRun(world.scope)).items).toHaveLength(1);
      const head = await revParse(world.git, world.repo, PROGRAM_BRANCH);
      const record = await world.stores.gateHealth.get(world.program.projectId);
      expect(record?.commit).toBe(head);
      expect(record?.fingerprint).toBe(
        await fingerprintAtCommit(
          gitBlobReader(world.repo),
          head,
          { setup: [{ id: "install", command: INSTALL }], verification: newVerification },
          ["package.json"],
        ),
      );
      await attached.close("test over");
    },
    120_000,
  );
});

describe("a repair that lands through `nightshift resume` (P15, D-P15-11)", () => {
  it("records the change, prepares the setup reference and rewrites the gate-health record", async () => {
    let met = false;
    const hp01 = (): Prerequisite => ({
      id: "HP-01",
      description: "The deploy credential is in place.",
      remediation: "Ask the owner.",
      verifyCommand: "true",
      status: met ? "satisfied" : "pending",
      ...(met ? { lastCheck: { exitCode: 0, checkedAt: "2026-09-21T00:00:00.000Z" } } : {}),
    });
    const r = await rig((world) => ({ repair: changeTheGates(world) }), {
      program: {
        verification: [
          { id: "test", command: "node --test" },
          { id: "gate", command: `node -e "process.exit(0)"`, requires: ["HP-01"] },
        ],
        prerequisites: [hp01()],
      },
      prerequisites: () => [hp01()],
    });
    const { world } = r;
    await world.stores.gateHealth.put(gateHealthRecord(world));
    const repair = await r.submit("repair the flaky test", flakyRepair);
    await r.until(repair.nodeId, "deferred");
    await r.engine.close("test over");
    expect(await repairedEvents(world)).toEqual([]);

    met = true;
    world.settle();
    // As `nightshift resume` holds the run: no orchestrator of its own.
    const result = await resumeDeferred(
      { ...world.environment, stores: { ...world.stores } },
      { scope: world.scope, program: world.session.program, repoPath: world.repo },
    );
    expect(result.landed).toEqual([repair.nodeId]);
    await world.outbox.flush();

    const [repaired] = await repairedEvents(world);
    expect(repaired?.payload).toMatchObject({
      jobContractId: repair.jobId,
      definitionsChanged: true,
    });
    const reference = (await eventsOf(world)).filter(
      (event) =>
        event.type === "node.progress" &&
        "setupReference" in event.payload &&
        event.executionNodeId === repair.nodeId,
    );
    expect(reference).toHaveLength(1);
    expect(await readInstallMarker(world.repo)).toEqual(await lockfileHashes(world.repo));
    const head = await revParse(world.git, world.repo, PROGRAM_BRANCH);
    expect((await world.stores.gateHealth.get(world.program.projectId))?.commit).toBe(head);
  }, 120_000);
});
