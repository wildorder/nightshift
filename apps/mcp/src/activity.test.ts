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
      "03:01 root — the base is red: build, test; use the logs to address it within the authorized work; " +
        "required verification still must pass before integration",
      "03:02 Add a median helper. — lint flaked on Add a median helper.: the work landed; " +
        "investigate if needed, without blocking unrelated work",
      `03:03 root — repair ${repair.jobContractId} landed (red_base test) under decision ` +
        `${decisionId}; the gate definitions changed, and later verifications use them`,
    ]);
  });
});

describe("an environment fault in the Meanwhile lines (P16 D-07)", () => {
  it("names the disagreeing gates and both Nodes", async () => {
    const f = createFixtures();
    const stores = createInMemoryStores();
    await stores.executionNodes.put(makeRootNode(f));
    await stores.events.append(
      makeEvent(f, {
        type: "environment.fault",
        executionNodeId: f.rootNodeId,
        payload: {
          baseCommit: "a".repeat(40),
          gates: [
            {
              id: "test",
              command: "npm test",
              kind: "check",
              reference: "passed",
              machine: "failed",
            },
          ],
          referenceNode: "22.22.0",
          machineNode: "20.11.1",
        },
        occurredAt: "2026-10-07T03:01:00.000Z",
      }),
    );

    const lines = renderActivity(await createActivityFeed(stores, f.scope).since());

    expect(lines).toEqual([
      "03:01 root — environment fault: test (passed on the reference, failed here); Node 22.22.0 " +
        "on the reference, 20.11.1 on the machine. The machine is at fault, not the base: nothing " +
        "is repaired, and the run is cancelled",
    ]);
  });
});

describe("the feed a root's job.wait reads (2026-10-22)", () => {
  /** The store, counting the events each `listByRun` returned and the node lists read. */
  const counting = (stores: ReturnType<typeof createInMemoryStores>) => {
    const reads = { events: 0, nodeLists: 0 };
    return {
      reads,
      stores: {
        ...stores,
        events: {
          ...stores.events,
          listByRun: async (...args: Parameters<typeof stores.events.listByRun>) => {
            const page = await stores.events.listByRun(...args);
            reads.events += page.items.length;
            return page;
          },
        },
        executionNodes: {
          ...stores.executionNodes,
          listByRun: async (...args: Parameters<typeof stores.executionNodes.listByRun>) => {
            reads.nodeLists += 1;
            return stores.executionNodes.listByRun(...args);
          },
        },
      },
    };
  };

  it("reads only what followed the last wait, tells each line once, and names a node met later", async () => {
    const f = createFixtures();
    const base = createInMemoryStores();
    await base.executionNodes.put(makeRootNode(f));
    const first = makeJobContract(f, { objective: "Add the first thing.", strandId: "S-01" });
    await base.jobContracts.put(first);
    const firstNode = makeNode(f, f.rootNodeId, { jobContractId: first.jobContractId });
    await base.executionNodes.put(firstNode);
    for (let i = 0; i < 20; i += 1) {
      await base.events.append(
        makeEvent(f, {
          type: "node.progress",
          executionNodeId: firstNode.executionNodeId,
          payload: { message: `step ${i}` },
        }),
      );
    }
    const { stores, reads } = counting(base);
    const feed = createActivityFeed(stores as never, f.scope);
    const opening = renderActivity(await feed.since());
    expect(opening.filter((line) => line.includes("step "))).toHaveLength(20);
    const nodeListsAfterOpening = reads.nodeLists;

    // A wait with nothing new reads nothing, and says nothing.
    reads.events = 0;
    expect(await feed.since()).toEqual([]);
    expect(reads.events).toBe(0);

    // A new strand's node appears, and two events: only those two are read, the
    // new node is named, and nothing already told is told again.
    const second = makeJobContract(f, { objective: "Add the second thing.", strandId: "S-02" });
    await base.jobContracts.put(second);
    const secondNode = makeNode(f, f.rootNodeId, { jobContractId: second.jobContractId });
    await base.executionNodes.put(secondNode);
    for (const [node, message] of [
      [firstNode, "step 20"],
      [secondNode, "begun"],
    ] as const) {
      await base.events.append(
        makeEvent(f, {
          type: "node.progress",
          executionNodeId: node.executionNodeId,
          payload: { message },
        }),
      );
    }
    reads.events = 0;
    const later = renderActivity(await feed.since());
    expect(reads.events).toBe(2);
    expect(later).toHaveLength(2);
    expect(later.some((line) => line.includes("S-02") && line.includes("begun"))).toBe(true);
    expect(later.some((line) => line.includes("S-01") && line.includes("step 20"))).toBe(true);
    expect(reads.nodeLists).toBe(nodeListsAfterOpening + 1);

    // The whole story is still there for run.activity.
    expect((await feed.all(100)).length).toBe(22);
  });
});
