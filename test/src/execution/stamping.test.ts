/**
 * What a decision produced (P9, D-P9-01, SC-P9-01, SC-P9-02): a decision a
 * worker records is stamped, when its job integrates through the merge queue,
 * with exactly the commit that landed and the checkpoint the landing made. One
 * whose job never landed stays unstamped. Over the fake harness, real git and
 * the production API handler.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutionNodeId,
  JobContractSchema,
  type RouteChoice,
  type RouteTarget,
} from "@nightshift/contracts";
import { isSettled, nowIso } from "@nightshift/core";
import { createEngine, type Engine } from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness } from "./fake-harness.js";
import { cleanupWorlds, createWorld, type World } from "./world.js";

afterEach(cleanupWorlds);

const TARGET: RouteTarget = { harness: "fake", provider: "anthropic", model: "fake-model" };
const ROUTE: RouteChoice = {
  target: TARGET,
  eligibleOptions: [{ target: TARGET, eligible: true }],
  ruleId: "R-test",
  wasOverride: false,
};

/** Each job records one decision, writes its own module, and completes unless told to fail. */
const rig = async () => {
  const made = await createWorld({
    harness: createFakeHarness({
      script: async ({ worktree, input }) => {
        const name = input.job.objective;
        await input.tools.recordDecision({
          context: `How to write ${name}`,
          alternatives: [{ summary: "a class", rejectedBecause: "a function is enough" }],
          choice: "a function",
          rationale: "smallest thing that works",
          reversibility: "reversible",
        });
        if (name.startsWith("fail")) {
          await input.tools.fail("it could not be done");
          return { kind: "failed", exitCode: 1 };
        }
        await writeFile(join(worktree, "src", `${name}.js`), `export const ${name} = 1;\n`, "utf8");
        await input.tools.complete(`${name}: done`);
        return { kind: "completed" };
      },
    }),
  });
  const engine = createEngine({
    environment: made.environment,
    session: made.session,
    mcp: () => ({ name: "nightshift", command: process.execPath, args: ["--version"], env: {} }),
    route: () => ROUTE,
  });
  const submit = async (objective: string) => {
    const job = JobContractSchema.parse({
      schemaVersion: 1,
      ...made.scope,
      jobContractId: made.ids.next("job"),
      objective,
      acceptance: ["node --test passes"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      createdAt: nowIso(made.environment.clock),
    });
    return (
      await engine.submit({
        job,
        depth: 1,
        parentNodeId: made.session.rootNodeId,
        route: ROUTE,
      })
    ).nodeId;
  };
  return { world: made, engine, submit };
};

const settled = async (world: World, engine: Engine, nodeId: ExecutionNodeId) => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const node = await world.stores.executionNodes.get(world.scope, nodeId);
    if (node !== undefined && isSettled(node.status) && engine.idle()) return node;
    if (Date.now() > deadline) throw new Error(`node ${nodeId} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const decisionOn = async (world: World, nodeId: ExecutionNodeId) =>
  (await world.stores.decisions.listByRun(world.scope)).items.find(
    (decision) => decision.executionNodeId === nodeId,
  );

describe("a decision is stamped with what it produced (D-P9-01)", () => {
  it("stamps a job's decision with the commit the queue landed and the landing's checkpoint", async () => {
    const { world, engine, submit } = await rig();
    const first = await submit("alpha");
    const second = await submit("beta");
    const one = await settled(world, engine, first);
    const two = await settled(world, engine, second);
    expect([one.status, two.status]).toEqual(["integrated", "integrated"]);

    for (const node of [one, two]) {
      const decision = await decisionOn(world, node.executionNodeId);
      // Exactly its own commit: nothing that landed before or after it.
      expect(decision?.produced).toEqual({ commits: [node.commitSha] });
      const after = await world.stores.checkpoints.get(
        world.scope,
        decision?.checkpointAfter as never,
      );
      expect(after?.commitSha).toBe(node.commitSha);
      expect(decision?.checkpointAfter).not.toBe(decision?.checkpointBefore);
    }
  });

  it("leaves a decision whose job never landed unstamped", async () => {
    const { world, engine, submit } = await rig();
    const failed = await settled(world, engine, await submit("failing"));
    expect(failed.status).toBe("failed");
    const decision = await decisionOn(world, failed.executionNodeId);
    expect(decision).toBeDefined();
    expect(decision?.produced).toBeUndefined();
    expect(decision?.checkpointAfter).toBeUndefined();
  });
});
