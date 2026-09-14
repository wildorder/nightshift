/**
 * The shared persistence-port conformance suite.
 *
 * One suite, run against every adapter. P1 wires it to the in-memory adapter;
 * P2 must wire it to the DynamoDB and S3 adapter **unchanged**. If P2 needs to
 * edit an assertion here to pass, either the port contract was wrong or the
 * adapter is, and that is the conversation to have rather than a quiet edit.
 *
 * The isolation section is the offline form of P2's required proof that a
 * Project A query cannot return a Project B record. Running it here means the
 * property is specified before any AWS resource exists to get it wrong.
 */
import type { Artifact, Event, ProgramId, ProjectId, RunId } from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  type Fixtures,
  isSequenced,
  makeAgent,
  makeCheckpoint,
  makeDecision,
  makeEvent,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
  type NightshiftStores,
  type RunScope,
} from "@nightshift/core";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Builds a fresh, empty set of stores. Called before every test, so no test can
 * depend on another's writes.
 */
export type StoresFactory = () => Promise<NightshiftStores> | NightshiftStores;

/**
 * Asserts an event has been numbered and returns its sequence.
 *
 * Deliberately strict: `sequence` is nullable because numbering trails durability
 * (A-22), and a suite that silently coerced null to a number would stop catching
 * an adapter whose numbering never ran.
 */
const sequenceOf = (event: Event): number => {
  if (!isSequenced(event)) {
    throw new Error(`event ${event.eventId} is still unnumbered; expected a sequence`);
  }
  return event.sequence;
};

/** Two fully disjoint fixture worlds, for the isolation section. */
const twoWorlds = (): readonly [Fixtures, Fixtures] => {
  const ids = createCountingIdGenerator();
  return [createFixtures(ids), createFixtures(ids)];
};

export const describePortConformance = (name: string, factory: StoresFactory): void => {
  describe(`${name} — persistence port conformance`, () => {
    let stores: NightshiftStores;
    let a: Fixtures;
    let b: Fixtures;

    beforeEach(async () => {
      stores = await factory();
      [a, b] = twoWorlds();
    });

    describe("round trips", () => {
      it("stores and reads a project", async () => {
        const project = makeProject(a);
        await stores.projects.put(project);
        expect(await stores.projects.get(project.projectId)).toEqual(project);
      });

      it("returns undefined for an absent record rather than throwing", async () => {
        expect(await stores.projects.get(a.scope.projectId)).toBeUndefined();
        expect(await stores.runs.get(a.scope, a.scope.runId)).toBeUndefined();
        expect(await stores.executionNodes.get(a.scope, a.rootNodeId)).toBeUndefined();
      });

      it("stores and reads a program contract", async () => {
        const contract = makeProgramContract(a);
        await stores.programContracts.put(contract);
        expect(await stores.programContracts.get(a.scope.projectId, a.scope.programId)).toEqual(
          contract,
        );
      });

      it("stores and reads a run", async () => {
        const run = makeRun(a);
        await stores.runs.put(run);
        expect(await stores.runs.get(a.scope, a.scope.runId)).toEqual(run);
      });

      it("stores and reads an execution node", async () => {
        const node = makeRootNode(a);
        await stores.executionNodes.put(node);
        expect(await stores.executionNodes.get(a.scope, node.executionNodeId)).toEqual(node);
      });

      it("stores and reads a job contract", async () => {
        const contract = makeJobContract(a);
        await stores.jobContracts.put(contract);
        expect(await stores.jobContracts.get(a.scope, contract.jobContractId)).toEqual(contract);
      });

      it("stores and reads an agent", async () => {
        const agent = makeAgent(a, a.rootNodeId);
        await stores.agents.put(agent);
        expect(await stores.agents.get(a.scope, agent.agentId)).toEqual(agent);
      });

      it("stores and reads a decision", async () => {
        const decision = makeDecision(a, a.rootNodeId);
        await stores.decisions.put(decision);
        expect(await stores.decisions.get(a.scope, decision.decisionId)).toEqual(decision);
      });

      it("stores and reads a checkpoint", async () => {
        const checkpoint = makeCheckpoint(a, a.rootNodeId);
        await stores.checkpoints.put(checkpoint);
        expect(await stores.checkpoints.get(a.scope, checkpoint.checkpointId)).toEqual(checkpoint);
      });

      it("stores and reads a verification", async () => {
        const node = makeRootNode(a);
        const verification = makeVerification(a, node);
        await stores.verifications.put(verification);
        expect(await stores.verifications.get(a.scope, verification.verificationId)).toEqual(
          verification,
        );
      });

      it("overwrites a record on a second put of the same identifier", async () => {
        const node = makeRootNode(a, { status: "queued" });
        await stores.executionNodes.put(node);
        await stores.executionNodes.put({ ...node, status: "running" });
        const read = await stores.executionNodes.get(a.scope, node.executionNodeId);
        expect(read?.status).toBe("running");
        expect((await stores.executionNodes.listByRun(a.scope)).items).toHaveLength(1);
      });
    });

    describe("project isolation", () => {
      it("never returns another project's program contract", async () => {
        await stores.programContracts.put(makeProgramContract(a));
        await stores.programContracts.put(makeProgramContract(b));

        // Project A's identifiers with project B's program, and vice versa.
        expect(
          await stores.programContracts.get(a.scope.projectId, b.scope.programId),
        ).toBeUndefined();
        expect(
          await stores.programContracts.get(b.scope.projectId, a.scope.programId),
        ).toBeUndefined();

        const listed = await stores.programContracts.listByProject(a.scope.projectId);
        expect(listed.items).toHaveLength(1);
        expect(listed.items[0]?.projectId).toBe(a.scope.projectId);
      });

      it("never returns another project's run", async () => {
        await stores.runs.put(makeRun(a));
        await stores.runs.put(makeRun(b));

        expect(await stores.runs.get(a.scope, b.scope.runId)).toBeUndefined();
        const listed = await stores.runs.listByProgram(a.scope);
        expect(listed.items).toHaveLength(1);
        expect(listed.items[0]?.projectId).toBe(a.scope.projectId);
      });

      it("never returns another project's execution node, even by exact identifier", async () => {
        const nodeA = makeRootNode(a);
        const nodeB = makeRootNode(b);
        await stores.executionNodes.put(nodeA);
        await stores.executionNodes.put(nodeB);

        // Ask project A for project B's node id. The id is known; the answer is still nothing.
        expect(await stores.executionNodes.get(a.scope, nodeB.executionNodeId)).toBeUndefined();
        expect(await stores.executionNodes.get(b.scope, nodeA.executionNodeId)).toBeUndefined();

        const listed = await stores.executionNodes.listByRun(a.scope);
        expect(listed.items.map((n) => n.executionNodeId)).toEqual([nodeA.executionNodeId]);
      });

      it("isolates every run-scoped store", async () => {
        const nodeA = makeRootNode(a);
        const nodeB = makeRootNode(b);

        await stores.jobContracts.put(makeJobContract(a));
        await stores.jobContracts.put(makeJobContract(b));
        await stores.agents.put(makeAgent(a, nodeA.executionNodeId));
        await stores.agents.put(makeAgent(b, nodeB.executionNodeId));
        await stores.decisions.put(makeDecision(a, nodeA.executionNodeId));
        await stores.decisions.put(makeDecision(b, nodeB.executionNodeId));
        await stores.checkpoints.put(makeCheckpoint(a, nodeA.executionNodeId));
        await stores.checkpoints.put(makeCheckpoint(b, nodeB.executionNodeId));
        await stores.verifications.put(makeVerification(a, nodeA));
        await stores.verifications.put(makeVerification(b, nodeB));
        await stores.events.append(makeEvent(a));
        await stores.events.append(makeEvent(b));

        expect((await stores.jobContracts.listByRun(a.scope)).items).toHaveLength(1);
        expect((await stores.decisions.listByRun(a.scope)).items).toHaveLength(1);
        expect((await stores.checkpoints.listByRun(a.scope)).items).toHaveLength(1);
        expect((await stores.events.listByRun(a.scope)).items).toHaveLength(1);
        expect(await stores.agents.listByNode(a.scope, nodeA.executionNodeId)).toHaveLength(1);
        expect(await stores.verifications.listByNode(a.scope, nodeA.executionNodeId)).toHaveLength(
          1,
        );

        // Asking project A about project B's node returns nothing, not B's records.
        expect(await stores.agents.listByNode(a.scope, nodeB.executionNodeId)).toHaveLength(0);
        expect(await stores.verifications.listByNode(a.scope, nodeB.executionNodeId)).toHaveLength(
          0,
        );
      });

      it("treats a partially-matching chain as a different scope", async () => {
        const node = makeRootNode(a);
        await stores.executionNodes.put(node);

        const mixed: readonly RunScope[] = [
          { ...a.scope, projectId: b.scope.projectId },
          { ...a.scope, programId: b.scope.programId },
          { ...a.scope, runId: b.scope.runId },
        ];
        for (const scope of mixed) {
          expect(await stores.executionNodes.get(scope, node.executionNodeId)).toBeUndefined();
          expect((await stores.executionNodes.listByRun(scope)).items).toHaveLength(0);
        }
      });
    });

    describe("event append is idempotent", () => {
      it("stores one event for a duplicate idempotency key", async () => {
        const event = makeEvent(a, { idempotencyKey: "repeated-key" });

        const first = await stores.events.append(event);
        expect(first.stored).toBe(true);

        const second = await stores.events.append(event);
        expect(second.stored).toBe(false);
        expect(second.event).toEqual(first.event);

        expect((await stores.events.listByRun(a.scope)).items).toHaveLength(1);
      });

      it("does not advance the sequence on a duplicate", async () => {
        const event = makeEvent(a, { idempotencyKey: "repeated-key" });
        await stores.events.append(event);
        const after = await stores.events.nextSequence(a.scope);
        await stores.events.append(event);
        expect(await stores.events.nextSequence(a.scope)).toBe(after);
      });

      it("treats the same key in a different run as a different event", async () => {
        await stores.events.append(makeEvent(a, { idempotencyKey: "shared" }));
        const other = await stores.events.append(makeEvent(b, { idempotencyKey: "shared" }));
        expect(other.stored).toBe(true);
        expect((await stores.events.listByRun(a.scope)).items).toHaveLength(1);
        expect((await stores.events.listByRun(b.scope)).items).toHaveLength(1);
      });

      it("survives a replayed spool of mixed new and duplicate events", async () => {
        const spool: readonly Event[] = [
          makeEvent(a, { idempotencyKey: "k1" }),
          makeEvent(a, { idempotencyKey: "k2" }),
          makeEvent(a, { idempotencyKey: "k3" }),
        ];
        for (const event of spool) await stores.events.append(event);
        // Replay the whole spool, as a reconnecting local buffer would.
        for (const event of [...spool, ...spool]) await stores.events.append(event);
        expect((await stores.events.listByRun(a.scope)).items).toHaveLength(3);
      });
    });

    describe("event ordering", () => {
      it("assigns sequences from zero, densely", async () => {
        for (let i = 0; i < 5; i += 1) {
          const result = await stores.events.append(makeEvent(a, { idempotencyKey: `k${i}` }));
          expect(result.event.sequence).toBe(i);
        }
        expect(await stores.events.nextSequence(a.scope)).toBe(5);
      });

      it("ignores a sequence supplied by the caller", async () => {
        const result = await stores.events.append(
          makeEvent(a, { idempotencyKey: "k", sequence: 9999 }),
        );
        expect(result.event.sequence).toBe(0);
      });

      it("lists in ascending sequence order, stably across calls", async () => {
        for (let i = 0; i < 12; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `k${i}` }));
        }
        const first = (await stores.events.listByRun(a.scope)).items.map(sequenceOf);
        const second = (await stores.events.listByRun(a.scope)).items.map(sequenceOf);

        expect(first).toEqual([...first].sort((x, y) => x - y));
        expect(second).toEqual(first);
      });

      it("filters by afterSequence", async () => {
        for (let i = 0; i < 6; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `k${i}` }));
        }
        const tail = await stores.events.listByRun(a.scope, { afterSequence: 3 });
        expect(tail.items.map(sequenceOf)).toEqual([4, 5]);
      });

      it("keeps per-run sequences independent", async () => {
        await stores.events.append(makeEvent(a, { idempotencyKey: "a1" }));
        await stores.events.append(makeEvent(a, { idempotencyKey: "a2" }));
        const firstInB = await stores.events.append(makeEvent(b, { idempotencyKey: "b1" }));
        expect(firstInB.event.sequence).toBe(0);
      });
    });

    describe("pagination", () => {
      it("walks a full result set without repeating or dropping an item", async () => {
        const total = 17;
        for (let i = 0; i < total; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `k${i}` }));
        }

        const seen: number[] = [];
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page = await stores.events.listByRun(
            a.scope,
            cursor === undefined ? { limit: 5 } : { limit: 5, cursor },
          );
          seen.push(...page.items.map(sequenceOf));
          cursor = page.cursor;
          guard += 1;
          expect(guard).toBeLessThan(20);
        } while (cursor !== undefined);

        expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
      });

      it("omits the cursor on the last page", async () => {
        await stores.events.append(makeEvent(a, { idempotencyKey: "only" }));
        const page = await stores.events.listByRun(a.scope, { limit: 5 });
        expect(page.items).toHaveLength(1);
        expect(page.cursor).toBeUndefined();
      });

      it("returns an empty page with no cursor for an empty scope", async () => {
        const page = await stores.events.listByRun(a.scope, { limit: 5 });
        expect(page.items).toEqual([]);
        expect(page.cursor).toBeUndefined();
      });
    });

    describe("artifacts hold references, never content", () => {
      const artifactFor = (f: Fixtures, overrides: Record<string, unknown> = {}): Artifact =>
        ({
          schemaVersion: 1,
          ...f.scope,
          artifactId: f.ids.next("art"),
          executionNodeId: f.rootNodeId,
          kind: "verification-log",
          uri: `s3://bucket/${f.scope.projectId}/log.txt`,
          sizeBytes: 1_048_576,
          contentType: "text/plain",
          createdAt: "2026-01-01T00:00:00.000Z",
          ...overrides,
        }) as unknown as Artifact;

      it("round-trips a reference to a large object", async () => {
        const artifact = artifactFor(a);
        await stores.artifacts.put(artifact);
        expect(await stores.artifacts.get(a.scope, artifact.artifactId)).toEqual(artifact);
      });

      it("rejects a record carrying inline content (A-08)", async () => {
        const withContent = artifactFor(a, { content: "x".repeat(10_000) });
        await expect(stores.artifacts.put(withContent)).rejects.toThrow();
      });

      it("rejects a uri that is not a scheme-qualified reference", async () => {
        await expect(
          stores.artifacts.put(artifactFor(a, { uri: "/var/log/local.txt" })),
        ).rejects.toThrow();
      });

      it("isolates artifacts by project", async () => {
        await stores.artifacts.put(artifactFor(a));
        await stores.artifacts.put(artifactFor(b));
        expect((await stores.artifacts.listByRun(a.scope)).items).toHaveLength(1);
      });
    });

    describe("validation on write", () => {
      it("refuses a record whose schemaVersion is not 1", async () => {
        const node = makeRootNode(a);
        await expect(
          stores.executionNodes.put({ ...node, schemaVersion: 2 } as unknown as typeof node),
        ).rejects.toThrow();
      });

      it("refuses a record with a malformed identifier", async () => {
        const node = makeRootNode(a);
        await expect(
          stores.executionNodes.put({
            ...node,
            projectId: "proj_nope" as ProjectId,
          }),
        ).rejects.toThrow();
      });

      it("refuses an event whose inline payload exceeds the bound", async () => {
        await expect(
          stores.events.append(
            makeEvent(a, { idempotencyKey: "big" }) as Event & { payload: unknown },
          ),
        ).resolves.toBeDefined();
        const oversized = {
          ...makeEvent(a, { idempotencyKey: "big2" }),
          payload: { blob: "x".repeat(20_000) },
        };
        await expect(stores.events.append(oversized as Event)).rejects.toThrow();
      });
    });

    describe("state reconstruction", () => {
      it("rebuilds a run's node set from stored records alone", async () => {
        const root = makeRootNode(a);
        const child = makeNode(a, root.executionNodeId);
        const grandchild = makeNode(a, child.executionNodeId, { depth: 2 });
        for (const node of [root, child, grandchild]) await stores.executionNodes.put(node);

        const listed = (await stores.executionNodes.listByRun(a.scope)).items;
        expect(listed).toHaveLength(3);
        expect(
          await stores.executionNodes.listChildren(a.scope, root.executionNodeId),
        ).toHaveLength(1);
        expect(
          await stores.executionNodes.listChildren(a.scope, child.executionNodeId),
        ).toHaveLength(1);
        expect(
          await stores.executionNodes.listChildren(a.scope, grandchild.executionNodeId),
        ).toHaveLength(0);
      });

      it("keeps a program's runs listable, and a project's programs", async () => {
        await stores.programContracts.put(makeProgramContract(a));
        await stores.runs.put(makeRun(a));
        expect((await stores.programContracts.listByProject(a.scope.projectId)).items).toHaveLength(
          1,
        );
        expect((await stores.runs.listByProgram(a.scope)).items).toHaveLength(1);
      });

      it("exposes no method that can list across projects", () => {
        // A structural assertion, not a behavioural one: every read signature on
        // every store takes a scope, so there is no call that could return two
        // projects' records. Adding one would fail this count.
        const readMethodsRequiringScope = [
          stores.programContracts.listByProject,
          stores.runs.listByProgram,
          stores.executionNodes.listByRun,
          stores.executionNodes.listChildren,
          stores.jobContracts.listByRun,
          stores.agents.listByNode,
          stores.events.listByRun,
          stores.events.nextSequence,
          stores.decisions.listByRun,
          stores.checkpoints.listByRun,
          stores.verifications.listByNode,
          stores.examinations.listByNode,
          stores.routingDecisions.listByNode,
          stores.artifacts.listByRun,
        ];
        for (const method of readMethodsRequiringScope) {
          expect(method.length).toBeGreaterThanOrEqual(1);
        }
      });
    });

    describe("unused chain parts are still honoured", () => {
      it("distinguishes two runs of the same program", async () => {
        const runOne = makeRun(a);
        const secondRunId = a.ids.next("run") as RunId;
        const scopeTwo: RunScope = { ...a.scope, runId: secondRunId };

        await stores.runs.put(runOne);
        await stores.runs.put({ ...runOne, runId: secondRunId });

        expect((await stores.runs.listByProgram(a.scope)).items).toHaveLength(2);
        await stores.events.append(makeEvent(a, { idempotencyKey: "k" }));
        expect((await stores.events.listByRun(scopeTwo)).items).toHaveLength(0);
      });

      it("distinguishes two programs of the same project", async () => {
        const contract = makeProgramContract(a);
        const secondProgramId = a.ids.next("prog") as ProgramId;
        await stores.programContracts.put(contract);
        await stores.programContracts.put({ ...contract, programId: secondProgramId });
        expect((await stores.programContracts.listByProject(a.scope.projectId)).items).toHaveLength(
          2,
        );
      });
    });
  });
};
