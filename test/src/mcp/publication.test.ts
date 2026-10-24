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
import type { ProgramContract } from "@nightshift/contracts";
import { git, type Landing, nodeGitRunner } from "@nightshift/execution";
import { createNightshiftServer } from "@nightshift/mcp";
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

const start = async (world: BaseWorld, landings: Landing[] | undefined) => {
  const planning = createHttpPlanning({
    transport: createFetchTransport({
      endpoint: world.plane.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    }),
  });
  const server = await createNightshiftServer({
    env: {
      NIGHTSHIFT_API_ENDPOINT: world.plane.url,
      NIGHTSHIFT_API_TOKEN: "ignored-by-the-local-plane",
      NIGHTSHIFT_STATE_DIR: world.stateDir,
    },
    cwd: world.repo,
    runtime: {
      // On a machine the run waits for the publisher; here it has nothing outstanding.
      stores:
        landings === undefined
          ? world.stores
          : {
              ...world.stores,
              dispatches: {
                ...world.stores.dispatches,
                get: async () =>
                  ({
                    attempts: [],
                    publication: { intents: [] },
                    cleanup: { volumeDeleted: false, failures: [] },
                    requestedAt: "2026-10-23T00:00:00.000Z",
                    tier: "better",
                    usdPerHour: 0.9,
                    spend: { estimatedUsd: 1, ceilingSeconds: 3600 },
                  }) as never,
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
      ...(landings === undefined
        ? {}
        : {
            publication: () => ({
              landing: async (landing: Landing) => {
                landings.push(landing);
              },
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
    },
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
    const landings: Landing[] = [];
    const mcp = await start(world, landings);
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

    expect(landings.at(-1)).toMatchObject({ head: after, programBranch: PROGRAM_BRANCH });
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
