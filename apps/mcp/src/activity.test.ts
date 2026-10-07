import {
  createFixtures,
  makeEvent,
  makeJobContract,
  makeNode,
  makeRootNode,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describe, expect, it } from "vitest";
import { createActivityFeed, renderActivity } from "./activity.js";

describe("gate health in the Meanwhile lines (P15)", () => {
  it("tells the root what a red base, a flake and a landed repair ask of it", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores();
    await stores.executionNodes.put(makeRootNode(f));
    const job = makeJobContract(f, { objective: "Add a median helper." });
    const node = makeNode(f, f.rootNodeId, { jobContractId: job.jobContractId });
    const decisionId = f.ids.next("dec");
    const repair = makeJobContract(f, {
      objective: "Make the test gate pass.",
      repair: { cause: "red_base", gates: ["test"], decisionId },
    });
    for (const contract of [job, repair]) await stores.jobContracts.put(contract);
    await stores.executionNodes.put(node);
    const at = (minute: number) => `2026-10-07T03:${String(minute).padStart(2, "0")}:00.000Z`;
    for (const event of [
      makeEvent(f, {
        type: "gate.red",
        executionNodeId: f.rootNodeId,
        payload: { baseCommit: "a".repeat(40), failing: ["build", "test"] },
        occurredAt: at(1),
      }),
      makeEvent(f, {
        type: "gate.flaked",
        executionNodeId: node.executionNodeId,
        payload: {
          verificationId: f.ids.next("ver"),
          commitSha: "b".repeat(40),
          stepIds: ["lint"],
        },
        occurredAt: at(2),
      }),
      makeEvent(f, {
        type: "gate.repaired",
        executionNodeId: f.rootNodeId,
        payload: {
          jobContractId: repair.jobContractId,
          decisionId,
          cause: "red_base",
          definitionsChanged: true,
        },
        occurredAt: at(3),
      }),
    ]) {
      await stores.events.append(event);
    }

    const lines = renderActivity(await createActivityFeed(stores, f.scope).since());

    expect(lines).toEqual([
      "03:01 root — the base is red: build, test; the run repairs it first — delegate a repair " +
        "{ cause: red_base } before anything else; strands wait on it",
      "03:02 Add a median helper. — lint flaked on Add a median helper.: the work landed; open a " +
        "repair { cause: flaky } off the blocking path",
      `03:03 root — repair ${repair.jobContractId} landed (red_base test) under decision ` +
        `${decisionId}; the gate definitions changed, and later verifications use them`,
    ]);
  });
});
