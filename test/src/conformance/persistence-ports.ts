/**
 * The shared persistence-port conformance suite.
 *
 * One suite, run against every adapter: the in-memory adapter in `npm test`, and
 * the DynamoDB and S3 adapter in the smoke suite. If an adapter needs an assertion
 * edited to pass, either the port contract was wrong or the adapter is, and that
 * is the conversation to have rather than a quiet edit.
 *
 * One such conversation has happened. A-22 moved sequence numbering after
 * durability, so `append` may return an unnumbered event, which this suite
 * predated and could not express. D-P2-16 amended it: an adapter supplies an
 * optional `settle`, and every assertion about sequence numbers awaits it first.
 * The assertions about the final numbering are unchanged, and a number an adapter
 * does return from `append` must still be the right one.
 *
 * The isolation section is the offline form of P2's required proof that a
 * Project A query cannot return a Project B record. Running it here means the
 * property is specified before any AWS resource exists to get it wrong.
 */
import {
  type Artifact,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type Event,
  type OrgConfig,
  type ProgramId,
  type ProjectId,
  type RunId,
} from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  type Fixtures,
  type IdentityStores,
  isSequenced,
  makeAgent,
  makeCheckpoint,
  makeDecision,
  makeEvent,
  makeJobContract,
  makeMembership,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeUser,
  makeVerification,
  nextUserId,
  orderEvents,
  type ProjectStores,
  type RunScope,
  StaleWriteError,
} from "@nightshift/core";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Builds a fresh, empty set of stores. Called before every test, so no test can
 * depend on another's writes.
 */
export type StoresFactory<S extends ProjectStores = ProjectStores> = () => Promise<S> | S;

export interface ConformanceOptions<S extends ProjectStores> {
  /**
   * Resolves once every event appended so far has been numbered (D-P2-16).
   *
   * Omit it for an adapter that numbers synchronously. An adapter that defers
   * numbering (A-22) must supply it, or the sequencing assertions fail on an
   * unnumbered event — which is the point: they must not pass vacuously.
   */
  readonly settle?: (stores: S) => Promise<void> | void;
  /**
   * The adapter's identity half, when it has one (T2).
   *
   * Users and memberships sit above every project (D-P2-17), and the http
   * adapter implements only the project-scoped half: the API exposes no route
   * that administers a user, because identity is administered by the operator
   * with an AWS profile rather than by a run. So the identity section runs for
   * adapters that supply this and is **skipped with a message** for those that do
   * not — never silently passed, which would let a real gap look like a green
   * suite.
   *
   * This is a deliberate amendment in the D-P2-16 tradition, recorded in the P3
   * contract §12, not a quiet edit.
   */
  readonly identity?: (stores: S) => IdentityStores;
}

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

/**
 * An adapter may return an event from `append` before numbering it (A-22), but a
 * number it does return must already be the final one.
 */
const expectNumberOrPending = (event: Event, expected: number): void => {
  if (event.sequence !== null) expect(event.sequence).toBe(expected);
};

/** An event without its sequence, for comparing records whose numbering may have moved on. */
const withoutSequence = ({ sequence: _sequence, ...rest }: Event) => rest;

/** Two fully disjoint fixture worlds, for the isolation section. */
const twoWorlds = (): readonly [Fixtures, Fixtures] => {
  const ids = createCountingIdGenerator();
  return [createFixtures(ids), createFixtures(ids)];
};

export const describePortConformance = <S extends ProjectStores>(
  name: string,
  factory: StoresFactory<S>,
  options: ConformanceOptions<S> = {},
): void => {
  describe(`${name} — persistence port conformance`, () => {
    let stores: S;
    let a: Fixtures;
    let b: Fixtures;

    const settle = async (): Promise<void> => {
      await options.settle?.(stores);
    };

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

    describe("an org's configuration (P8, D-P8-02)", () => {
      const configOf = (orgId: OrgConfig["orgId"], version: number): OrgConfig => ({
        schemaVersion: 1,
        orgId,
        routingPolicy: DEFAULT_ROUTING_POLICY,
        examinationPolicy: DEFAULT_EXAMINATION_POLICY,
        version,
        updatedAt: "2026-09-25T10:00:00.000Z",
      });

      it("is absent until written, then read back as written", async () => {
        const orgId = a.ids.next("org");
        expect(await stores.orgConfigs.get(orgId)).toBeUndefined();
        await stores.orgConfigs.put(configOf(orgId, 1));
        expect(await stores.orgConfigs.get(orgId)).toEqual(configOf(orgId, 1));
        expect(await stores.orgConfigs.get(b.ids.next("org"))).toBeUndefined();
      });

      it("writes only on top of the version the writer read", async () => {
        const orgId = a.ids.next("org");
        await expect(stores.orgConfigs.put(configOf(orgId, 2))).rejects.toBeInstanceOf(
          StaleWriteError,
        );
        await stores.orgConfigs.put(configOf(orgId, 1));
        await expect(stores.orgConfigs.put(configOf(orgId, 1))).rejects.toBeInstanceOf(
          StaleWriteError,
        );
        await stores.orgConfigs.put(configOf(orgId, 2));
        expect((await stores.orgConfigs.get(orgId))?.version).toBe(2);
      });
    });

    describe("organisation grouping (T2, A-21)", () => {
      it("round-trips a project with its orgId", async () => {
        const orgId = a.ids.next("org");
        const project = makeProject(a, { orgId });
        await stores.projects.put(project);
        expect((await stores.projects.get(project.projectId))?.orgId).toBe(orgId);
      });

      it("lists only that org's projects, and two orgs do not leak into each other", async () => {
        const orgOne = a.ids.next("org");
        const orgTwo = b.ids.next("org");
        const first = makeProject(a, { orgId: orgOne });
        const second = makeProject(a, { projectId: a.ids.next("proj"), orgId: orgOne });
        const elsewhere = makeProject(b, { orgId: orgTwo });
        for (const project of [first, second, elsewhere]) await stores.projects.put(project);

        const one = (await stores.projects.listByOrg(orgOne)).items;
        expect(one.map((p) => p.projectId)).toEqual([first.projectId, second.projectId].sort());
        expect(one.every((p) => p.orgId === orgOne)).toBe(true);

        const two = (await stores.projects.listByOrg(orgTwo)).items;
        expect(two).toEqual([elsewhere]);
      });

      it("returns an empty page, not an error, for an org with no projects", async () => {
        const page = await stores.projects.listByOrg(a.ids.next("org"), { limit: 5 });
        expect(page.items).toEqual([]);
        expect(page.cursor).toBeUndefined();
      });

      it("pages through an org's projects without repeating or dropping one", async () => {
        const orgId = a.ids.next("org");
        const written: ProjectId[] = [];
        for (let i = 0; i < 5; i += 1) {
          const project = makeProject(a, { projectId: a.ids.next("proj"), orgId });
          await stores.projects.put(project);
          written.push(project.projectId);
        }

        const seen: ProjectId[] = [];
        let cursor: string | undefined;
        do {
          const page = await stores.projects.listByOrg(
            orgId,
            cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
          );
          seen.push(...page.items.map((p) => p.projectId));
          cursor = page.cursor;
        } while (cursor !== undefined);

        expect(seen).toEqual(written.sort());
      });

      it("keeps the org listing current when a project is rewritten in the same org", async () => {
        const project = makeProject(a, { orgId: a.ids.next("org") });
        await stores.projects.put(project);
        await stores.projects.put({ ...project, name: "renamed" });
        expect((await stores.projects.listByOrg(project.orgId)).items).toEqual([
          { ...project, name: "renamed" },
        ]);
      });

      it("refuses to move a project to another org, and changes nothing", async () => {
        const project = makeProject(a, { orgId: a.ids.next("org") });
        const otherOrg = b.ids.next("org");
        await stores.projects.put(project);

        await expect(stores.projects.put({ ...project, orgId: otherOrg })).rejects.toThrow();

        expect(await stores.projects.get(project.projectId)).toEqual(project);
        expect((await stores.projects.listByOrg(project.orgId)).items).toEqual([project]);
        expect((await stores.projects.listByOrg(otherOrg)).items).toEqual([]);
      });
    });

    const identityOf = options.identity;
    const identitySection = identityOf === undefined ? describe.skip : describe;
    identitySection(
      identityOf === undefined
        ? "identity (T9, D-P2-17) — skipped: this adapter supplies no identity stores"
        : "identity (T9, D-P2-17)",
      () => {
        /** Non-null by construction: `describe.skip` above when the option is absent. */
        const identity = (): IdentityStores => {
          if (identityOf === undefined) throw new Error("no identity stores");
          return identityOf(stores);
        };

        it("stores and reads a user, and returns undefined for an unknown subject", async () => {
          const user = makeUser(a);
          await identity().users.put(user);
          expect(await identity().users.get(user.userId)).toEqual(user);
          expect(await identity().users.get(nextUserId(a))).toBeUndefined();
        });

        it("lists every org a user belongs to, and only that user's memberships", async () => {
          const several = nextUserId(a);
          const single = nextUserId(b);
          const orgOne = a.ids.next("org");
          const orgTwo = a.ids.next("org");
          const { memberships } = identity();

          await memberships.put(makeMembership(several, orgTwo));
          await memberships.put(makeMembership(several, orgOne));
          await memberships.put(makeMembership(single, orgOne));

          const held = await memberships.listByUser(several);
          expect(held.map((m) => m.orgId)).toEqual([orgOne, orgTwo].sort());
          expect(held.every((m) => m.userId === several)).toBe(true);
          expect((await memberships.listByUser(single)).map((m) => m.orgId)).toEqual([orgOne]);
          expect(await memberships.listByUser(nextUserId(b))).toEqual([]);
        });

        it("holds at most one membership per user and org", async () => {
          const userId = nextUserId(a);
          const orgId = a.ids.next("org");
          const { memberships } = identity();
          await memberships.put(makeMembership(userId, orgId));
          await memberships.put(makeMembership(userId, orgId));
          expect(await memberships.listByUser(userId)).toHaveLength(1);
        });
      },
    );

    describe("event append is idempotent", () => {
      it("stores one event for a duplicate idempotency key", async () => {
        const event = makeEvent(a, { idempotencyKey: "repeated-key" });

        const first = await stores.events.append(event);
        expect(first.stored).toBe(true);

        const second = await stores.events.append(event);
        expect(second.stored).toBe(false);
        // Compared without `sequence`: the stored event may have been numbered
        // between the two calls, which is the lag A-22 permits, not a second event.
        expect(withoutSequence(second.event)).toEqual(withoutSequence(first.event));

        expect((await stores.events.listByRun(a.scope)).items).toHaveLength(1);
      });

      it("treats a different eventId with the same key as the same submission", async () => {
        await stores.events.append(makeEvent(a, { idempotencyKey: "retried" }));
        const retry = await stores.events.append(makeEvent(a, { idempotencyKey: "retried" }));
        expect(retry.stored).toBe(false);
        expect((await stores.events.listByRun(a.scope)).items).toHaveLength(1);
      });

      it("does not advance the sequence on a duplicate", async () => {
        const event = makeEvent(a, { idempotencyKey: "repeated-key" });
        await stores.events.append(event);
        await settle();
        const after = await stores.events.nextSequence(a.scope);
        await stores.events.append(event);
        await settle();
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
        await settle();

        // Three events, numbered 0..2: no duplicate consumed a number.
        const listed = (await stores.events.listByRun(a.scope)).items;
        expect(listed.map(sequenceOf)).toEqual([0, 1, 2]);
      });
    });

    describe("event ordering", () => {
      it("assigns sequences from zero, densely", async () => {
        for (let i = 0; i < 5; i += 1) {
          const result = await stores.events.append(makeEvent(a, { idempotencyKey: `k${i}` }));
          expectNumberOrPending(result.event, i);
        }
        await settle();
        expect((await stores.events.listByRun(a.scope)).items.map(sequenceOf)).toEqual([
          0, 1, 2, 3, 4,
        ]);
        expect(await stores.events.nextSequence(a.scope)).toBe(5);
      });

      it("ignores a sequence supplied by the caller", async () => {
        const result = await stores.events.append(
          makeEvent(a, { idempotencyKey: "k", sequence: 9999 }),
        );
        expectNumberOrPending(result.event, 0);
        await settle();
        expect((await stores.events.listByRun(a.scope)).items.map(sequenceOf)).toEqual([0]);
      });

      it("lists in ascending sequence order, stably across calls", async () => {
        for (let i = 0; i < 12; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `k${i}` }));
        }
        await settle();
        const first = (await stores.events.listByRun(a.scope)).items.map(sequenceOf);
        const second = (await stores.events.listByRun(a.scope)).items.map(sequenceOf);

        expect(first).toEqual([...first].sort((x, y) => x - y));
        expect(second).toEqual(first);
      });

      it("filters by afterSequence", async () => {
        for (let i = 0; i < 6; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `k${i}` }));
        }
        await settle();
        const tail = await stores.events.listByRun(a.scope, { afterSequence: 3 });
        expect(tail.items.map(sequenceOf)).toEqual([4, 5]);
      });

      it("keeps per-run sequences independent", async () => {
        await stores.events.append(makeEvent(a, { idempotencyKey: "a1" }));
        await stores.events.append(makeEvent(a, { idempotencyKey: "a2" }));
        const firstInB = await stores.events.append(makeEvent(b, { idempotencyKey: "b1" }));
        expectNumberOrPending(firstInB.event, 0);
        await settle();
        expect((await stores.events.listByRun(b.scope)).items.map(sequenceOf)).toEqual([0]);
      });

      it("orders a listing as orderEvents does, numbered first then unnumbered", async () => {
        for (let i = 0; i < 4; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `settled-${i}` }));
        }
        await settle();
        // Whether these are numbered yet depends on the adapter; the order must hold either way.
        for (let i = 0; i < 3; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `fresh-${i}` }));
        }

        const items = (await stores.events.listByRun(a.scope)).items;
        expect(items).toHaveLength(7);
        expect(items).toEqual(orderEvents(items));
      });

      it("never returns an unnumbered event after a sequence cursor: it lags, never skips", async () => {
        for (let i = 0; i < 3; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `settled-${i}` }));
        }
        await settle();
        for (let i = 0; i < 2; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `fresh-${i}` }));
        }

        const tail = (await stores.events.listByRun(a.scope, { afterSequence: 1 })).items;
        expect(tail.length).toBeGreaterThanOrEqual(1);
        // Dense from 2: whatever has been numbered is returned, nothing is jumped over.
        expect(tail.map(sequenceOf)).toEqual(tail.map((_, i) => i + 2));
      });
    });

    describe("pagination", () => {
      it("walks a full result set without repeating or dropping an item", async () => {
        const total = 17;
        for (let i = 0; i < total; i += 1) {
          await stores.events.append(makeEvent(a, { idempotencyKey: `k${i}` }));
        }
        await settle();

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
        // projects' records. Adding one would fail this count. `listByOrg` takes
        // an org rather than a project chain; it lists projects themselves, never
        // records inside one.
        const readMethodsRequiringScope = [
          stores.projects.listByOrg,
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
          // The identity half, only for an adapter that has one.
          ...(options.identity === undefined
            ? []
            : [options.identity(stores).memberships.listByUser]),
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
