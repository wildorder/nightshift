/**
 * Behaviour specific to the DynamoDB adapter, beyond the shared conformance suite
 * (which runs against this adapter from `apps/api`, the one place allowed to
 * import it alongside the suite).
 */
import type { Event } from "@nightshift/contracts";
import {
  createFixtures,
  makeAgent,
  makeEvent,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  OwnershipViolationError,
} from "@nightshift/core";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeCursor } from "./cursor.js";
import { ItemTooLargeError } from "./items.js";
import { keys } from "./keys.js";
import { createAwsStores } from "./stores.js";
import { FakeTable } from "./testing/fake-table.js";

const tableName = "nightshift-test";

describe("DynamoDB adapter specifics", () => {
  let table: FakeTable;
  let stores: ReturnType<typeof createAwsStores>;
  let f: ReturnType<typeof createFixtures>;

  beforeEach(() => {
    // A two-item page cap forces every list through DynamoDB's own pagination.
    table = new FakeTable({ tableName, pageItemCap: 2 });
    stores = createAwsStores({ tableName, table });
    f = createFixtures();
  });

  describe("events (A-22, D-P2-17)", () => {
    it("writes an unnumbered event beside an idempotency marker", async () => {
      const event = makeEvent(f, { idempotencyKey: "k1", sequence: 7 });
      const result = await stores.events.append(event);

      expect(result).toEqual({ stored: true, event: { ...event, sequence: null } });
      const stored = await table.get({
        TableName: tableName,
        Key: keys.event(f.scope, event.eventId),
      });
      expect(stored.Item?.sequence).toBeNull();
      const marker = await table.get({
        TableName: tableName,
        Key: keys.idempotency(f.scope, "k1"),
      });
      expect(marker.Item?.eventId).toBe(event.eventId);
      expect(await stores.events.nextSequence(f.scope)).toBe(0);
    });

    it("lets exactly one of two concurrent duplicates land, whatever their event ids", async () => {
      const results = await Promise.all([
        stores.events.append(makeEvent(f, { idempotencyKey: "same" })),
        stores.events.append(makeEvent(f, { idempotencyKey: "same" })),
      ]);
      expect(results.filter((r) => r.stored)).toHaveLength(1);
      expect(results[0]?.event.eventId).toBe(results[1]?.event.eventId);
      expect((await stores.events.listByRun(f.scope)).items).toHaveLength(1);
    });

    it("refuses an event id reused under a different idempotency key", async () => {
      const event = makeEvent(f, { idempotencyKey: "first" });
      await stores.events.append(event);
      await expect(stores.events.append({ ...event, idempotencyKey: "second" })).rejects.toThrow(
        /different idempotency key/,
      );
    });

    it("never lists the counter or the markers as events", async () => {
      await stores.events.append(makeEvent(f, { idempotencyKey: "k" }));
      await table.put({ TableName: tableName, Item: { ...keys.counter(f.scope), next: 1 } });
      const listed = (await stores.events.listByRun(f.scope)).items;
      expect(listed.map((e: Event) => e.idempotencyKey)).toEqual(["k"]);
    });

    it("refuses a cursor that does not decode to a stream position", async () => {
      await expect(stores.events.listByRun(f.scope, { cursor: "garbage" })).rejects.toThrow(
        RangeError,
      );
      await expect(
        stores.events.listByRun(f.scope, { cursor: encodeCursor({ sequence: "x", eventId: 1 }) }),
      ).rejects.toThrow(RangeError);
    });
  });

  describe("pagination", () => {
    it("follows DynamoDB pages to fill a page, and omits the cursor at the exact end", async () => {
      const orgId = f.ids.next("org");
      for (let i = 0; i < 6; i += 1) {
        await stores.projects.put(makeProject(f, { projectId: f.ids.next("proj"), orgId }));
      }
      const first = await stores.projects.listByOrg(orgId, { limit: 3 });
      expect(first.items).toHaveLength(3);
      const second = await stores.projects.listByOrg(orgId, {
        limit: 3,
        cursor: first.cursor as string,
      });
      expect(second.items).toHaveLength(3);
      expect(second.cursor).toBeUndefined();
    });

    it("refuses a cursor minted for another partition", async () => {
      const orgOne = f.ids.next("org");
      const orgTwo = f.ids.next("org");
      for (let i = 0; i < 3; i += 1) {
        await stores.projects.put(makeProject(f, { projectId: f.ids.next("proj"), orgId: orgOne }));
      }
      const page = await stores.projects.listByOrg(orgOne, { limit: 1 });
      await expect(
        stores.projects.listByOrg(orgTwo, { limit: 1, cursor: page.cursor as string }),
      ).rejects.toThrow(RangeError);
      await expect(
        stores.projects.listByOrg(orgOne, { cursor: "not-base64-json" }),
      ).rejects.toThrow(RangeError);
    });
  });

  describe("item layout", () => {
    it("refuses a record over the item limit before calling DynamoDB, writing nothing", async () => {
      const huge = makeProgramContract(f, { objective: "x".repeat(450_000) });
      await expect(stores.programContracts.put(huge)).rejects.toThrow(ItemTooLargeError);
      expect(table.allItems()).toHaveLength(0);
    });

    it("indexes records under their node and child nodes under their parent (§4.2)", async () => {
      const root = makeRootNode(f);
      const child = makeNode(f, root.executionNodeId);
      await stores.executionNodes.put(root);
      await stores.executionNodes.put(child);
      await stores.agents.put(makeAgent(f, child.executionNodeId));

      const items = table.allItems();
      const rootItem = items.find((i) => i.SK === `NODE#${root.executionNodeId}`);
      const childItem = items.find((i) => i.SK === `NODE#${child.executionNodeId}`);
      const agentItem = items.find((i) => String(i.SK).startsWith("AGENT#"));

      expect(rootItem?.GSI1PK).toBeUndefined();
      expect(childItem?.GSI1SK).toBe(`CHILD#${child.executionNodeId}`);
      expect(childItem?.GSI1PK).toBe(
        keys.nodeIndex(f.scope, root.executionNodeId, "CHILD", "").GSI1PK,
      );
      expect(agentItem?.GSI1PK).toBe(
        keys.nodeIndex(f.scope, child.executionNodeId, "AGENT", "").GSI1PK,
      );
    });

    it("leaves no org listing behind when a move between orgs is refused", async () => {
      const project = makeProject(f, { orgId: f.ids.next("org") });
      await stores.projects.put(project);
      const otherOrg = f.ids.next("org");

      await expect(stores.projects.put({ ...project, orgId: otherOrg })).rejects.toThrow(
        OwnershipViolationError,
      );
      expect(table.allItems().filter((i) => i.PK === `ORG#${otherOrg}`)).toEqual([]);
    });

    it("returns records without their key attributes", async () => {
      const project = makeProject(f);
      await stores.projects.put(project);
      expect(await stores.projects.get(project.projectId)).toEqual(project);
    });
  });
});
