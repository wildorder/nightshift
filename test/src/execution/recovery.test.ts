import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobContractSchema, type RouteChoice } from "@nightshift/contracts";
import { nowIso, transition } from "@nightshift/core";
import {
  completeJob,
  createEngine,
  createMergeQueue,
  delegateJob,
  type Engine,
  fastForward,
  git,
  type IntegrationCandidate,
  patchIdOf,
  removeWorktree,
  revParse,
  sealedRef,
  startJob,
  updateRef,
  verifyNode,
} from "@nightshift/execution";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeHarness } from "./fake-harness.js";
import { cleanupWorlds, createWorld, PROGRAM_BRANCH, type World } from "./world.js";

afterEach(cleanupWorlds);
const route: RouteChoice = {
  target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
  eligibleOptions: [
    {
      target: { harness: "fake", provider: "anthropic", model: "claude-sonnet-5" },
      eligible: true,
    },
  ],
  ruleId: "test",
  wasOverride: false,
};
const mcp = () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} });
const recoverAndWait = async (engine: Engine): Promise<void> => {
  await engine.recover();
  await vi.waitFor(() => expect(engine.idle()).toBe(true), { timeout: 30_000 });
};
const examinedSession = (world: World) => {
  const policy = world.session.run.policy;
  if (policy === undefined) throw new Error("fixture needs the run's recorded policy");
  return {
    ...world.session,
    run: {
      ...world.session.run,
      policy: {
        ...policy,
        examinationPolicy: {
          ...policy.examinationPolicy,
          low: { ...policy.examinationPolicy.low, required: true },
        },
      },
    },
  };
};

const fixture = async (options: { broken?: boolean; hang?: boolean } = {}) => {
  let world: World;
  const launches = vi.fn();
  world = await createWorld({
    program: { delegationLimits: { maxDepth: 2, maxConcurrency: 1 } },
    harness: createFakeHarness({
      onStart: launches,
      script: async ({ identity, worktree, cancelled }) => {
        if (options.hang) {
          await cancelled;
          return { kind: "cancelled" };
        }
        await writeFile(join(worktree, "src", "recovered.js"), "export const recovered = true;\n");
        if (options.broken)
          await writeFile(
            join(worktree, "test", "broken.test.js"),
            "throw new Error('actual regression');\n",
          );
        await completeJob(world.environment, identity, "Added the recovered module.");
        return { kind: "completed" };
      },
    }),
  });
  const job = JobContractSchema.parse({
    schemaVersion: 1,
    ...world.scope,
    jobContractId: world.ids.next("job"),
    objective: "Keep completed work through restart",
    acceptance: ["Tests pass"],
    dependencies: [],
    risk: "low",
    ambiguity: "low",
    createdAt: nowIso(world.clock),
  });
  const input = {
    session: world.session,
    job,
    depth: 1,
    parentNodeId: world.session.rootNodeId,
    route,
    mcp,
  };
  const fresh = () =>
    createEngine({
      environment: world.environment,
      session: world.session,
      mcp,
      route: () => route,
    });
  const implemented = async () => {
    let candidate: IntegrationCandidate | undefined;
    const started = await startJob(world.environment, {
      ...input,
      node: await delegateJob(world.environment, input),
      integrate: async (value) => {
        candidate = value;
      },
    });
    await started.completion;
    expect(candidate).toBeDefined();
    const kept = candidate as IntegrationCandidate;
    const node = await world.stores.executionNodes.get(world.scope, kept.nodeId);
    expect(node?.status).toBe("implemented");
    return { candidate: kept, node: node as NonNullable<typeof node> };
  };
  return { world, input, fresh, launches, implemented };
};

describe("durable engine recovery", () => {
  it("preserves accepted queue entries when the process shuts down", async () => {
    const f = await fixture({ hang: true });
    const engine = f.fresh();
    const first = await engine.submit(f.input);
    const second = await engine.submit({
      ...f.input,
      job: { ...f.input.job, jobContractId: f.world.ids.next("job") },
    });
    expect(second.status).toBe("queued");
    expect(await engine.close("remote process restart", { preserveWork: true })).toEqual([]);
    await Promise.all(engine.jobs().map((job) => job.stop("interrupted")));
    expect((await f.world.stores.executionNodes.get(f.world.scope, first.nodeId))?.status).toBe(
      "interrupted",
    );
    expect((await f.world.stores.executionNodes.get(f.world.scope, second.nodeId))?.status).toBe(
      "queued",
    );
  });

  it("does not cascade cancellation to queued children of a restarting subprogram", async () => {
    const f = await fixture({ hang: true });
    const engine = f.fresh();
    const parent = await engine.submit({ ...f.input, kind: "sub-program" });
    const child = await delegateJob(f.world.environment, {
      ...f.input,
      depth: 2,
      parentNodeId: parent.nodeId,
      job: { ...f.input.job, jobContractId: f.world.ids.next("job") },
    });
    await engine.close("remote process restart", { preserveWork: true });
    await Promise.all(engine.jobs().map((job) => job.stop("interrupted")));
    await engine.settled();
    expect((await f.world.stores.executionNodes.get(f.world.scope, parent.nodeId))?.status).toBe(
      "interrupted",
    );
    expect(
      (await f.world.stores.executionNodes.get(f.world.scope, child.executionNodeId))?.status,
    ).toBe("queued");
    const replacement = f.fresh();
    await replacement.recover();
    expect(replacement.waiting(child.jobContractId as never)).toMatchObject({
      kind: "parent_inactive",
      status: "interrupted",
    });
    expect(replacement.idle()).toBe(false);
    const prepare = vi.fn(async () => "prepared");
    expect(await replacement.withEnvironment(prepare)).toBe("prepared");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(f.launches).toHaveBeenCalledTimes(1);
  });

  it("refuses environment preparation while a worker is running", async () => {
    const f = await fixture({ hang: true });
    const engine = f.fresh();
    await engine.submit(f.input);
    const prepare = vi.fn(async () => {});
    await expect(engine.withEnvironment(prepare)).rejects.toThrow("environment_busy");
    expect(prepare).not.toHaveBeenCalled();
    await engine.close("test cleanup", { preserveWork: true });
    await Promise.all(engine.jobs().map((job) => job.stop("interrupted")));
  });

  it("holds discovery during preparation and resumes the scheduler after a preparation failure", async () => {
    const f = await fixture();
    const engine = f.fresh();
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const preparation = engine.withEnvironment(async () => {
      entered();
      await gate;
      throw new Error("setup failed");
    });
    const failure = expect(preparation).rejects.toThrow("setup failed");
    await started;
    const node = await delegateJob(f.world.environment, f.input);
    await engine.discover();
    expect(f.launches).not.toHaveBeenCalled();
    expect(engine.idle()).toBe(false);
    const queued = await engine.submit({
      ...f.input,
      job: { ...f.input.job, jobContractId: f.world.ids.next("job") },
    });
    expect(queued.status).toBe("queued");
    release();
    await failure;
    await engine.discover();
    await vi.waitFor(() => expect(engine.idle()).toBe(true), { timeout: 30_000 });
    expect(
      (await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId))?.status,
    ).toBe("integrated");
    expect(f.launches).toHaveBeenCalledTimes(2);
  });

  it("finishes an interrupted sealing step using the recorded independent examination", async () => {
    const f = await fixture();
    const { candidate, node } = await f.implemented();
    const verified = await verifyNode(f.world.environment, { ...candidate, node });
    if (!verified.passed) throw new Error("fixture verification failed");
    const examinerAgentId = f.world.ids.next("agent");
    await f.world.stores.agents.put({
      schemaVersion: 1,
      ...f.world.scope,
      agentId: examinerAgentId,
      executionNodeId: node.executionNodeId,
      role: "examiner",
      harness: route.target.harness,
      provider: route.target.provider,
      model: route.target.model,
      status: "created",
      createdAt: nowIso(f.world.clock),
    });
    const diff = await git(
      f.world.git,
      ["diff", "--no-color", "--no-ext-diff", candidate.base, verified.commitSha],
      { cwd: f.world.repo },
    );
    await f.world.stores.examinations.put({
      schemaVersion: 1,
      ...f.world.scope,
      examinationId: f.world.ids.next("exam"),
      executionNodeId: node.executionNodeId,
      verificationId: verified.verification.verificationId,
      commitSha: verified.commitSha,
      patchId: patchIdOf(diff),
      implementerAgentId: candidate.agentId,
      examinerAgentId,
      examinerRoute: route.target,
      requiredByRisk: "low",
      blocking: false,
      fixAttempt: 0,
      questions: [],
      outcome: "passed",
      findings: [],
      createdAt: nowIso(f.world.clock),
    });
    const current = await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId);
    await f.world.stores.executionNodes.put(
      transition(current as typeof node, "begin_examination", nowIso(f.world.clock)),
    );
    const session = examinedSession(f.world);
    await recoverAndWait(
      createEngine({ environment: f.world.environment, session, mcp, route: () => route }),
    );
    expect(
      (await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId))?.status,
    ).toBe("integrated");
    expect(f.launches).toHaveBeenCalledTimes(1);
    expect(
      await f.world.stores.examinations.listByNode(f.world.scope, node.executionNodeId),
    ).toHaveLength(1);
  });

  it("returns after scheduling and stays busy until recovered verification finishes", async () => {
    const f = await fixture();
    await f.implemented();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createMergeQueue(f.world.environment);
    const engine = createEngine({
      environment: f.world.environment,
      session: f.world.session,
      mcp,
      route: () => route,
      mergeQueue: {
        ...queue,
        integrate: async (candidate) => {
          await gate;
          return queue.integrate(candidate);
        },
      },
    });
    await engine.recover();
    expect(engine.idle()).toBe(false);
    release();
    await vi.waitFor(() => expect(engine.idle()).toBe(true), { timeout: 30_000 });
  });

  it("still refuses a completed candidate whose recovered checks fail", async () => {
    const f = await fixture({ broken: true });
    const { node } = await f.implemented();
    await recoverAndWait(f.fresh());
    expect(
      (await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId))?.status,
    ).toBe("verification_failed");
    expect(await revParse(f.world.git, f.world.repo, PROGRAM_BRANCH)).toBe(f.world.baseCommit);
    expect(f.launches).toHaveBeenCalledTimes(1);
  });

  it("recreates a missing worktree from the durable commit", async () => {
    const f = await fixture();
    const { candidate, node } = await f.implemented();
    await removeWorktree(f.world.git, f.world.repo, candidate.worktree, candidate.branch);
    await recoverAndWait(f.fresh());
    expect(
      (await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId))?.status,
    ).toBe("integrated");
    expect(f.launches).toHaveBeenCalledTimes(1);
  });

  it("records missing git evidence without rerunning or integrating the worker", async () => {
    const f = await fixture();
    const { node } = await f.implemented();
    await f.world.stores.executionNodes.put({
      ...node,
      commitSha: "f".repeat(40) as never,
      updatedAt: nowIso(f.world.clock),
    });
    await recoverAndWait(f.fresh());
    const failed = await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId);
    expect(failed?.status).toBe("failed");
    expect(failed?.outcomeReason).toContain("recovery_missing_evidence");
    expect(await revParse(f.world.git, f.world.repo, PROGRAM_BRANCH)).toBe(f.world.baseCommit);
    expect(f.launches).toHaveBeenCalledTimes(1);
  });

  it.each(["verified", "examining"] as const)(
    "does not skip required examination when recovering %s",
    async (stage) => {
      const f = await fixture();
      const { candidate, node } = await f.implemented();
      expect((await verifyNode(f.world.environment, { ...candidate, node })).passed).toBe(true);
      if (stage === "examining") {
        const verified = await f.world.stores.executionNodes.get(
          f.world.scope,
          node.executionNodeId,
        );
        await f.world.stores.executionNodes.put(
          transition(verified as typeof node, "begin_examination", nowIso(f.world.clock)),
        );
      }
      const session = examinedSession(f.world);
      const engine = createEngine({
        environment: f.world.environment,
        session,
        mcp,
        route: () => route,
      });
      await recoverAndWait(engine);
      expect(
        (await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId))?.status,
      ).toBe("examination_failed");
      expect(await revParse(f.world.git, f.world.repo, PROGRAM_BRANCH)).toBe(f.world.baseCommit);
      expect(f.launches).toHaveBeenCalledTimes(1);
    },
  );

  it("reruns interrupted checks against the candidate, not dirty worktree leftovers", async () => {
    const f = await fixture();
    const { candidate, node } = await f.implemented();
    await f.world.stores.executionNodes.put(
      transition(node, "begin_verification", nowIso(f.world.clock)),
    );
    await writeFile(
      join(candidate.worktree, "test", "poison.test.js"),
      "throw new Error('left by an interrupted check');\n",
    );
    await recoverAndWait(f.fresh());
    expect(
      (await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId))?.status,
    ).toBe("integrated");
    expect(
      await git(f.world.git, ["ls-tree", "-r", "--name-only", PROGRAM_BRANCH], {
        cwd: f.world.repo,
      }),
    ).not.toContain("poison");
  });

  it("adopts an accepted queued job exactly once across repeated discovery", async () => {
    const f = await fixture();
    const node = await delegateJob(f.world.environment, f.input);
    const engine = f.fresh();
    await Promise.all([engine.recover(), engine.recover()]);
    await engine.discover();
    await vi.waitFor(
      async () =>
        expect(
          (await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId))?.status,
        ).toBe("integrated"),
      { timeout: 30_000 },
    );
    await engine.recover();
    expect(f.launches).toHaveBeenCalledTimes(1);
    expect(
      await f.world.stores.routingDecisions.listByNode(f.world.scope, node.executionNodeId),
    ).toHaveLength(1);
  });

  it.each(["implemented", "verifying", "verified", "sealed", "landed", "integrated"] as const)(
    "resumes %s without running the worker again",
    async (stage) => {
      const f = await fixture();
      const { candidate, node } = await f.implemented();
      if (stage === "verifying")
        await f.world.stores.executionNodes.put(
          transition(node, "begin_verification", nowIso(f.world.clock)),
        );
      if (!["implemented", "verifying"].includes(stage)) {
        expect((await verifyNode(f.world.environment, { ...candidate, node })).passed).toBe(true);
        if (stage !== "verified") {
          const verified = await f.world.stores.executionNodes.get(
            f.world.scope,
            node.executionNodeId,
          );
          const sealed = transition(verified as typeof node, "seal", nowIso(f.world.clock));
          await updateRef(
            f.world.git,
            f.world.repo,
            sealedRef(node.executionNodeId),
            node.commitSha as never,
          );
          await f.world.stores.executionNodes.put(sealed);
          if (stage === "landed" || stage === "integrated") {
            expect(
              (
                await fastForward(
                  f.world.git,
                  f.world.repo,
                  node.commitSha as never,
                  f.world.clock.now(),
                )
              ).ok,
            ).toBe(true);
            if (stage === "integrated")
              await f.world.stores.executionNodes.put(
                transition(sealed, "integrate", nowIso(f.world.clock)),
              );
          }
        }
      }
      const engine = f.fresh();
      await recoverAndWait(engine);
      expect(
        (await f.world.stores.executionNodes.get(f.world.scope, node.executionNodeId))?.status,
      ).toBe("integrated");
      expect(await revParse(f.world.git, f.world.repo, PROGRAM_BRANCH)).toBe(node.commitSha);
      expect(f.launches).toHaveBeenCalledTimes(1);
      const checkpoints = (await f.world.stores.checkpoints.listByRun(f.world.scope)).items.filter(
        (record) => record.executionNodeId === node.executionNodeId,
      );
      expect(checkpoints).toHaveLength(1);
      await engine.recover();
      expect(
        (await f.world.stores.checkpoints.listByRun(f.world.scope)).items.filter(
          (record) => record.executionNodeId === node.executionNodeId,
        ),
      ).toEqual(checkpoints);
      expect(engine.idle()).toBe(true);
    },
  );
});
