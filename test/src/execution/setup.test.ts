/**
 * Setup: every checkout Nightshift creates is prepared before anything runs in
 * it, because a new worktree holds only what is committed. The fixture's
 * `node_modules/` is ignored, exactly like a real repository's.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobContract, RouteChoice } from "@nightshift/contracts";
import { JobContractSchema } from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import {
  completeJob,
  createEventOutbox,
  runJob,
  type StartedJob,
  type WorkerEnvironment,
  type WorkerIdentity,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness } from "./fake-harness.js";
import { cleanupWorlds, createWorld, eventsOf, type World } from "./world.js";

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

/** An "install": writes an ignored file that the checks below need. */
const INSTALL = `node -e "require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/ready','ok')"`;
const NEEDS_INSTALL = `node -e "process.exit(require('fs').existsSync('node_modules/ready') ? 0 : 1)"`;

const jobFor = (world: World): JobContract =>
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

describe("setup", () => {
  it("prepares the worktree before the worker starts, and again before verification", async () => {
    let preparedForWorker = false;
    const world = await createWorld({
      program: {
        setup: [{ id: "install", command: INSTALL }],
        verification: [
          { id: "test", command: "node --test" },
          { id: "installed", command: NEEDS_INSTALL },
        ],
      },
      harness: createFakeHarness({
        script: async (context) => {
          preparedForWorker = existsSync(join(context.worktree, "node_modules", "ready"));
          // Whatever the worker leaves, verification must not depend on it.
          await rm(join(context.worktree, "node_modules"), { recursive: true, force: true });
          const worker = workerEnvironment(world, context.identity);
          await completeJob(worker, context.identity, "Nothing to change.");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    expect(preparedForWorker).toBe(true);
    const [verification] = await world.stores.verifications.listByNode(world.scope, started.nodeId);
    expect(verification?.outcome).toBe("passed");
    expect(verification?.commands.map((command) => command.stepId)).toEqual([
      "setup:install",
      "test",
      "installed",
    ]);
  });

  it("fails verification on a failed setup, without running the checks, and says so", async () => {
    let workerRan = false;
    const world = await createWorld({
      program: { setup: [{ id: "install", command: 'node -e "process.exit(3)"' }] },
      harness: createFakeHarness({
        script: async (context) => {
          workerRan = true;
          const worker = workerEnvironment(world, context.identity);
          await completeJob(worker, context.identity, "Nothing to change.");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    // Preparation is not a verdict: the worker still starts, and can repair it.
    expect(workerRan).toBe(true);
    const progress = (await eventsOf(world)).filter((event) => event.type === "node.progress");
    expect(String(progress[0]?.payload.message)).toContain("setup failed before the worker");

    const node = await world.stores.executionNodes.get(world.scope, started.nodeId);
    expect(node?.status).toBe("verification_failed");
    expect(node?.outcomeReason).toContain("setup:install exited 3");
    const [verification] = await world.stores.verifications.listByNode(world.scope, started.nodeId);
    expect(verification?.commands.map((command) => command.stepId)).toEqual(["setup:install"]);
  });

  it("does not count what the worker installed itself: no setup, no installed tree", async () => {
    // A repository that needs an install and declares no setup. The worker
    // installs in its own worktree, as any agent would; the commit does not
    // say how. A fresh clone of it fails, so verification must too.
    const world = await createWorld({
      program: { verification: [{ id: "installed", command: NEEDS_INSTALL }] },
      harness: createFakeHarness({
        script: async (context) => {
          await mkdir(join(context.worktree, "node_modules"), { recursive: true });
          await writeFile(join(context.worktree, "node_modules", "ready"), "ok", "utf8");
          const worker = workerEnvironment(world, context.identity);
          await completeJob(worker, context.identity, "Nothing to change.");
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
    expect(node?.outcomeReason).toContain("installed exited 1");
  });

  it("does not let a stale ignored file the worker left fail a commit that is sound", async () => {
    // The keki-backend case (2026-10-06): build output from another mode, left
    // in the worktree, broke a build that passed in every fresh checkout.
    const NOT_STALE = `node -e "process.exit(require('fs').existsSync('node_modules/stale') ? 1 : 0)"`;
    const world = await createWorld({
      program: {
        setup: [{ id: "install", command: INSTALL }],
        verification: [
          { id: "installed", command: NEEDS_INSTALL },
          { id: "not-stale", command: NOT_STALE },
        ],
      },
      harness: createFakeHarness({
        script: async (context) => {
          await writeFile(join(context.worktree, "node_modules", "stale"), "other mode", "utf8");
          const worker = workerEnvironment(world, context.identity);
          await completeJob(worker, context.identity, "Nothing to change.");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    const [verification] = await world.stores.verifications.listByNode(world.scope, started.nodeId);
    expect(verification?.outcome).toBe("passed");
  });
  it("gives the agent a temp directory of its own, and verification a fresh one that goes", async () => {
    let agentTmp: string | undefined;
    let worktree = "";
    // Passes only with its own temp directory, outside the checkout, and leaves a
    // folder there the way aws-cdk-lib's tests did.
    const OWN_TMP = `node -e "const os=require('os'),p=require('path'),fs=require('fs');const t=os.tmpdir();if(!/^[0-9a-f]{12}$/.test(p.basename(t))||t.startsWith(process.cwd()))process.exit(1);fs.mkdirSync(p.join(t,'cdk.out1'),{recursive:true})"`;
    const world = await createWorld({
      program: { verification: [{ id: "own-tmp", command: OWN_TMP }] },
      harness: createFakeHarness({
        script: async (context) => {
          worktree = context.worktree;
          agentTmp = context.input.tmpDir;
          expect(agentTmp !== undefined && existsSync(agentTmp)).toBe(true);
          const worker = workerEnvironment(world, context.identity);
          await completeJob(worker, context.identity, "Nothing to change.");
          await worker.outbox.flush();
          return { kind: "completed" };
        },
      }),
    });

    const started = await delegate(world, jobFor(world));
    await started.completion;
    await world.outbox.flush();

    expect(agentTmp).toBe(world.environment.paths.scratch(worktree));
    const [verification] = await world.stores.verifications.listByNode(world.scope, started.nodeId);
    expect(verification?.outcome).toBe("passed");
    // What the step left in its temp directory went with it.
    expect(existsSync(world.environment.paths.scratch(worktree))).toBe(false);
  });
});
