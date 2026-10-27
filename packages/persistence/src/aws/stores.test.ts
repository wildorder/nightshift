/**
 * Behaviour specific to the DynamoDB adapter, beyond the shared conformance suite
 * (which runs against this adapter from `apps/api`, the one place allowed to
 * import it alongside the suite).
 */
import {
  type CompletionHistory,
  type CompletionMemberRef,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type Event,
  type IsoTimestamp,
  MAX_COMPLETION_CHECKPOINTS,
  MAX_COMPLETION_HISTORY_BYTES,
  MAX_COMPLETION_MEMBERS,
  MAX_COMPLETION_REVISIONS,
  type OrgConfig,
} from "@nightshift/contracts";
import {
  completionHistoryBytes,
  createFixtures,
  makeAgent,
  makeCompletionHistory,
  makeComputeUtilization,
  makeDispatch,
  makeEvent,
  makeGateHealth,
  makeNode,
  makeOrgCredential,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeRunFeedback,
  OwnershipViolationError,
  StaleWriteError,
} from "@nightshift/core";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeCursor } from "./cursor.js";
import { ItemTooLargeError } from "./items.js";
import { keys } from "./keys.js";
import { CredentialsTableUnavailableError, createAwsStores } from "./stores.js";
import { FakeTable } from "./testing/fake-table.js";
import { routingTableClient } from "./testing/routing-table.js";

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

  describe("an org's configuration (P8, D-P8-02)", () => {
    const configOf = (orgId: OrgConfig["orgId"], version: number): OrgConfig => ({
      schemaVersion: 1,
      orgId,
      routingPolicy: DEFAULT_ROUTING_POLICY,
      examinationPolicy: DEFAULT_EXAMINATION_POLICY,
      installations: [],
      version,
      updatedAt: "2026-09-25T10:00:00.000Z",
    });

    it("is one row under the org's partition, written by compare-and-swap on version", async () => {
      const orgId = f.ids.next("org");
      await expect(stores.orgConfigs.put(configOf(orgId, 2))).rejects.toBeInstanceOf(
        StaleWriteError,
      );
      await stores.orgConfigs.put(configOf(orgId, 1));
      const stored = await table.get({ TableName: tableName, Key: keys.orgConfig(orgId) });
      expect(stored.Item).toMatchObject({ PK: `ORG#${orgId}`, SK: "CONFIG", version: 1 });
      await expect(stores.orgConfigs.put(configOf(orgId, 1))).rejects.toBeInstanceOf(
        StaleWriteError,
      );
      await stores.orgConfigs.put(configOf(orgId, 2));
      expect(await stores.orgConfigs.get(orgId)).toEqual(configOf(orgId, 2));
    });
  });

  describe("an org's credentials (P10, D-P10-23)", () => {
    const credentialsTableName = "nightshift-test-credentials";

    it("live in the credentials table and never the main one", async () => {
      const credentialsTable = new FakeTable({ tableName: credentialsTableName });
      const client = routingTableClient({
        [tableName]: table,
        [credentialsTableName]: credentialsTable,
      });
      const withCredentials = createAwsStores({ tableName, table: client, credentialsTableName });
      const orgId = f.ids.next("org");
      const sealed = makeOrgCredential(orgId);
      await withCredentials.credentials.put(sealed);
      expect(await withCredentials.credentials.sealed(orgId, "anthropic")).toEqual(sealed);
      expect(await withCredentials.credentials.view(orgId)).toEqual([
        { provider: "anthropic", lastFour: sealed.lastFour, setAt: sealed.setAt },
      ]);
      const inCredentials = await credentialsTable.get({
        TableName: credentialsTableName,
        Key: keys.credential(orgId, "anthropic"),
      });
      expect(inCredentials.Item).toMatchObject({ PK: `ORG#${orgId}`, SK: "PROVIDER#anthropic" });
      const inMain = await table.get({
        TableName: tableName,
        Key: keys.credential(orgId, "anthropic"),
      });
      expect(inMain.Item).toBeUndefined();
    });

    it("refuse every call by name when no credentials table is configured", async () => {
      const orgId = f.ids.next("org");
      await expect(stores.credentials.put(makeOrgCredential(orgId))).rejects.toBeInstanceOf(
        CredentialsTableUnavailableError,
      );
      await expect(stores.credentials.view(orgId)).rejects.toBeInstanceOf(
        CredentialsTableUnavailableError,
      );
      await expect(stores.credentials.sealed(orgId, "openai")).rejects.toBeInstanceOf(
        CredentialsTableUnavailableError,
      );
      // And nothing landed in the main table.
      const scanned = await table.scan({ TableName: tableName });
      expect(scanned.Items ?? []).toEqual([]);
    });
  });

  describe("a project's utilization records (P10, D-P10-14b)", () => {
    it("list newest run first, through DynamoDB's own pages", async () => {
      const runIds = [f.ids.next("run"), f.ids.next("run"), f.ids.next("run")];
      for (const runId of runIds) {
        await stores.computeUtilizations.put(makeComputeUtilization(f, { runId }));
      }
      const page = await stores.computeUtilizations.listByProject(f.scope.projectId);
      expect(page.items.map((record) => record.runId)).toEqual([...runIds].reverse());
      const first = await stores.computeUtilizations.listByProject(f.scope.projectId, { limit: 2 });
      expect(first.items.map((record) => record.runId)).toEqual([runIds[2], runIds[1]]);
      expect(first.cursor).toBeDefined();
      const rest = await stores.computeUtilizations.listByProject(f.scope.projectId, {
        limit: 2,
        cursor: first.cursor ?? "",
      });
      expect(rest.items.map((record) => record.runId)).toEqual([runIds[0]]);
    });
  });

  describe("a program contract changed in place (P16, D-08)", () => {
    const keyOf = () => keys.programContract(f.scope.projectId, f.scope.programId);
    const revisionOf = async (): Promise<unknown> =>
      (await table.get({ TableName: tableName, Key: keyOf() })).Item?.REV;

    it("writes a fresh revision with every write, and never reads it back as part of the record", async () => {
      const contract = makeProgramContract(f);
      await stores.programContracts.put(contract);
      const first = await revisionOf();
      expect(typeof first).toBe("string");
      expect(await stores.programContracts.get(f.scope.projectId, f.scope.programId)).toEqual(
        contract,
      );
      await stores.programContracts.update(f.scope.projectId, f.scope.programId, (current) => ({
        ...current,
        outOfScope: ["a UI"],
      }));
      expect(await revisionOf()).not.toBe(first);
      expect((await stores.programContracts.listByProject(f.scope.projectId)).items).toEqual([
        { ...contract, outOfScope: ["a UI"] },
      ]);
    });

    it("changes an item written before revisions, which has none", async () => {
      const contract = makeProgramContract(f);
      await table.put({ TableName: tableName, Item: { ...contract, ...keyOf() } });
      expect(await revisionOf()).toBeUndefined();
      await stores.programContracts.update(f.scope.projectId, f.scope.programId, (current) => ({
        ...current,
        outOfScope: ["a UI"],
      }));
      expect(
        (await stores.programContracts.get(f.scope.projectId, f.scope.programId))?.outOfScope,
      ).toEqual(["a UI"]);
    });

    it("reads again when another write landed between its read and its write", async () => {
      const contract = makeProgramContract(f);
      await stores.programContracts.put(contract);
      let calls = 0;
      await stores.programContracts.update(f.scope.projectId, f.scope.programId, (current) => {
        calls += 1;
        if (calls === 1) {
          // Another writer, after this one read: its change must survive.
          void stores.programContracts.put({ ...contract, outOfScope: ["theirs"] });
        }
        return { ...current, outOfScope: [...(current.outOfScope ?? []), "mine"] };
      });
      expect(calls).toBe(2);
      expect(
        (await stores.programContracts.get(f.scope.projectId, f.scope.programId))?.outOfScope,
      ).toEqual(["theirs", "mine"]);
    });
  });

  describe("a project's gate health (P15, D-P15-07)", () => {
    it("is one row under the project's partition, replaced by each put", async () => {
      await stores.gateHealth.put(makeGateHealth(f));
      const replaced = makeGateHealth(f, { fingerprint: "1".repeat(64) });
      await stores.gateHealth.put(replaced);
      const rows = table.allItems().filter((item) => item.SK === "GATE-HEALTH");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        PK: `PROJ#${f.scope.projectId}`,
        fingerprint: "1".repeat(64),
      });
      expect(await stores.gateHealth.get(f.scope.projectId)).toEqual(replaced);
    });

    it("is not one of the project's programs or utilization records", async () => {
      await stores.gateHealth.put(makeGateHealth(f));
      expect((await stores.programContracts.listByProject(f.scope.projectId)).items).toEqual([]);
      expect((await stores.computeUtilizations.listByProject(f.scope.projectId)).items).toEqual([]);
    });
  });

  describe("run feedback and completion histories (P20)", () => {
    it("keeps feedback beside the program's runs and a history under the project", async () => {
      await stores.feedback.put(makeRunFeedback(f));
      const history = makeCompletionHistory(f);
      await stores.completionHistories.put(history);
      const p = f.scope.projectId;
      expect(table.allItems().map((item) => [item.PK, item.SK])).toEqual(
        expect.arrayContaining([
          [`PROJ#${p}#PROG#${f.scope.programId}`, `FEEDBACK#${f.scope.runId}`],
          [`PROJ#${p}`, `COMPLETION#${history.completionHistoryId}`],
        ]),
      );
      expect((await stores.runs.listByProgram(f.scope)).items).toEqual([]);
    });

    it("accepts the maximal completion history and reads it back equal", async () => {
      const actor = { kind: "user", userId: "ann", orgId: f.ids.next("org") } as never;
      const members: CompletionMemberRef[] = [
        { programId: f.scope.programId, runId: f.scope.runId, role: "anchor" },
        ...Array.from(
          { length: MAX_COMPLETION_MEMBERS - 1 },
          (): CompletionMemberRef => ({
            programId: f.scope.programId,
            runId: f.ids.next("run"),
            role: "contributing",
          }),
        ),
      ];
      const measured = {
        measuredTo: "2026-01-01T00:00:00.000Z",
        readableMembers: MAX_COMPLETION_MEMBERS,
        measuredMembers: MAX_COMPLETION_MEMBERS,
        unmeasuredMembers: 0,
        earliestStart: "2026-01-01T00:00:00.000Z",
        leadTimeSeconds: 123456.789,
        runCompletionSeconds: 123456.789,
        activeSeconds: 123456.789,
        tokens: {
          input: 123456789,
          output: 123456789,
          cacheRead: 123456789,
          cacheWrite: 123456789,
          reasoning: 123456789,
          inputConventionUnknown: 3,
        },
        usd: { estimated: 1234.5678, reported: 1234.5678 },
        coverage: { complete: 40, partial: 5, unknown: 3, legacy: 1, missing: 1 },
        infrastructure: { usd: 12.345678, members: MAX_COMPLETION_MEMBERS, withoutMachine: 0 },
        recordedAt: "2026-01-01T00:00:00.000Z",
      };
      const checkpoints = Array.from({ length: MAX_COMPLETION_CHECKPOINTS }, (_, i) => ({
        name: `checkpoint-${i}-${"n".repeat(60)}`,
        programId: f.scope.programId,
        runId: f.scope.runId,
        feedbackVersion: 1,
        verdictRecordedAt: "2026-01-01T00:00:00.000Z",
        members: members.map((m) => ({ ...m })),
        membershipVersion: 1,
        recordedBy: actor,
        recordedAt: "2026-01-01T00:00:00.000Z",
        measured,
      }));
      const revision = (version: number) => ({
        version,
        actor,
        recordedAt: "2026-01-01T00:00:00.000Z",
        added: members.map((m) => ({ ...m })),
        removed: members.map((m) => ({ ...m })),
        title: "t".repeat(200),
        checkpoint: "c".repeat(80),
      });
      // Version 1 is the only version a fresh put accepts; the log is filled regardless.
      const base = { ...makeCompletionHistory(f), members, checkpoints };
      let revisions = Array.from({ length: MAX_COMPLETION_REVISIONS }, () => revision(1));
      const sized = (): CompletionHistory => ({ ...base, revisions }) as CompletionHistory;
      while (
        revisions.length > 1 &&
        completionHistoryBytes(sized()) > MAX_COMPLETION_HISTORY_BYTES
      ) {
        revisions = revisions.slice(1);
      }
      const history = sized();
      expect(revisions.length).toBeGreaterThan(1);
      expect(completionHistoryBytes(history)).toBeGreaterThan(
        MAX_COMPLETION_HISTORY_BYTES - 10_000,
      );
      await stores.completionHistories.put(history);
      expect(await stores.completionHistories.get(f.scope, history.completionHistoryId)).toEqual(
        history,
      );
    });

    it("refuses a stale or replayed version and changes nothing", async () => {
      const first = makeRunFeedback(f);
      await stores.feedback.put(first);
      await expect(stores.feedback.put(first)).rejects.toBeInstanceOf(StaleWriteError);
      expect(await stores.feedback.get(f.scope)).toEqual(first);
      const history = makeCompletionHistory(f);
      await stores.completionHistories.put(history);
      await expect(
        stores.completionHistories.put({ ...history, title: "other" }),
      ).rejects.toBeInstanceOf(StaleWriteError);
      expect(await stores.completionHistories.get(f.scope, history.completionHistoryId)).toEqual(
        history,
      );
    });
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

describe("a run and the program's live-run marker (S-01, PIP-9)", () => {
  const tableName = "nightshift-test";

  /** Every transaction the adapter sends, over a FakeTable. */
  const recording = () => {
    const table = new FakeTable({ tableName });
    const transactions: NonNullable<Parameters<FakeTable["transactWrite"]>[0]["TransactItems"]>[] =
      [];
    const client = {
      get: (input: Parameters<FakeTable["get"]>[0]) => table.get(input),
      put: (input: Parameters<FakeTable["put"]>[0]) => table.put(input),
      update: (input: Parameters<FakeTable["update"]>[0]) => table.update(input),
      delete: (input: Parameters<FakeTable["delete"]>[0]) => table.delete(input),
      scan: (input: Parameters<FakeTable["scan"]>[0]) => table.scan(input),
      query: (input: Parameters<FakeTable["query"]>[0]) => table.query(input),
      transactWrite: (input: Parameters<FakeTable["transactWrite"]>[0]) => {
        transactions.push(input.TransactItems ?? []);
        return table.transactWrite(input);
      },
    };
    return { table, transactions, stores: createAwsStores({ tableName, table: client }) };
  };

  it("writes the run and the marker claim in one transaction, and puts the marker beside no run", async () => {
    const { table, transactions, stores } = recording();
    const f = createFixtures();
    const run = makeRun(f, { status: "pending" });
    await stores.runs.put(run);

    expect(transactions).toHaveLength(1);
    const [runPut, markerPut] = transactions[0] ?? [];
    expect(runPut?.Put?.Item).toMatchObject(keys.run(f.scope, run.runId));
    expect(markerPut?.Put?.Item).toMatchObject({
      ...keys.programLiveRun(f.scope),
      runId: run.runId,
    });
    const stored = await table.get({
      TableName: tableName,
      Key: keys.programLiveRun(f.scope),
      ConsistentRead: true,
    });
    expect(stored.Item?.runId).toBe(run.runId);
    // The marker is not a run: listing the program's runs never reads it.
    expect((await stores.runs.listByProgram(f.scope)).items).toHaveLength(1);
  });

  it("writes the run and the marker release in one transaction", async () => {
    const { table, transactions, stores } = recording();
    const f = createFixtures();
    const run = makeRun(f);
    await stores.runs.put(run);
    transactions.length = 0;
    await stores.runs.put({ ...run, status: "succeeded", endedAt: "2026-01-01T01:00:00.000Z" });

    expect(transactions).toHaveLength(1);
    const [runPut, release] = transactions[0] ?? [];
    expect(runPut?.Put?.Item).toMatchObject(keys.run(f.scope, run.runId));
    expect(release?.Delete?.Key).toEqual(keys.programLiveRun(f.scope));
    const gone = await table.get({
      TableName: tableName,
      Key: keys.programLiveRun(f.scope),
      ConsistentRead: true,
    });
    expect(gone.Item).toBeUndefined();
  });

  it("fails the settle's condition when a dispatch commits between its read and its write", async () => {
    const f = createFixtures();
    const table = new FakeTable({ tableName });
    let stores: ReturnType<typeof createAwsStores> | undefined;
    let interleaved = false;
    const client = {
      get: (input: Parameters<FakeTable["get"]>[0]) => table.get(input),
      put: (input: Parameters<FakeTable["put"]>[0]) => table.put(input),
      update: (input: Parameters<FakeTable["update"]>[0]) => table.update(input),
      delete: (input: Parameters<FakeTable["delete"]>[0]) => table.delete(input),
      scan: (input: Parameters<FakeTable["scan"]>[0]) => table.scan(input),
      query: (input: Parameters<FakeTable["query"]>[0]) => table.query(input),
      transactWrite: async (input: Parameters<FakeTable["transactWrite"]>[0]) => {
        const settling = (input.TransactItems ?? []).some(
          (item) => item.ConditionCheck?.Key?.SK === "DISPATCH",
        );
        if (settling && !interleaved) {
          interleaved = true;
          await stores?.dispatches.put(makeDispatch(f));
        }
        return table.transactWrite(input);
      },
    };
    let at = Date.parse("2026-01-01T00:00:00.000Z");
    stores = createAwsStores({
      tableName,
      table: client,
      now: () => new Date(at).toISOString() as IsoTimestamp,
    });
    const holder = makeRun(f, { status: "pending", location: "remote" });
    await stores.runs.put(holder);
    at += 60 * 60 * 1000;
    const fresh = makeRun(f, {
      runId: f.ids.next("run") as typeof holder.runId,
      status: "pending",
      startedAt: "2026-01-01T01:00:00.000Z",
    });
    await expect(stores.runs.put(fresh)).rejects.toMatchObject({ liveRunId: holder.runId });
    expect(interleaved).toBe(true);
    expect(await stores.runs.get(f.scope, holder.runId)).toEqual(holder);
    expect(await stores.runs.get(f.scope, fresh.runId)).toBeUndefined();
    expect(await stores.dispatches.get(f.scope)).toBeDefined();
  });

  describe("legacy live runs and the trusted clock (F-01, F-02)", () => {
    const GRACE = 15 * 60 * 1000;
    const setup = () => {
      let at = Date.parse("2026-01-01T00:00:00.000Z");
      const now = () => new Date(at).toISOString() as IsoTimestamp;
      const table = new FakeTable({ tableName });
      const writes: Array<{ kind: string; item: Record<string, unknown> }> = [];
      const transactions: unknown[][] = [];
      const client = {
        get: (input: Parameters<FakeTable["get"]>[0]) => table.get(input),
        put: (input: Parameters<FakeTable["put"]>[0]) => {
          writes.push({ kind: "put", item: input as unknown as Record<string, unknown> });
          return table.put(input);
        },
        update: (input: Parameters<FakeTable["update"]>[0]) => table.update(input),
        delete: (input: Parameters<FakeTable["delete"]>[0]) => table.delete(input),
        scan: (input: Parameters<FakeTable["scan"]>[0]) => table.scan(input),
        query: (input: Parameters<FakeTable["query"]>[0]) => table.query(input),
        transactWrite: (input: Parameters<FakeTable["transactWrite"]>[0]) => {
          transactions.push(input.TransactItems ?? []);
          return table.transactWrite(input);
        },
      };
      const stores = createAwsStores({ tableName, table: client, now });
      const f = createFixtures();
      const seed = (run: ReturnType<typeof makeRun>) =>
        table.put({ TableName: tableName, Item: { ...run, ...keys.run(f.scope, run.runId) } });
      return {
        f,
        table,
        stores,
        writes,
        transactions,
        seed,
        now,
        advance: (ms: number) => (at += ms),
      };
    };

    it("creates the marker for an adopted legacy run with a conditional put, and refuses", async () => {
      const { f, table, stores, writes, seed } = setup();
      const legacy = makeRun(f, { status: "pending" });
      await seed(legacy);
      const fresh = makeRun(f, { runId: f.ids.next("run") as typeof legacy.runId });
      await expect(stores.runs.put(fresh)).rejects.toMatchObject({ liveRunId: legacy.runId });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.item).toMatchObject({
        ConditionExpression: "attribute_not_exists(#pk)",
        Item: { ...keys.programLiveRun(f.scope), runId: legacy.runId },
      });
      const marker = await table.get({
        TableName: tableName,
        Key: keys.programLiveRun(f.scope),
        ConsistentRead: true,
      });
      expect(marker.Item).toMatchObject({
        runId: legacy.runId,
        claimedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(await stores.runs.get(f.scope, fresh.runId)).toBeUndefined();
    });

    it("settles on the marker's runId and claimedAt being unchanged, at the trusted now", async () => {
      const { f, stores, transactions, advance, now } = setup();
      const holder = makeRun(f, { status: "pending" });
      await stores.runs.put(holder);
      advance(GRACE + 1000);
      const fresh = makeRun(f, {
        runId: f.ids.next("run") as typeof holder.runId,
        startedAt: "2026-01-01T09:00:00.000Z",
      });
      transactions.length = 0;
      await stores.runs.put(fresh);
      const settle = transactions[0] ?? [];
      const markerPut = (settle as Array<{ Put?: { Item?: { SK?: string } } }>).find(
        (item) => item.Put?.Item?.SK === "LIVERUN",
      );
      expect(markerPut).toMatchObject({
        Put: {
          ConditionExpression: "#runId = :holder AND #claimedAt = :claimedAt",
          ExpressionAttributeValues: {
            ":holder": holder.runId,
            ":claimedAt": "2026-01-01T00:00:00.000Z",
          },
          Item: { runId: fresh.runId, claimedAt: now() },
        },
      });
      expect(await stores.runs.get(f.scope, holder.runId)).toMatchObject({
        status: "interrupted",
        endedAt: now(),
      });
    });

    it("does not settle when the marker's claim changed between the read and the write", async () => {
      const { f, table, stores, advance, now } = setup();
      const holder = makeRun(f, { status: "pending" });
      await stores.runs.put(holder);
      advance(GRACE + 1000);
      // Another start re-claimed the marker for the same run id with a later time.
      const original = table.transactWrite.bind(table);
      let raced = false;
      table.transactWrite = async (input) => {
        if (!raced) {
          raced = true;
          await table.put({
            TableName: tableName,
            Item: { ...keys.programLiveRun(f.scope), runId: holder.runId, claimedAt: now() },
          });
        }
        return original(input);
      };
      const fresh = makeRun(f, { runId: f.ids.next("run") as typeof holder.runId });
      await expect(stores.runs.put(fresh)).rejects.toMatchObject({ liveRunId: holder.runId });
      expect(await stores.runs.get(f.scope, holder.runId)).toEqual(holder);
    });

    it("treats a marker without claimedAt as claimed when first read", async () => {
      const { f, table, stores, advance } = setup();
      const holder = makeRun(f, { status: "pending", startedAt: "2025-12-01T00:00:00.000Z" });
      await table.put({
        TableName: tableName,
        Item: { ...holder, ...keys.run(f.scope, holder.runId) },
      });
      await table.put({
        TableName: tableName,
        Item: { ...keys.programLiveRun(f.scope), entity: "ProgramLiveRun", runId: holder.runId },
      });
      advance(GRACE * 10);
      const fresh = makeRun(f, { runId: f.ids.next("run") as typeof holder.runId });
      await expect(stores.runs.put(fresh)).rejects.toMatchObject({ liveRunId: holder.runId });
      advance(GRACE + 1000);
      await stores.runs.put(fresh);
      expect(await stores.runs.get(f.scope, holder.runId)).toMatchObject({ status: "interrupted" });
    });
  });
});
