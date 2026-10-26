/**
 * What run.finish publishes of a planned run, and where run.start and run.attach
 * find a plan (P21 S-02, D-03): the plane's documents, committed onto the program
 * branch as history, and no docs/programs directory needed in the checkout.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Dispatch, ProgramContract } from "@nightshift/contracts";
import { createFixtures, makeDispatch } from "@nightshift/core";
import {
  createPublicationQueue,
  git,
  type Landing,
  nodeGitRunner,
  type PublishLanding,
} from "@nightshift/execution";
import {
  createNightshiftServer,
  publishPlannedRun,
  type Runtime,
  runResume,
} from "@nightshift/mcp";
import {
  createFetchTransport,
  createHttpPlanning,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness } from "../execution/fake-harness.js";
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
const NAME = "p1-modules";
const PLAN = [
  "# Modules",
  "",
  "## Strands",
  "",
  "### S-01 The modules",
  "",
  "One module and its test.",
  "",
  "#### Considered and rejected",
  "",
  "Two modules.",
  "",
].join("\n");
const CONVERSATION = "Owner: one module.\nPlanner: agreed.\n";

const run = (world: BaseWorld, args: readonly string[]) =>
  git(nodeGitRunner, args, { cwd: world.repo });

/** A planned program, ratified on the plane, its draft named; the checkout holds no docs/programs. */
const plannedWorld = async (named: boolean) => {
  const world = await createBaseWorld();
  const contract: ProgramContract = {
    ...world.program,
    status: "planning",
    stories: [
      {
        id: "US-01",
        who: "a maintainer",
        problem: "the module does not exist",
        outcome: "the module exists and its test passes",
      },
    ],
    successCriteria: world.program.successCriteria.map((criterion) => ({
      ...criterion,
      serves: ["US-01"],
    })),
    strands: [
      {
        id: "S-01",
        name: "The modules",
        scope: { summary: "one module", includes: ["src/**"], excludes: [] },
        acceptance: ["it exists"],
        successCriteria: world.program.successCriteria.map((criterion) => criterion.id),
        dependsOn: [],
        prerequisites: [],
      },
    ],
  };
  const transport = createFetchTransport({
    endpoint: world.plane.url,
    tokens: staticTokenProvider("ignored-by-the-local-plane"),
  });
  const planning = createHttpPlanning({ transport });
  const ratified = await planning.ratify(contract, PLAN, CONVERSATION);
  await planning.putVersion(
    { projectId: contract.projectId, programId: contract.programId },
    {
      contract: `${JSON.stringify(ratified, null, 2)}\n`,
      planText: PLAN,
      conversationText: CONVERSATION,
    },
    null,
    named ? NAME : undefined,
  );
  // The authored contract file is all the checkout holds of the program.
  await writeFile(join(world.repo, CONTRACT_FILE), `${JSON.stringify(contract, null, 2)}\n`);
  await run(world, ["add", "-A"]);
  await run(world, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    "contract",
  ]);
  return { world, contract, ratified, planning };
};

/** A machine's plane and publisher, faked: the real queue over an upload and a request that can fail. */
interface Machine {
  readonly dispatch: () => Dispatch;
  readonly landing: PublishLanding;
  readonly uploads: () => number;
  readonly requests: () => number;
  /** The heads the fake origin ended up with, in order. */
  readonly origin: string[];
  /** Faults still to happen; a test may clear them to let a retry through. */
  readonly faults: { uploadFailures: number; requestFailures: number; refuse: boolean };
}

const machineOf = async (
  world: BaseWorld,
  faults: { uploadFailures?: number; requestFailures?: number; refuse?: boolean },
): Promise<Machine> => {
  const base = (await run(world, ["rev-parse", PROGRAM_BRANCH])).trim();
  const fixtures = createFixtures();
  let dispatch = {
    ...makeDispatch(fixtures, { status: "running" }),
    input: { ...makeDispatch(fixtures, { status: "running" }).input, baseSha: base },
    publication: { intents: [] },
  } as unknown as Dispatch;
  const origin: string[] = [];
  let uploads = 0;
  let requests = 0;
  const live = {
    uploadFailures: faults.uploadFailures ?? 0,
    requestFailures: faults.requestFailures ?? 0,
    refuse: faults.refuse ?? false,
  };
  const landing = createPublicationQueue({
    predecessor: async () =>
      (dispatch.publication.intents.at(-1)?.head ?? dispatch.publication.head ?? base) as never,
    packDir: join(world.stateDir, "packs"),
    upload: async (_pack, head) => {
      uploads += 1;
      if (live.uploadFailures > 0) {
        live.uploadFailures -= 1;
        throw new Error("upload failed");
      }
      return { key: `bundle/${head}` };
    },
    request: async (body) => {
      requests += 1;
      if (live.requestFailures > 0) {
        live.requestFailures -= 1;
        throw new Error("request failed");
      }
      const refused = live.refuse;
      dispatch = {
        ...dispatch,
        publication: {
          ...(refused ? { blocked: "the push was refused" } : { head: body.head }),
          intents: [
            ...dispatch.publication.intents,
            {
              ...body,
              status: refused ? "protected" : "published",
              requestedAt: "2026-10-23T00:00:00.000Z",
            },
          ],
        },
      } as unknown as Dispatch;
      if (!refused) origin.push(body.head);
    },
    log: () => {},
  });
  return {
    dispatch: () => dispatch,
    landing,
    uploads: () => uploads,
    requests: () => requests,
    origin,
    faults: live,
  };
};

const runtimeOf = (
  world: BaseWorld,
  landings: Landing[] | undefined,
  machine?: Machine,
): Runtime => {
  const planning = createHttpPlanning({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    }),
  });
  return {
    // On a machine the run waits for the publisher; here it has nothing outstanding.
    stores:
      landings === undefined && machine === undefined
        ? world.stores
        : {
            ...world.stores,
            dispatches: {
              ...world.stores.dispatches,
              get: async () =>
                machine?.dispatch() ??
                ({
                  attempts: [],
                  publication: { intents: [] },
                  cleanup: { volumeDeleted: false, failures: [] },
                  requestedAt: "2026-10-23T00:00:00.000Z",
                  tier: "better",
                  usdPerHour: 0.9,
                  spend: { estimatedUsd: 1, ceilingSeconds: 3600 },
                } as never),
            },
          },
    bodies: world.bodies,
    tokens: world.tokens,
    harness: createFakeHarness({ script: async () => ({ kind: "completed" }) }),
    paths: localPathsIn(world.stateDir),
    git: nodeGitRunner,
    transport: (async () => ({ status: 500, body: undefined })) as never,
    ids: world.ids,
    clock: world.clock,
    endpoint: world.plane.url,
    planText: async (scope, sha256) => (await planning.planDocument(scope, sha256))?.text,
    ...(landings === undefined && machine === undefined
      ? {}
      : {
          publication: () => ({
            landing:
              machine?.landing ??
              (async (landing: Landing) => {
                landings?.push(landing);
              }),
            strand: async () => {},
          }),
        }),
    workerEnvironment: workerEnvironmentIn(world),
    workerLaunch: () => ({
      name: "nightshift",
      command: process.execPath,
      args: ["--version"],
      env: {},
    }),
  };
};

const start = async (world: BaseWorld, landings: Landing[] | undefined, machine?: Machine) => {
  const server = await createNightshiftServer({
    env: {
      NIGHTSHIFT_API_ENDPOINT: world.plane.url,
      NIGHTSHIFT_API_TOKEN: "ignored-by-the-local-plane",
      NIGHTSHIFT_STATE_DIR: world.stateDir,
    },
    cwd: world.repo,
    runtime: runtimeOf(world, landings, machine),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.273" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      ((await client.callTool({ name, arguments: args })) as CallToolResult)
        .structuredContent as Record<string, unknown> & { ok: boolean },
    stop: async () => {
      await client.close();
      await server.stop("the test finished");
    },
  };
};

const show = (world: BaseWorld, spec: string) => run(world, ["show", spec]);

describe("run.start and run.attach with no docs/programs in the checkout", () => {
  it("start reads the plan from the plane, and a second session attaches to find the program there", async () => {
    const { world } = await plannedWorld(true);
    await rm(join(world.repo, "docs", "programs"), { recursive: true, force: true });
    const first = await start(world, undefined);
    const started = await first.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    await first.stop();

    // No contract file is consulted: the plane's plan draft names the program.
    await rm(join(world.repo, CONTRACT_FILE), { force: true });
    await run(world, ["add", "-A"]);
    await run(world, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "no contract",
    ]);
    await writeFile(
      join(world.repo, "nightshift.config.json"),
      `${JSON.stringify({ projectId: world.program.projectId })}\n`,
    );
    await run(world, ["add", "-A"]);
    await run(world, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "config",
    ]);
    const second = await start(world, undefined);
    const attached = await second.call("run.attach", { model: MODEL, runId: started.runId });
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    await second.stop();
  });
});

describe("run.start resolves a planned program from the plane", () => {
  it("starts by program name with no docs/programs and no contract file", async () => {
    const { world, contract } = await plannedWorld(true);
    await rm(join(world.repo, "docs", "programs"), { recursive: true, force: true });
    await rm(join(world.repo, CONTRACT_FILE), { force: true });
    await writeFile(
      join(world.repo, "nightshift.config.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: contract.projectId,
        contextDocs: [],
        verification: contract.verification,
        modelPolicy: contract.modelPolicy,
        delegationLimits: contract.delegationLimits,
        costPolicy: contract.costPolicy,
      })}\n`,
    );
    const mcp = await start(world, undefined);
    const started = await mcp.call("run.start", {
      program: NAME,
      model: MODEL,
      repoPath: world.repo,
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    expect(started.programId).toBe(contract.programId);
    const refused = await mcp.call("run.start", {
      program: "p9-none",
      model: MODEL,
      repoPath: world.repo,
    });
    expect(refused.ok).toBe(false);
    const both = await mcp.call("run.start", {
      program: NAME,
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    expect(both.ok).toBe(false);
    await mcp.stop();
  });

  it("ignores a stale planned contract file in favour of the plane's ratified contract", async () => {
    const { world, contract } = await plannedWorld(true);
    await writeFile(
      join(world.repo, CONTRACT_FILE),
      `${JSON.stringify({ ...contract, objective: "stale file" }, null, 2)}\n`,
    );
    const mcp = await start(world, undefined);
    const started = await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const recorded = await world.stores.programContracts.get(
      contract.projectId,
      contract.programId,
    );
    expect(recorded?.planDocument).toBeDefined();
    expect(recorded?.objective).toBe(contract.objective);
    expect(contract.objective).not.toBe("stale file");
    await mcp.stop();
  });
});

describe("run.finish of a planned run publishes its documents (D-03)", () => {
  it("leaves one commit holding exactly the four files, and raises a publication intent on a machine", async () => {
    const { world, ratified } = await plannedWorld(true);
    const machine = await machineOf(world, {});
    const mcp = await start(world, undefined, machine);
    const started = await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const before = (await run(world, ["rev-parse", PROGRAM_BRANCH])).trim();

    const finished = await mcp.call("run.finish", {
      outcome: "failed",
      reason: "stopped by the test",
    });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    await mcp.stop();

    expect(finished.publicationFailure, JSON.stringify(finished)).toBeUndefined();
    const after = (await run(world, ["rev-parse", PROGRAM_BRANCH])).trim();
    expect((await run(world, ["rev-list", `${before}..${after}`])).trim().split("\n")).toHaveLength(
      1,
    );
    const files = (await run(world, ["diff", "--name-only", before, after]))
      .trim()
      .split("\n")
      .sort();
    expect(files).toEqual(
      ["contract.json", "conversation.md", "plan.md", "report.md"].map(
        (f) => `docs/programs/${NAME}/${f}`,
      ),
    );
    const author = (await run(world, ["log", "-1", "--format=%an", after])).trim();
    expect(author).toBe("Nightshift");
    const at = (file: string) => show(world, `${after}:docs/programs/${NAME}/${file}`);
    expect(JSON.parse(await at("contract.json"))).toEqual(ratified);
    expect(await at("plan.md")).toBe(PLAN);
    expect(await at("conversation.md")).toBe(CONVERSATION);
    expect(await at("report.md")).toContain("stopped by the test");
    // Nothing is left untracked in the checkout.
    expect((await run(world, ["status", "--porcelain"])).trim()).toBe("");

    expect(machine.origin).toEqual([after]);
    expect(machine.dispatch().publication.intents.map((i) => i.head)).toEqual([after]);
  });

  it("publishes nothing for a draft with no name", async () => {
    const { world } = await plannedWorld(false);
    const mcp = await start(world, undefined);
    await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    const before = (await run(world, ["rev-parse", PROGRAM_BRANCH])).trim();
    const finished = await mcp.call("run.finish", {
      outcome: "failed",
      reason: "stopped by the test",
    });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    await mcp.stop();
    expect((await run(world, ["rev-parse", PROGRAM_BRANCH])).trim()).toBe(before);
  });

  it("commits locally and raises no intent when this is no machine", async () => {
    const { world } = await plannedWorld(true);
    const mcp = await start(world, undefined);
    await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    const before = (await run(world, ["rev-parse", PROGRAM_BRANCH])).trim();
    const finished = await mcp.call("run.finish", {
      outcome: "failed",
      reason: "stopped by the test",
    });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    await mcp.stop();
    expect((await run(world, ["rev-parse", PROGRAM_BRANCH])).trim()).not.toBe(before);
  });
});

describe("run.finish settles the documentation head like a landing (F-01)", () => {
  type Faults = Parameters<typeof machineOf>[1];

  /** A planned run whose strand is carried, so it may end `succeeded`, finished on a faked machine. */
  const finishOnMachine = async (faults: Faults, outcome: "succeeded" | "failed" = "succeeded") => {
    const { world } = await plannedWorld(true);
    const machine = await machineOf(world, faults);
    const first = await start(world, undefined, machine);
    const started = await first.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    await first.stop();
    const scope = {
      projectId: world.program.projectId,
      programId: world.program.programId,
      runId: started.runId as never,
    };
    const recorded = await world.backing.runs.get(scope, scope.runId);
    if (recorded === undefined) throw new Error("the started run is not recorded");
    // Running again, as a run is: the stopped session's ending is not kept.
    const { endedAt: _endedAt, outcomeReason: _reason, ...live } = recorded;
    await world.backing.runs.put({
      ...live,
      status: "running",
      carriedStrands: [
        {
          strandId: "S-01" as never,
          fromRunId: "run_01M5N7AQ77S182QK7FWSBHJNKA" as never,
          landed: [],
        },
      ],
    });
    // A session that attaches now finds the strand carried, so the run may succeed.
    const mcp = await start(world, undefined, machine);
    const attached = await mcp.call("run.attach", { model: MODEL, runId: started.runId });
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    const before = (await run(world, ["rev-parse", PROGRAM_BRANCH])).trim();
    const finished = await mcp.call("run.finish", { outcome, reason: "by the test" });
    await mcp.stop();
    const head = (await run(world, ["rev-parse", PROGRAM_BRANCH])).trim();
    const ended = await world.stores.runs.get(scope, scope.runId);
    return { world, machine, finished, before, head, ended, scope };
  };

  it("ends succeeded with one four-file commit, published, and a report that states the ending", async () => {
    const { world, machine, finished, before, head, ended } = await finishOnMachine({});
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    expect(finished.outcome).toBe("succeeded");
    expect(ended?.status).toBe("succeeded");
    expect((await run(world, ["rev-list", `${before}..${head}`])).trim().split("\n")).toHaveLength(
      1,
    );
    expect(
      (await run(world, ["diff", "--name-only", before, head])).trim().split("\n").sort(),
    ).toEqual(
      ["contract.json", "conversation.md", "plan.md", "report.md"].map(
        (f) => `docs/programs/${NAME}/${f}`,
      ),
    );
    // The docs head is what the fake origin has, and the dispatch records it.
    expect(machine.origin).toEqual([head]);
    expect(machine.dispatch().publication.head).toBe(head);
    expect(finished.published).toMatchObject({ head });
    const published = await show(world, `${head}:docs/programs/${NAME}/report.md`);
    expect(published).toContain("**succeeded**");
    // Measured to the ending it states, which the run record keeps too (2026-10-26).
    expect(published).not.toContain("Wall clock not ended");
    expect(published).toMatch(/Wall clock \d/);
  });

  it("ends succeeded when the first upload of the docs head fails and republishing succeeds", async () => {
    const { machine, finished, head, ended } = await finishOnMachine({ uploadFailures: 1 });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    expect(finished.outcome).toBe("succeeded");
    expect(ended?.status).toBe("succeeded");
    expect(machine.uploads()).toBe(2);
    expect(machine.origin).toEqual([head]);
    expect(machine.dispatch().publication.intents.map((i) => i.status)).toEqual(["published"]);
    expect(finished.published).toMatchObject({ head });
    expect(finished.publicationFailure).toBeUndefined();
  });

  it("ends succeeded when the first request fails and republishing succeeds", async () => {
    const { machine, finished, head } = await finishOnMachine({ requestFailures: 1 });
    expect(finished.outcome).toBe("succeeded");
    expect(machine.origin).toEqual([head]);
    expect(machine.dispatch().publication.head).toBe(head);
  });

  it("ends deferred with the unpublished reason when the upload keeps failing, and reports no publication", async () => {
    const { world, machine, finished, head, ended } = await finishOnMachine({
      uploadFailures: 100,
    });
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    expect(finished.outcome).toBe("deferred");
    expect(ended?.status).toBe("interrupted");
    expect(ended?.outcomeReason).toContain("final documentation commit");
    expect(machine.dispatch().publication.intents).toEqual([]);
    expect(machine.origin).toEqual([]);
    expect(finished.published).toBeUndefined();
    expect(finished.publicationFailure).toBeDefined();
    // The checkout's report is true about the ending the run was given.
    expect(await show(world, `${head}:docs/programs/${NAME}/report.md`)).toContain(
      "**interrupted**",
    );
  });

  it("ends deferred when the request keeps failing", async () => {
    const { machine, finished, ended } = await finishOnMachine({ requestFailures: 100 });
    expect(finished.outcome).toBe("deferred");
    expect(ended?.outcomeReason).toContain("final documentation commit");
    expect(machine.dispatch().publication.intents).toEqual([]);
    expect(finished.published).toBeUndefined();
    expect(finished.publicationFailure).toBeDefined();
  });

  it("ends deferred when the publisher refuses the docs head's push", async () => {
    const { machine, finished, ended } = await finishOnMachine({ refuse: true });
    expect(finished.outcome).toBe("deferred");
    expect(ended?.status).toBe("interrupted");
    expect(ended?.outcomeReason).toContain("could not be published");
    expect(machine.dispatch().publication.intents.map((i) => i.status)).toEqual(["protected"]);
    expect(machine.origin).toEqual([]);
    expect(finished.published).toBeUndefined();
    expect(finished.publicationFailure).toBeDefined();
  });

  it("publishPlannedRun reports failure, not published, when its intent was not recorded", async () => {
    const { world } = await plannedWorld(true);
    const machine = await machineOf(world, { uploadFailures: 100 });
    const mcp = await start(world, undefined, machine);
    const started = await mcp.call("run.start", {
      programContractPath: CONTRACT_FILE,
      model: MODEL,
      repoPath: world.repo,
    });
    await mcp.stop();
    const scope = {
      projectId: world.program.projectId,
      programId: world.program.programId,
      runId: started.runId as never,
    };
    const result = await publishPlannedRun(runtimeOf(world, undefined, machine), {
      scope,
      program: world.program,
      repoPath: world.repo,
      name: NAME,
      rootNodeId: (await world.backing.runs.get(scope, scope.runId))?.rootNodeId as never,
      publish: machine.landing,
    });
    const head = (await run(world, ["rev-parse", PROGRAM_BRANCH])).trim();
    expect(result.published).toBeUndefined();
    expect(result.failure).toContain("was not requested");
    expect(result.committed?.head).toBe(head);
    expect(machine.dispatch().publication.intents).toEqual([]);
  });

  describe("nightshift resume", () => {
    it("has nothing to push locally", async () => {
      const { world } = await plannedWorld(true);
      const mcp = await start(world, undefined);
      const started = await mcp.call("run.start", {
        programContractPath: CONTRACT_FILE,
        model: MODEL,
        repoPath: world.repo,
      });
      await mcp.stop();
      const outcome = await runResume(runtimeOf(world, undefined), {
        scope: {
          projectId: world.program.projectId,
          programId: world.program.programId,
          runId: started.runId as never,
        },
        repoPath: world.repo,
      });
      expect(outcome.publicationFailure).toBeUndefined();
    });
  });
});
