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
  type IsoTimestamp,
  type MeasurementSummary,
  type OrgConfig,
  type PlanDraft,
  type ProgramId,
  type ProjectId,
  type Run,
  type RunId,
} from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  type Fixtures,
  type IdentityStores,
  IllegalTransitionError,
  isSequenced,
  makeAgent,
  makeCheckpoint,
  makeCompletionHistory,
  makeComputeUtilization,
  makeDecision,
  makeDispatch,
  makeEvent,
  makeGateHealth,
  makeJobContract,
  makeMembership,
  makeNode,
  makeOrgCredential,
  makePlanDraft,
  makePlanDraftVersion,
  makeProgramContract,
  makeProject,
  makeProjectSecret,
  makeRootNode,
  makeRun,
  makeRunFeedback,
  makeUser,
  makeVerification,
  makeWarmCache,
  NEVER_STARTED_GRACE,
  nextUserId,
  orderEvents,
  PlanDraftError,
  ProgramContractExistsError,
  ProgramRunLiveError,
  type ProjectStores,
  type RunScope,
  StaleWriteError,
  VerificationExistsError,
} from "@nightshift/core";
import { beforeEach, describe, expect, it } from "vitest";

export { describeLinePortConformance } from "./line-ports.js";

/**
 * Builds a fresh, empty set of stores. Called before every test, so no test can
 * depend on another's writes.
 */
export type StoresFactory<S extends ProjectStores = ProjectStores> = (
  clock: ConformanceClock,
) => Promise<S> | S;

/**
 * The store's trusted clock (F-02). The factory hands `now` to the adapter as its
 * clock; a test moves it with `set` and `advance`. A run's `startedAt` is the
 * client's word and never decides a liveness question.
 */
export interface ConformanceClock {
  now(): IsoTimestamp;
  set(at: IsoTimestamp): void;
  advance(ms: number): void;
}

const CLOCK_START = "2026-01-01T00:00:00.000Z" as IsoTimestamp;

const createConformanceClock = (): ConformanceClock => {
  let at = Date.parse(CLOCK_START);
  return {
    now: () => new Date(at).toISOString() as IsoTimestamp,
    set: (value) => {
      at = Date.parse(value);
    },
    advance: (ms) => {
      at += ms;
    },
  };
};

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
  /**
   * Stores a run the way a version without the live-run marker did: the run
   * record, below `RunStore.put`, with no marker beside it. Omit it for an adapter
   * that cannot be seeded that way; the legacy-run tests are then skipped.
   */
  readonly seedLegacyRun?: (stores: S, run: Run) => Promise<void> | void;
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
    let clock: ConformanceClock;
    let a: Fixtures;
    let b: Fixtures;

    const settle = async (): Promise<void> => {
      await options.settle?.(stores);
    };

    beforeEach(async () => {
      clock = createConformanceClock();
      stores = await factory(clock);
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

      it("refuses a second, different put of a verification and keeps the first", async () => {
        const node = makeRootNode(a);
        const verification = makeVerification(a, node);
        await stores.verifications.put(verification);
        await expect(
          stores.verifications.put({
            ...verification,
            endedAt: "2031-01-01T00:00:00.000Z",
          }),
        ).rejects.toThrow(VerificationExistsError);
        expect(await stores.verifications.get(a.scope, verification.verificationId)).toEqual(
          verification,
        );
        expect(await stores.verifications.listByNode(a.scope, node.executionNodeId)).toEqual([
          verification,
        ]);
      });

      it("accepts an identical second put of a verification", async () => {
        const node = makeRootNode(a);
        const verification = makeVerification(a, node);
        await stores.verifications.put(verification);
        await stores.verifications.put({ ...verification });
        expect(await stores.verifications.listByNode(a.scope, node.executionNodeId)).toEqual([
          verification,
        ]);
      });

      it("accepts an identical retry of a verification with explicitly-undefined optional fields", async () => {
        const node = makeRootNode(a);
        const base = makeVerification(a, node, { gateFingerprint: undefined });
        const verification = {
          ...base,
          commands: base.commands.map((command) => ({
            ...command,
            quietMs: undefined,
          })),
        };
        await stores.verifications.put(verification);
        await stores.verifications.put({ ...verification });
        await stores.verifications.put(makeVerification(a, node, { ...verification }));
        expect(await stores.verifications.listByNode(a.scope, node.executionNodeId)).toHaveLength(
          1,
        );
        await expect(
          stores.verifications.put({
            ...verification,
            endedAt: "2031-01-01T00:00:00.000Z",
          }),
        ).rejects.toThrow(VerificationExistsError);
        await expect(
          stores.verifications.put({
            ...verification,
            commands: verification.commands.map((command) => ({
              ...command,
              quietMs: 5,
            })),
          }),
        ).rejects.toThrow(VerificationExistsError);
        const kept = await stores.verifications.get(a.scope, verification.verificationId);
        expect(kept?.endedAt).toEqual(verification.endedAt);
        expect(kept?.commands[0]?.quietMs).toBeUndefined();
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

    describe("a program contract changed in place (P16, D-08)", () => {
      it("changes nothing, and calls nothing, when no contract is stored", async () => {
        let called = false;
        const result = await stores.programContracts.update(
          a.scope.projectId,
          a.scope.programId,
          (current) => {
            called = true;
            return current;
          },
        );
        expect(result).toBeUndefined();
        expect(called).toBe(false);
      });

      it("stores the change and returns it; a change of undefined leaves the contract", async () => {
        const contract = makeProgramContract(a);
        await stores.programContracts.put(contract);
        const changed = await stores.programContracts.update(
          a.scope.projectId,
          a.scope.programId,
          (current) => ({ ...current, outOfScope: ["a UI"] }),
        );
        expect(changed?.outOfScope).toEqual(["a UI"]);
        expect(
          (await stores.programContracts.get(a.scope.projectId, a.scope.programId))?.outOfScope,
        ).toEqual(["a UI"]);
        const left = await stores.programContracts.update(
          a.scope.projectId,
          a.scope.programId,
          () => undefined,
        );
        expect(left).toEqual(changed);
        // A plain put still replaces the whole contract, and update still works after it.
        await stores.programContracts.put(contract);
        await stores.programContracts.update(a.scope.projectId, a.scope.programId, (current) => ({
          ...current,
          outOfScope: ["a CLI"],
        }));
        expect(
          (await stores.programContracts.get(a.scope.projectId, a.scope.programId))?.outOfScope,
        ).toEqual(["a CLI"]);
      });

      it("creates a contract only where none is stored, and refuses a second", async () => {
        const contract = makeProgramContract(a);
        await stores.programContracts.create(contract);
        expect(await stores.programContracts.get(a.scope.projectId, a.scope.programId)).toEqual(
          contract,
        );
        await expect(
          stores.programContracts.create({ ...contract, outOfScope: ["a UI"] }),
        ).rejects.toThrow(ProgramContractExistsError);
        expect(await stores.programContracts.get(a.scope.projectId, a.scope.programId)).toEqual(
          contract,
        );
      });

      it("lets exactly one of racing creates land", async () => {
        const contract = makeProgramContract(a);
        const outcomes = await Promise.allSettled(
          ["one", "two", "three"].map((writer) =>
            stores.programContracts.create({
              ...contract,
              outOfScope: [writer],
            }),
          ),
        );
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            expect(outcome.reason).toBeInstanceOf(ProgramContractExistsError);
          }
        }
      });

      it("lands every one of overlapping changes: none undoes another", async () => {
        await stores.programContracts.put(makeProgramContract(a));
        const writers = ["one", "two", "three", "four"];
        await Promise.all(
          writers.map((writer) =>
            stores.programContracts.update(a.scope.projectId, a.scope.programId, (current) => ({
              ...current,
              outOfScope: [...(current.outOfScope ?? []), writer],
            })),
          ),
        );
        const stored = await stores.programContracts.get(a.scope.projectId, a.scope.programId);
        expect([...(stored?.outOfScope ?? [])].sort()).toEqual([...writers].sort());
      });
    });

    describe("a plan draft and its versions (P21)", () => {
      let projectId: ProjectId;
      let programId: ProgramId;
      beforeEach(() => {
        ({ projectId, programId } = a.scope);
      });
      const draftAt = (latestVersion: number) => makePlanDraft(a, { latestVersion });
      const versionAt = (version: number, planBytes = version) =>
        makePlanDraftVersion(a, {
          version,
          plan: {
            uri: `s3://plans/plan-${version}.md`,
            sha256: "2".repeat(64),
            sizeBytes: planBytes,
          },
        });
      /** The draft once `version` is appended, as the plan-draft rules make it. */
      const appendOf = (current: PlanDraft | undefined, version: number): PlanDraft => {
        if (current?.state === "declined") throw new PlanDraftError("declined", "declined");
        if ((current?.latestVersion ?? 0) !== version - 1) {
          throw new PlanDraftError("stale_base", "stale");
        }
        return {
          ...(current ?? draftAt(version)),
          state: "draft",
          latestVersion: version,
        };
      };
      const append = (version: number, planBytes = version) =>
        stores.planDrafts.appendVersion(versionAt(version, planBytes), (current) =>
          appendOf(current, version),
        );

      it("is absent until a first version is appended", async () => {
        expect(await stores.planDrafts.get(projectId, programId)).toBeUndefined();
        expect(await stores.planDrafts.getVersion(projectId, programId, 1)).toBeUndefined();
        expect((await stores.planDrafts.listVersions(projectId, programId)).items).toEqual([]);
        expect(
          await stores.planDrafts.update(projectId, programId, (current) => current),
        ).toBeUndefined();
      });

      it("stores version 1 with its draft and reads both back", async () => {
        await append(1);
        expect(await stores.planDrafts.get(projectId, programId)).toEqual(draftAt(1));
        expect(await stores.planDrafts.getVersion(projectId, programId, 1)).toEqual(versionAt(1));
      });

      it("refuses a first version that is not number 1, storing nothing", async () => {
        await expect(append(2)).rejects.toBeInstanceOf(PlanDraftError);
        expect(await stores.planDrafts.get(projectId, programId)).toBeUndefined();
        expect(await stores.planDrafts.getVersion(projectId, programId, 2)).toBeUndefined();
      });

      it("keeps a stored version immutable: appending its number again is refused", async () => {
        await append(1);
        await append(2);
        const different = append(2, 999);
        await expect(different).rejects.toBeInstanceOf(PlanDraftError);
        await expect(append(1)).rejects.toBeInstanceOf(PlanDraftError);
        expect(await stores.planDrafts.getVersion(projectId, programId, 2)).toEqual(versionAt(2));
        expect(await stores.planDrafts.getVersion(projectId, programId, 1)).toEqual(versionAt(1));
        expect((await stores.planDrafts.get(projectId, programId))?.latestVersion).toBe(2);
      });

      it("refuses version n when the latest is not n-1, storing nothing", async () => {
        await append(1);
        await expect(append(3)).rejects.toBeInstanceOf(PlanDraftError);
        expect(await stores.planDrafts.getVersion(projectId, programId, 3)).toBeUndefined();
        expect((await stores.planDrafts.get(projectId, programId))?.latestVersion).toBe(1);
      });

      it("refuses a draft that does not describe the version", async () => {
        await expect(
          stores.planDrafts.appendVersion(versionAt(1), () => draftAt(2)),
        ).rejects.toBeInstanceOf(PlanDraftError);
        expect(await stores.planDrafts.get(projectId, programId)).toBeUndefined();
      });

      it("leaves exactly one of two concurrent appends of the same number", async () => {
        await append(1);
        const results = await Promise.allSettled([append(2, 111), append(2, 222)]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const lost = results.find((r) => r.status === "rejected");
        expect(lost?.status === "rejected" && lost.reason).toBeInstanceOf(PlanDraftError);
        const winner = results.findIndex((r) => r.status === "fulfilled") === 0 ? 111 : 222;
        const stored = await stores.planDrafts.getVersion(projectId, programId, 2);
        expect(stored?.plan.sizeBytes).toBe(winner);
        expect((await stores.planDrafts.listVersions(projectId, programId)).items).toHaveLength(2);
      });

      const actBy = (kind: "declined" | "changes_requested") => (current: PlanDraft) => ({
        ...current,
        state: kind === "declined" ? ("declined" as const) : ("draft" as const),
        acts: [
          ...current.acts,
          {
            kind,
            version: current.latestVersion,
            by: versionAt(1).author,
            at: current.updatedAt,
          },
        ],
      });

      it("refuses an append computed before a decline, leaving the draft declined with its act", async () => {
        await append(1);
        const read = await stores.planDrafts.get(projectId, programId);
        await stores.planDrafts.update(projectId, programId, actBy("declined"));
        const declined = await stores.planDrafts.get(projectId, programId);
        await expect(
          stores.planDrafts.appendVersion(versionAt(2), (current) => {
            expect(current?.latestVersion).toBe(read?.latestVersion);
            return appendOf(current, 2);
          }),
        ).rejects.toBeInstanceOf(PlanDraftError);
        expect(await stores.planDrafts.get(projectId, programId)).toEqual(declined);
        expect(declined?.state).toBe("declined");
        expect(declined?.acts.map((act) => act.kind)).toEqual(["declined"]);
        expect(await stores.planDrafts.getVersion(projectId, programId, 2)).toBeUndefined();
      });

      it("keeps a changes_requested act recorded between the read and the append", async () => {
        await append(1);
        await stores.planDrafts.update(projectId, programId, actBy("changes_requested"));
        await append(2);
        const stored = await stores.planDrafts.get(projectId, programId);
        expect(stored?.latestVersion).toBe(2);
        expect(stored?.acts.map((act) => act.kind)).toEqual(["changes_requested"]);
        expect(await stores.planDrafts.getVersion(projectId, programId, 2)).toEqual(versionAt(2));
      });

      it("lists versions in order, and pages them", async () => {
        for (let n = 1; n <= 11; n++) await append(n);
        const listed = await stores.planDrafts.listVersions(projectId, programId);
        expect(listed.items.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        const seen: number[] = [];
        let cursor: string | undefined;
        do {
          const page = await stores.planDrafts.listVersions(projectId, programId, {
            limit: 4,
            ...(cursor === undefined ? {} : { cursor }),
          });
          seen.push(...page.items.map((v) => v.version));
          cursor = page.cursor;
        } while (cursor !== undefined);
        expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      });

      it("updates the draft with an act, and a change of undefined leaves it", async () => {
        await append(1);
        const act = {
          kind: "awaiting_owner" as const,
          version: 1,
          by: makePlanDraftVersion(a).author,
          at: "2026-01-01T00:05:00.000Z",
        };
        const changed = await stores.planDrafts.update(projectId, programId, (current) => ({
          ...current,
          state: "awaiting_owner",
          acts: [...current.acts, act],
        }));
        expect(changed?.state).toBe("awaiting_owner");
        expect(await stores.planDrafts.get(projectId, programId)).toEqual(changed);
        const left = await stores.planDrafts.update(projectId, programId, () => undefined);
        expect(left).toEqual(changed);
      });

      it("applies every one of overlapping acts: none undoes another", async () => {
        await append(1);
        const by = makePlanDraftVersion(a).author;
        const notes = ["one", "two", "three", "four"];
        await Promise.all(
          notes.map((note) =>
            stores.planDrafts.update(projectId, programId, (current) => ({
              ...current,
              acts: [
                ...current.acts,
                {
                  kind: "changes_requested",
                  version: 1,
                  by,
                  note,
                  at: "2026-01-01T00:05:00.000Z",
                },
              ],
            })),
          ),
        );
        const stored = await stores.planDrafts.get(projectId, programId);
        expect(stored?.acts.map((act) => act.note).sort()).toEqual([...notes].sort());
      });

      it("changes nothing when the change throws, and refuses to move the latest version", async () => {
        await append(1);
        await expect(
          stores.planDrafts.update(projectId, programId, () => {
            throw new Error("refused");
          }),
        ).rejects.toThrow("refused");
        await expect(
          stores.planDrafts.update(projectId, programId, (current) => ({
            ...current,
            latestVersion: 5,
          })),
        ).rejects.toBeInstanceOf(PlanDraftError);
        expect(await stores.planDrafts.get(projectId, programId)).toEqual(draftAt(1));
      });

      it("reserves a name for one program: of two concurrent first claims exactly one lands", async () => {
        const other = b.scope.programId;
        const claim = (programId: ProgramId) =>
          stores.planDrafts.appendVersion(makePlanDraftVersion(a, { programId, version: 1 }), () =>
            makePlanDraft(a, {
              programId,
              name: "shared-name",
              latestVersion: 1,
            }),
          );
        const results = await Promise.allSettled([claim(programId), claim(other)]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const lost = results.find((r) => r.status === "rejected");
        expect(lost?.status === "rejected" && lost.reason).toBeInstanceOf(PlanDraftError);
        expect(lost?.status === "rejected" && (lost.reason as PlanDraftError).reason).toBe(
          "name_taken",
        );
        const winner = results[0]?.status === "fulfilled" ? programId : other;
        const loser = winner === programId ? other : programId;
        expect(await stores.planDrafts.get(projectId, loser)).toBeUndefined();
        expect(await stores.planDrafts.getVersion(projectId, loser, 1)).toBeUndefined();
        expect((await stores.planDrafts.get(projectId, winner))?.name).toBe("shared-name");
        // The holder may append again under its own name.
        await stores.planDrafts.appendVersion(
          makePlanDraftVersion(a, { programId: winner, version: 2 }),
          (current) => ({ ...(current as PlanDraft), latestVersion: 2 }),
        );
        expect((await stores.planDrafts.get(projectId, winner))?.latestVersion).toBe(2);
      });

      it("keeps one project's drafts from another's", async () => {
        await append(1);
        await stores.planDrafts.appendVersion(makePlanDraftVersion(b), () => makePlanDraft(b));
        expect((await stores.planDrafts.listByProject(projectId)).items).toEqual([draftAt(1)]);
        expect((await stores.planDrafts.listByProject(b.scope.projectId)).items).toEqual([
          makePlanDraft(b),
        ]);
        expect(await stores.planDrafts.get(b.scope.projectId, programId)).toBeUndefined();
        expect(await stores.planDrafts.getVersion(projectId, b.scope.programId, 1)).toBeUndefined();
      });
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

    describe("the remote runner's records (P10)", () => {
      it("stores one dispatch per run, read by the run's scope and by no other", async () => {
        await stores.runs.put(makeRun(a, { status: "pending" }));
        const dispatch = makeDispatch(a);
        await stores.dispatches.put(dispatch);
        expect(await stores.dispatches.get(a.scope)).toEqual(dispatch);
        expect(await stores.dispatches.get(b.scope)).toBeUndefined();
        const moved = {
          ...dispatch,
          status: "running" as const,
          generation: 2,
        };
        await stores.dispatches.put(moved);
        expect(await stores.dispatches.get(a.scope)).toEqual(moved);
      });

      it("lists a project's utilization records newest run first, and only that project's", async () => {
        const older = makeComputeUtilization(a);
        const newerScope: RunScope = {
          ...a.scope,
          runId: a.ids.next("run") as RunId,
        };
        const newer = makeComputeUtilization(a, {
          ...newerScope,
          tier: "better",
        });
        await stores.computeUtilizations.put(older);
        await stores.computeUtilizations.put(newer);
        await stores.computeUtilizations.put(makeComputeUtilization(b));
        expect(await stores.computeUtilizations.get(a.scope)).toEqual(older);
        expect(await stores.computeUtilizations.get(newerScope)).toEqual(newer);
        const listed = (await stores.computeUtilizations.listByProject(a.scope.projectId)).items;
        expect(listed.map((record) => record.runId)).toEqual([newer.runId, older.runId]);
        expect(await stores.computeUtilizations.get(b.scope)).toBeDefined();
      });

      it("keeps one warm snapshot per project and architecture", async () => {
        const cache = makeWarmCache(a);
        await stores.warmCaches.put(cache);
        expect(await stores.warmCaches.get(a.scope.projectId, cache.architecture)).toEqual(cache);
        expect(await stores.warmCaches.get(b.scope.projectId, cache.architecture)).toBeUndefined();
        const other = cache.architecture === "arm64" ? "x86_64" : "arm64";
        expect(await stores.warmCaches.get(a.scope.projectId, other)).toBeUndefined();
      });

      it("refuses a record that is not what its schema says", async () => {
        await expect(
          stores.dispatches.put({ ...makeDispatch(a), generation: 0 } as never),
        ).rejects.toThrow();
        await expect(
          stores.warmCaches.put({
            ...makeWarmCache(a),
            architecture: "x86",
          } as never),
        ).rejects.toThrow();
      });
    });

    describe("a project's gate health (P15, D-P15-07)", () => {
      it("round trips a project's record, and answers undefined for a project with none", async () => {
        expect(await stores.gateHealth.get(a.scope.projectId)).toBeUndefined();
        const record = makeGateHealth(a);
        await stores.gateHealth.put(record);
        expect(await stores.gateHealth.get(a.scope.projectId)).toEqual(record);
      });

      it("keeps one record per project: a put replaces it", async () => {
        await stores.gateHealth.put(makeGateHealth(a));
        const repairing = makeGateHealth(a, {
          verdict: "repairing",
          commit: "2222222222222222222222222222222222222222",
          findings: [
            {
              id: "F-01",
              rule: 5,
              found: "a fixed sleep",
              decisionId: "D-01",
              paths: ["test/a.ts"],
            },
          ],
          machinery: ["package.json", "test/a.ts"],
          auditedAt: "2026-01-02T00:00:00.000Z",
        });
        await stores.gateHealth.put(repairing);
        expect(await stores.gateHealth.get(a.scope.projectId)).toEqual(repairing);
        const healthy = makeGateHealth(a, { fingerprint: "1".repeat(64) });
        await stores.gateHealth.put(healthy);
        expect(await stores.gateHealth.get(a.scope.projectId)).toEqual(healthy);
      });

      it("never answers one project's record for another", async () => {
        const mine = makeGateHealth(a);
        const theirs = makeGateHealth(b, {
          verdict: "repairing",
          findings: [
            {
              id: "F-01",
              rule: 3,
              found: "shared dist/",
              decisionId: "D-02",
              paths: ["package.json"],
            },
          ],
        });
        await stores.gateHealth.put(mine);
        expect(await stores.gateHealth.get(b.scope.projectId)).toBeUndefined();
        await stores.gateHealth.put(theirs);
        expect(await stores.gateHealth.get(a.scope.projectId)).toEqual(mine);
        expect(await stores.gateHealth.get(b.scope.projectId)).toEqual(theirs);
      });

      it("refuses a record that is not what its schema says, storing nothing", async () => {
        const record = makeGateHealth(a);
        const finding = {
          id: "F-01",
          rule: 1,
          found: "x",
          decisionId: "D-01",
          paths: [],
        };
        for (const bad of [
          { ...record, findings: [finding] },
          { ...record, verdict: "broken" },
          { ...record, fingerprint: "nope" },
          { ...record, machinery: ["..\\outside\\gate.mjs"] },
          { ...record, machinery: ["../outside/gate.mjs"] },
          {
            ...record,
            verdict: "repairing",
            findings: [{ ...finding, paths: ["\\Windows\\gate.mjs"] }],
          },
          { ...record, verdict: "repairing", findings: [finding, finding] },
        ]) {
          await expect(stores.gateHealth.put(bad as never)).rejects.toThrow();
        }
        expect(await stores.gateHealth.get(a.scope.projectId)).toBeUndefined();
      });
    });

    describe("run feedback (P20, D-04)", () => {
      const nextRun = (f: Fixtures): RunScope => ({
        ...f.scope,
        runId: f.ids.next("run") as RunId,
      });
      const at = (f: Fixtures, scope: RunScope, version: number) =>
        makeRunFeedback(f, {
          ...scope,
          version,
          revisions: Array.from({ length: version }, (_, i) => ({
            version: i + 1,
            verdict: "worked",
            actor: makeRunFeedback(f).actor,
            recordedAt: makeRunFeedback(f).recordedAt,
          })),
        });

      it("round trips, and answers undefined when absent", async () => {
        expect(await stores.feedback.get(a.scope)).toBeUndefined();
        const record = makeRunFeedback(a);
        await stores.feedback.put(record);
        expect(await stores.feedback.get(a.scope)).toEqual(record);
      });

      it("is isolated by project, including a partially matching chain", async () => {
        await stores.feedback.put(makeRunFeedback(a));
        expect(await stores.feedback.get(b.scope)).toBeUndefined();
        expect(
          await stores.feedback.get({
            ...a.scope,
            projectId: b.scope.projectId,
          }),
        ).toBeUndefined();
        expect(
          await stores.feedback.get({
            ...a.scope,
            programId: b.scope.programId,
          }),
        ).toBeUndefined();
        expect((await stores.feedback.listByProgram(b.scope)).items).toEqual([]);
      });

      it("refuses an invalid record and stores nothing", async () => {
        const bad = { ...makeRunFeedback(a), verdict: "maybe" };
        await expect(stores.feedback.put(bad as never)).rejects.toThrow();
        expect(await stores.feedback.get(a.scope)).toBeUndefined();
      });

      it("writes only on top of the version the writer read", async () => {
        await expect(stores.feedback.put(at(a, a.scope, 2))).rejects.toBeInstanceOf(
          StaleWriteError,
        );
        expect(await stores.feedback.get(a.scope)).toBeUndefined();
        await stores.feedback.put(at(a, a.scope, 1));
        await expect(stores.feedback.put(at(a, a.scope, 1))).rejects.toBeInstanceOf(
          StaleWriteError,
        );
        await stores.feedback.put(at(a, a.scope, 2));
        await expect(stores.feedback.put(at(a, a.scope, 1))).rejects.toBeInstanceOf(
          StaleWriteError,
        );
        expect((await stores.feedback.get(a.scope))?.version).toBe(2);
      });

      it("lets exactly one of two concurrent writes at the same version land", async () => {
        const first = makeRunFeedback(a);
        const second = makeRunFeedback(a, {
          verdict: "did_not_work",
          revisions: [{ ...first.revisions[0], verdict: "did_not_work" }],
        });
        const results = await Promise.allSettled([
          stores.feedback.put(first),
          stores.feedback.put(second),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const rejected = results.filter((r) => r.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleWriteError);
        const stored = await stores.feedback.get(a.scope);
        expect([first, second]).toContainEqual(stored);
      });

      it("lists a program's feedback without repeating or dropping", async () => {
        const total = 7;
        const expected: RunId[] = [];
        for (let i = 0; i < total; i += 1) {
          const scope = nextRun(a);
          expected.push(scope.runId);
          await stores.feedback.put(makeRunFeedback(a, scope));
        }
        await stores.feedback.put(makeRunFeedback(b));
        const seen: RunId[] = [];
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page = await stores.feedback.listByProgram(
            a.scope,
            cursor === undefined ? { limit: 3 } : { limit: 3, cursor },
          );
          seen.push(...page.items.map((item) => item.runId));
          cursor = page.cursor;
          guard += 1;
          expect(guard).toBeLessThan(10);
        } while (cursor !== undefined);
        expect([...seen].sort()).toEqual([...expected].sort());
      });
    });

    describe("completion histories (P20, D-05)", () => {
      const secondVersion = (history: ReturnType<typeof makeCompletionHistory>) =>
        makeCompletionHistory(a, {
          ...history,
          version: 2,
          revisions: [...history.revisions, { ...history.revisions[0], version: 2 }],
        });

      it("round trips, and answers undefined when absent", async () => {
        const history = makeCompletionHistory(a);
        expect(
          await stores.completionHistories.get(a.scope, history.completionHistoryId),
        ).toBeUndefined();
        await stores.completionHistories.put(history);
        expect(await stores.completionHistories.get(a.scope, history.completionHistoryId)).toEqual(
          history,
        );
      });

      it("is isolated by project, including a partially matching chain", async () => {
        const history = makeCompletionHistory(a);
        await stores.completionHistories.put(history);
        const id = history.completionHistoryId;
        expect(await stores.completionHistories.get(b.scope, id)).toBeUndefined();
        expect(
          await stores.completionHistories.get({ ...a.scope, projectId: b.scope.projectId }, id),
        ).toBeUndefined();
        expect((await stores.completionHistories.listByProject(b.scope.projectId)).items).toEqual(
          [],
        );
        expect(await stores.completionHistories.listByRun(b.scope)).toEqual([]);
      });

      it("refuses an invalid record and stores nothing", async () => {
        const history = makeCompletionHistory(a);
        const bad = { ...history, title: "" };
        await expect(stores.completionHistories.put(bad as never)).rejects.toThrow();
        expect(
          await stores.completionHistories.get(a.scope, history.completionHistoryId),
        ).toBeUndefined();
      });

      it("writes only on top of the version the writer read", async () => {
        const history = makeCompletionHistory(a);
        const id = history.completionHistoryId;
        await expect(stores.completionHistories.put(secondVersion(history))).rejects.toBeInstanceOf(
          StaleWriteError,
        );
        expect(await stores.completionHistories.get(a.scope, id)).toBeUndefined();
        await stores.completionHistories.put(history);
        await expect(stores.completionHistories.put(history)).rejects.toBeInstanceOf(
          StaleWriteError,
        );
        await stores.completionHistories.put(secondVersion(history));
        expect((await stores.completionHistories.get(a.scope, id))?.version).toBe(2);
        await expect(stores.completionHistories.put(history)).rejects.toBeInstanceOf(
          StaleWriteError,
        );
      });

      it("lets exactly one of two concurrent writes at the same version land", async () => {
        const first = makeCompletionHistory(a);
        const second = { ...first, title: "A rival title" };
        const results = await Promise.allSettled([
          stores.completionHistories.put(first),
          stores.completionHistories.put(second),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const rejected = results.filter((r) => r.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleWriteError);
      });

      it("lists a project's histories without repeating or dropping", async () => {
        const total = 7;
        const expected: string[] = [];
        for (let i = 0; i < total; i += 1) {
          const history = makeCompletionHistory(a);
          expected.push(history.completionHistoryId);
          await stores.completionHistories.put(history);
        }
        await stores.completionHistories.put(makeCompletionHistory(b));
        const seen: string[] = [];
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page = await stores.completionHistories.listByProject(
            a.scope.projectId,
            cursor === undefined ? { limit: 3 } : { limit: 3, cursor },
          );
          seen.push(...page.items.map((item) => item.completionHistoryId));
          cursor = page.cursor;
          guard += 1;
          expect(guard).toBeLessThan(10);
        } while (cursor !== undefined);
        expect([...seen].sort()).toEqual([...expected].sort());
      });

      it("lists by run only the histories anchored on that run", async () => {
        const otherRun: RunScope = {
          ...a.scope,
          runId: a.ids.next("run") as RunId,
        };
        const mine = makeCompletionHistory(a);
        const members = [
          {
            programId: otherRun.programId,
            runId: otherRun.runId,
            role: "anchor",
          },
        ];
        const theirs = makeCompletionHistory(a, {
          ...otherRun,
          members,
          revisions: [{ ...mine.revisions[0], added: members }],
        });
        await stores.completionHistories.put(mine);
        await stores.completionHistories.put(theirs);
        expect(
          (await stores.completionHistories.listByRun(a.scope)).map((h) => h.completionHistoryId),
        ).toEqual([mine.completionHistoryId]);
        expect(
          (await stores.completionHistories.listByRun(otherRun)).map((h) => h.completionHistoryId),
        ).toEqual([theirs.completionHistoryId]);
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
        const second = makeProject(a, {
          projectId: a.ids.next("proj"),
          orgId: orgOne,
        });
        const elsewhere = makeProject(b, { orgId: orgTwo });
        for (const project of [first, second, elsewhere]) await stores.projects.put(project);

        const one = (await stores.projects.listByOrg(orgOne)).items;
        expect(one.map((p) => p.projectId)).toEqual([first.projectId, second.projectId].sort());
        expect(one.every((p) => p.orgId === orgOne)).toBe(true);

        const two = (await stores.projects.listByOrg(orgTwo)).items;
        expect(two).toEqual([elsewhere]);
      });

      it("returns an empty page, not an error, for an org with no projects", async () => {
        const page = await stores.projects.listByOrg(a.ids.next("org"), {
          limit: 5,
        });
        expect(page.items).toEqual([]);
        expect(page.cursor).toBeUndefined();
      });

      it("pages through an org's projects without repeating or dropping one", async () => {
        const orgId = a.ids.next("org");
        const written: ProjectId[] = [];
        for (let i = 0; i < 5; i += 1) {
          const project = makeProject(a, {
            projectId: a.ids.next("proj"),
            orgId,
          });
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

        it("stores an org's sealed provider keys, and a view never carries the ciphertext (P10, D-P10-23)", async () => {
          const { credentials } = identity();
          const orgId = a.ids.next("org");
          const sealed = makeOrgCredential(orgId);
          await credentials.put(sealed);
          await credentials.put(makeOrgCredential(orgId, { provider: "openai", lastFour: "abcd" }));
          await credentials.put(makeOrgCredential(b.ids.next("org")));
          const view = await credentials.view(orgId);
          expect(view).toEqual([
            { provider: "anthropic", lastFour: "wxyz", setAt: sealed.setAt },
            { provider: "openai", lastFour: "abcd", setAt: sealed.setAt },
          ]);
          for (const item of view) {
            expect(Object.keys(item).sort()).toEqual(["lastFour", "provider", "setAt"]);
          }
          expect(await credentials.sealed(orgId, "anthropic")).toEqual(sealed);
          expect(await credentials.sealed(orgId, "openai")).toMatchObject({
            lastFour: "abcd",
          });
          expect(await credentials.sealed(a.ids.next("org"), "anthropic")).toBeUndefined();
        });

        it("stores a project's sealed secrets beside its org's keys, listed by view only, and deletes one (A-62)", async () => {
          const { credentials } = identity();
          const orgId = a.ids.next("org");
          const projectId = a.ids.next("proj");
          const npm = makeProjectSecret(orgId, projectId);
          await credentials.putSecret(npm);
          await credentials.putSecret(
            makeProjectSecret(orgId, projectId, {
              name: "SENTRY_TOKEN",
              lastFour: "abcd",
            }),
          );
          // Another project's, and the org's own key, are no part of it.
          await credentials.putSecret(makeProjectSecret(orgId, a.ids.next("proj")));
          await credentials.put(makeOrgCredential(orgId));
          const view = await credentials.secrets(projectId);
          expect(view).toEqual([
            { name: "NPM_TOKEN", lastFour: "wxyz", setAt: npm.setAt },
            { name: "SENTRY_TOKEN", lastFour: "abcd", setAt: npm.setAt },
          ]);
          for (const item of view) {
            expect(Object.keys(item).sort()).toEqual(["lastFour", "name", "setAt"]);
          }
          expect(await credentials.sealedSecrets(projectId)).toContainEqual(npm);
          // Set again, it is replaced, not added.
          await credentials.putSecret({ ...npm, lastFour: "9999" });
          expect((await credentials.secrets(projectId)).map((item) => item.lastFour)).toEqual([
            "9999",
            "abcd",
          ]);
          expect(await credentials.deleteSecret(projectId, "NPM_TOKEN")).toBe(true);
          expect(await credentials.deleteSecret(projectId, "NPM_TOKEN")).toBe(false);
          expect((await credentials.secrets(projectId)).map((item) => item.name)).toEqual([
            "SENTRY_TOKEN",
          ]);
          expect(await credentials.view(orgId)).toHaveLength(1);
        });

        it("keeps an org's compute ledger by month (P10, D-P10-19)", async () => {
          const { computeLedger } = identity();
          const orgId = a.ids.next("org");
          expect(await computeLedger.get(orgId, "2026-10")).toBeUndefined();
          const usage = {
            schemaVersion: 1 as const,
            orgId,
            month: "2026-10",
            meteredUsd: 1.25,
            updatedAt: "2026-10-01T12:00:00.000Z",
          };
          await computeLedger.put(usage);
          expect(await computeLedger.get(orgId, "2026-10")).toEqual(usage);
          expect(await computeLedger.get(orgId, "2026-11")).toBeUndefined();
        });

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

    describe("one node's events (2026-10-22)", () => {
      it("lists a node's events alone, in listByRun's order, and only one type when asked", async () => {
        const node = a.rootNodeId;
        const other = makeNode(a, a.rootNodeId).executionNodeId;
        const mine = [
          makeEvent(a, {
            idempotencyKey: "m0",
            executionNodeId: node,
            type: "tool.called",
          }),
          makeEvent(a, {
            idempotencyKey: "m1",
            executionNodeId: node,
            type: "node.failed",
          }),
          makeEvent(a, {
            idempotencyKey: "m2",
            executionNodeId: node,
            type: "tool.called",
          }),
          makeEvent(a, {
            idempotencyKey: "m3",
            executionNodeId: node,
            type: "node.failed",
          }),
        ];
        await stores.events.append(mine[0] as never);
        await stores.events.append(makeEvent(a, { idempotencyKey: "x0", executionNodeId: other }));
        await stores.events.append(makeEvent(a, { idempotencyKey: "run-level" }));
        for (const event of mine.slice(1)) await stores.events.append(event);
        await settle();

        const all = (await stores.events.listByRun(a.scope)).items;
        const expected = all.filter((e) => e.executionNodeId === node).map((e) => e.eventId);
        const listed = (await stores.events.listByNode(a.scope, node)).items;
        expect(listed.map((e) => e.eventId)).toEqual(expected);
        expect(listed.map((e) => e.idempotencyKey)).toEqual(["m0", "m1", "m2", "m3"]);

        const failures = (await stores.events.listByNode(a.scope, node, { type: "node.failed" }))
          .items;
        expect(failures.map((e) => e.idempotencyKey)).toEqual(["m1", "m3"]);
        expect(
          (await stores.events.listByNode(a.scope, other)).items.map((e) => e.idempotencyKey),
        ).toEqual(["x0"]);
      });

      it("pages a node's events without losing or repeating one", async () => {
        const node = a.rootNodeId;
        for (let i = 0; i < 7; i += 1) {
          await stores.events.append(
            makeEvent(a, {
              idempotencyKey: `p${i}`,
              executionNodeId: node,
              type: "tool.called",
            }),
          );
        }
        await settle();
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await stores.events.listByNode(
            a.scope,
            node,
            cursor === undefined ? { limit: 3 } : { limit: 3, cursor },
          );
          seen.push(...page.items.map((e) => e.idempotencyKey));
          cursor = page.cursor;
        } while (cursor !== undefined);
        expect(seen).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6"]);
      });

      it("keeps one run's node events from another run's", async () => {
        await stores.events.append(
          makeEvent(a, { idempotencyKey: "a0", executionNodeId: a.rootNodeId }),
        );
        await stores.events.append(
          makeEvent(b, { idempotencyKey: "b0", executionNodeId: b.rootNodeId }),
        );
        await settle();
        expect(
          (await stores.events.listByNode(a.scope, a.rootNodeId)).items.map(
            (e) => e.idempotencyKey,
          ),
        ).toEqual(["a0"]);
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
        const tail = await stores.events.listByRun(a.scope, {
          afterSequence: 3,
        });
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

    describe("measurement summaries (P20 S-01)", () => {
      const T0 = "2026-01-01T00:00:00.000Z";
      const T1 = "2026-01-01T00:00:01.000Z";
      const T2 = "2026-01-01T00:00:02.000Z";

      /** Every optional field absent: the shape of the oldest record that can exist. */
      const summaryFor = (
        f: Fixtures,
        overrides: Partial<MeasurementSummary> = {},
      ): MeasurementSummary => ({
        schemaVersion: 1,
        measurementVersion: 1,
        ...f.scope,
        measurementSummaryId: f.ids.next("meas"),
        executionNodeId: f.rootNodeId,
        agentId: f.ids.next("agent"),
        role: "worker",
        routingDecisionId: null,
        route: {
          harness: "claude",
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
        observedModels: [],
        segments: [],
        totals: {},
        coverage: "unknown",
        gaps: [],
        ledger: {
          chunks: 0,
          artifactIds: [],
          observationCount: 0,
          publishedCount: 0,
        },
        valuation: { source: "unknown" },
        createdAt: T0,
        updatedAt: T0,
        ...overrides,
      });

      it("round trips a summary", async () => {
        const summary = summaryFor(a, {
          observedModels: ["claude-sonnet-5"],
          totals: {
            inputTokens: 100,
            outputTokens: 20,
            inputIncludesCache: false,
          },
          childCounters: { inputTokens: 5 },
          coverage: "partial",
          gaps: [{ reason: "receipt_lost", count: 2 }],
          ledger: {
            chunks: 1,
            artifactIds: [],
            observationCount: 3,
            publishedCount: 2,
          },
          valuation: {
            source: "reported",
            usd: 0.5,
            reportedUsd: 0.5,
            basis: "provider",
          },
          updatedAt: T1,
        });
        await stores.measurements.put(summary);
        expect(await stores.measurements.get(a.scope, summary.measurementSummaryId)).toEqual(
          summary,
        );
      });

      it("returns undefined for a summary that does not exist", async () => {
        expect(await stores.measurements.get(a.scope, a.ids.next("meas"))).toBeUndefined();
      });

      it("replaces in place, keeping one record per id and returning the newer", async () => {
        const first = summaryFor(a);
        const second = {
          ...first,
          totals: { inputTokens: 10 },
          ledger: { ...first.ledger, observationCount: 1, publishedCount: 1 },
          updatedAt: T1,
        };
        await stores.measurements.put(first);
        await stores.measurements.put(second);
        expect(await stores.measurements.get(a.scope, first.measurementSummaryId)).toEqual(second);
        expect((await stores.measurements.listByRun(a.scope)).items).toEqual([second]);
      });

      it("ignores a put whose updatedAt is older than the stored record's", async () => {
        const newer = {
          ...summaryFor(a),
          totals: { inputTokens: 50 },
          updatedAt: T2,
        };
        const older = { ...newer, totals: { inputTokens: 1 }, updatedAt: T1 };
        await stores.measurements.put(newer);
        await stores.measurements.put(older);
        expect(await stores.measurements.get(a.scope, newer.measurementSummaryId)).toEqual(newer);
      });

      it("replaces when updatedAt is equal", async () => {
        const first = summaryFor(a, { updatedAt: T1 });
        const same = { ...first, totals: { inputTokens: 7 } };
        await stores.measurements.put(first);
        await stores.measurements.put(same);
        expect(await stores.measurements.get(a.scope, first.measurementSummaryId)).toEqual(same);
      });

      it("lists only the requested node's summaries", async () => {
        const other = makeNode(a, a.rootNodeId);
        const mine = summaryFor(a);
        const theirs = summaryFor(a, {
          executionNodeId: other.executionNodeId,
        });
        await stores.measurements.put(mine);
        await stores.measurements.put(theirs);
        expect(await stores.measurements.listByNode(a.scope, a.rootNodeId)).toEqual([mine]);
        expect(await stores.measurements.listByNode(a.scope, other.executionNodeId)).toEqual([
          theirs,
        ]);
      });

      it("lists a run's summaries ordered by id, and paginates", async () => {
        const created = [1, 2, 3, 4, 5].map(() => summaryFor(a));
        for (const summary of [...created].reverse()) await stores.measurements.put(summary);
        const expected = created
          .map((summary) => summary.measurementSummaryId)
          .sort((x, y) => (x < y ? -1 : 1));

        const ids: string[] = [];
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page = await stores.measurements.listByRun(
            a.scope,
            cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
          );
          expect(page.items.length).toBeLessThanOrEqual(2);
          ids.push(...page.items.map((item) => item.measurementSummaryId));
          cursor = page.cursor;
          guard += 1;
          expect(guard).toBeLessThan(10);
        } while (cursor !== undefined);
        expect(ids).toEqual(expected);
      });

      it("isolates summaries by project", async () => {
        const summary = summaryFor(a);
        await stores.measurements.put(summary);
        await stores.measurements.put(summaryFor(b));
        expect(
          await stores.measurements.get(b.scope, summary.measurementSummaryId),
        ).toBeUndefined();
        expect(await stores.measurements.listByNode(b.scope, a.rootNodeId)).toEqual([]);
        expect((await stores.measurements.listByRun(a.scope)).items).toEqual([summary]);
      });

      it("refuses a summary that claims more published than observed", async () => {
        const bad = summaryFor(a, {
          ledger: {
            chunks: 0,
            artifactIds: [],
            observationCount: 1,
            publishedCount: 2,
          },
        });
        await expect(stores.measurements.put(bad)).rejects.toThrow();
        expect(await stores.measurements.get(a.scope, bad.measurementSummaryId)).toBeUndefined();
      });

      it("reads back a record with every optional field absent", async () => {
        const minimal = summaryFor(a);
        expect(minimal.childCounters).toBeUndefined();
        await stores.measurements.put(minimal);
        expect(await stores.measurements.get(a.scope, minimal.measurementSummaryId)).toEqual(
          minimal,
        );
      });
    });

    describe("validation on write", () => {
      it("refuses a record whose schemaVersion is not 1", async () => {
        const node = makeRootNode(a);
        await expect(
          stores.executionNodes.put({
            ...node,
            schemaVersion: 2,
          } as unknown as typeof node),
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
            makeEvent(a, { idempotencyKey: "big" }) as Event & {
              payload: unknown;
            },
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
          stores.computeUtilizations.listByProject,
          stores.feedback.listByProgram,
          stores.completionHistories.listByRun,
          stores.completionHistories.listByProject,
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

    describe("one live run per program (S-01, PIP-9)", () => {
      const ended = (
        run: Run,
        status: "succeeded" | "failed" | "cancelled" | "interrupted",
      ): Run => ({
        ...run,
        status,
        endedAt: "2026-01-01T01:00:00.000Z",
        ...(status === "succeeded" ? {} : { outcomeReason: "ended by the test" }),
      });
      const second = (f: Fixtures, status: "pending" | "running" = "pending"): Run =>
        makeRun(f, { runId: f.ids.next("run") as RunId, status });

      for (const heldStatus of ["pending", "running"] as const) {
        for (const refusedStatus of ["pending", "running"] as const) {
          it(`refuses a ${refusedStatus} run beside a ${heldStatus} one, naming the holder, and stores nothing`, async () => {
            const first = makeRun(a, { status: heldStatus });
            await stores.runs.put(first);
            const other = second(a, refusedStatus);
            const refusal = await stores.runs.put(other).then(
              () => undefined,
              (error: unknown) => error,
            );
            expect(refusal).toBeInstanceOf(ProgramRunLiveError);
            expect(refusal).toMatchObject({
              programId: a.scope.programId,
              liveRunId: first.runId,
            });
            expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
            expect((await stores.runs.listByProgram(a.scope)).items).toHaveLength(1);
          });
        }
      }

      it("leaves another program unaffected", async () => {
        await stores.runs.put(makeRun(a));
        const otherProgram = makeRun(a, {
          programId: a.ids.next("prog") as ProgramId,
          runId: a.ids.next("run") as RunId,
        });
        await stores.runs.put(otherProgram);
        await stores.runs.put(makeRun(b));
      });

      for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
        it(`accepts a new run once the first ends ${status}`, async () => {
          const first = makeRun(a);
          await stores.runs.put(first);
          await stores.runs.put(ended(first, status));
          const next = second(a, "running");
          await stores.runs.put(next);
          expect(await stores.runs.get(a.scope, next.runId)).toEqual(next);
          const refusal = await stores.runs.put(second(a)).catch((error: unknown) => error);
          expect(refusal).toMatchObject({ liveRunId: next.runId });
        });
      }

      it("accepts updates to the live run itself", async () => {
        const first = makeRun(a, { status: "pending" });
        await stores.runs.put(first);
        await stores.runs.put(first);
        const running = { ...first, status: "running" as const };
        await stores.runs.put(running);
        await stores.runs.put(running);
        expect(await stores.runs.get(a.scope, first.runId)).toEqual(running);
      });

      it("persists a terminal put of a run that does not hold the marker, leaving another's marker", async () => {
        const holder = makeRun(a);
        await stores.runs.put(holder);
        // Never put live, so it holds nothing; it is written terminal directly.
        const stray = ended(second(a), "failed");
        await stores.runs.put(stray);
        expect(await stores.runs.get(a.scope, stray.runId)).toEqual(stray);
        // The holder's marker survives: a further live run is still refused.
        const refusal = await stores.runs.put(second(a)).catch((error: unknown) => error);
        expect(refusal).toMatchObject({ liveRunId: holder.runId });
      });

      it("persists a repeated terminal put after release, leaving the next run's marker", async () => {
        const first = makeRun(a);
        await stores.runs.put(first);
        await stores.runs.put(ended(first, "failed"));
        const next = second(a, "running");
        await stores.runs.put(next);
        const again = ended(first, "cancelled");
        await stores.runs.put(again);
        expect(await stores.runs.get(a.scope, first.runId)).toEqual(again);
        const refusal = await stores.runs.put(second(a)).catch((error: unknown) => error);
        expect(refusal).toMatchObject({ liveRunId: next.runId });
      });

      it("refuses to move a terminal run back to running, and changes nothing", async () => {
        const first = makeRun(a);
        await stores.runs.put(first);
        const done = ended(first, "interrupted");
        await stores.runs.put(done);
        await expect(stores.runs.put({ ...first, status: "running" })).rejects.toThrow(
          IllegalTransitionError,
        );
        expect(await stores.runs.get(a.scope, first.runId)).toEqual(done);
        // The marker was released and stays released.
        await stores.runs.put(second(a));
      });
    });

    describe("a never-started run is settled by the next start (D-07)", () => {
      const GRACE_PASSED = NEVER_STARTED_GRACE + 1000;
      const HOURS_AHEAD = "2026-01-01T09:00:00.000Z" as Run["startedAt"];
      const HOURS_BEHIND = "2025-12-31T15:00:00.000Z" as Run["startedAt"];
      const next = (
        f: Fixtures,
        startedAt?: Run["startedAt"],
        status: "pending" | "running" = "pending",
      ): Run =>
        makeRun(f, {
          runId: f.ids.next("run") as RunId,
          status,
          ...(startedAt === undefined ? {} : { startedAt }),
        });

      it("ends a pending holder past the grace by the trusted clock as interrupted, at the trusted now", async () => {
        const holder = makeRun(a, { status: "pending" });
        await stores.runs.put(holder);
        clock.advance(GRACE_PASSED);
        const fresh = next(a, HOURS_AHEAD);
        await stores.runs.put(fresh);
        expect(await stores.runs.get(a.scope, fresh.runId)).toEqual(fresh);
        expect(await stores.runs.get(a.scope, holder.runId)).toMatchObject({
          status: "interrupted",
          endedAt: clock.now(),
          outcomeReason: "never started",
        });
        const refusal = await stores.runs.put(next(a)).catch((error: unknown) => error);
        expect(refusal).toMatchObject({ liveRunId: fresh.runId });
      });

      it("is not settled by a new run whose startedAt is hours ahead while the claim is within the grace", async () => {
        const holder = makeRun(a, { status: "pending" });
        await stores.runs.put(holder);
        clock.advance(5 * 60 * 1000);
        const other = next(a, HOURS_AHEAD);
        await expect(stores.runs.put(other)).rejects.toMatchObject({
          liveRunId: holder.runId,
        });
        expect(await stores.runs.get(a.scope, holder.runId)).toEqual(holder);
        expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
      });

      it("is not settled when the holder's startedAt is hours behind but its claim is within the grace", async () => {
        const holder = makeRun(a, {
          status: "pending",
          startedAt: HOURS_BEHIND,
        });
        await stores.runs.put(holder);
        const other = next(a);
        await expect(stores.runs.put(other)).rejects.toMatchObject({
          liveRunId: holder.runId,
        });
        expect(await stores.runs.get(a.scope, holder.runId)).toEqual(holder);
        expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
      });

      it("refuses beside a running holder", async () => {
        const holder = makeRun(a, { status: "running" });
        await stores.runs.put(holder);
        clock.advance(GRACE_PASSED);
        const other = next(a);
        await expect(stores.runs.put(other)).rejects.toMatchObject({
          liveRunId: holder.runId,
        });
        expect(await stores.runs.get(a.scope, holder.runId)).toEqual(holder);
        expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
      });

      it("refuses beside a pending holder within the grace", async () => {
        const holder = makeRun(a, { status: "pending" });
        await stores.runs.put(holder);
        clock.advance(5 * 60 * 1000);
        const other = next(a);
        await expect(stores.runs.put(other)).rejects.toBeInstanceOf(ProgramRunLiveError);
        expect(await stores.runs.get(a.scope, holder.runId)).toEqual(holder);
        expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
      });

      it("refuses beside a pending holder with a dispatch", async () => {
        const holder = makeRun(a, { status: "pending", location: "remote" });
        await stores.runs.put(holder);
        await stores.dispatches.put(makeDispatch(a));
        clock.advance(GRACE_PASSED);
        const other = next(a);
        await expect(stores.runs.put(other)).rejects.toMatchObject({
          liveRunId: holder.runId,
        });
        expect(await stores.runs.get(a.scope, holder.runId)).toEqual(holder);
        expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
      });

      it("refuses and stores a new dispatch for a run no longer pending", async () => {
        const holder = makeRun(a, { status: "pending", location: "remote" });
        await stores.runs.put(holder);
        clock.advance(GRACE_PASSED);
        await stores.runs.put(next(a));
        await expect(stores.dispatches.put(makeDispatch(a))).rejects.toBeInstanceOf(
          IllegalTransitionError,
        );
        expect(await stores.dispatches.get(a.scope)).toBeUndefined();
      });

      it("refuses a new dispatch for a running or absent run", async () => {
        await expect(stores.dispatches.put(makeDispatch(a))).rejects.toBeInstanceOf(
          IllegalTransitionError,
        );
        await stores.runs.put(makeRun(a, { status: "running" }));
        await expect(stores.dispatches.put(makeDispatch(a))).rejects.toBeInstanceOf(
          IllegalTransitionError,
        );
        expect(await stores.dispatches.get(a.scope)).toBeUndefined();
      });
    });

    describe("a run stored before the live-run marker still holds its program (F-01)", () => {
      const seeded = (status: "pending" | "running"): Run => makeRun(a, { status });
      const fresh = (): Run => makeRun(a, { runId: a.ids.next("run") as RunId, status: "pending" });
      const seed = async (run: Run): Promise<void> => {
        await options.seedLegacyRun?.(stores, run);
      };
      const legacyIt = options.seedLegacyRun === undefined ? it.skip : it;

      for (const status of ["running", "pending"] as const) {
        legacyIt(
          `refuses a new run beside a legacy ${status} one, then lets it move on and end`,
          async () => {
            const legacy = seeded(status);
            await seed(legacy);
            const other = fresh();
            const refusal = await stores.runs.put(other).then(
              () => undefined,
              (error: unknown) => error,
            );
            expect(refusal).toBeInstanceOf(ProgramRunLiveError);
            expect(refusal).toMatchObject({ liveRunId: legacy.runId });
            expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();

            const running = { ...legacy, status: "running" as const };
            await stores.runs.put(running);
            expect(await stores.runs.get(a.scope, legacy.runId)).toEqual(running);
            const done: Run = {
              ...running,
              status: "succeeded",
              endedAt: "2026-01-01T01:00:00.000Z" as IsoTimestamp,
            };
            await stores.runs.put(done);
            expect(await stores.runs.get(a.scope, legacy.runId)).toEqual(done);

            await stores.runs.put(other);
            expect(await stores.runs.get(a.scope, other.runId)).toEqual(other);
          },
        );
      }

      legacyIt(
        "replaces a marker whose holder was left terminal, and still refuses a live one",
        async () => {
          const legacy = seeded("running");
          await seed(legacy);
          // The refusal adopts the marker for the legacy run.
          await expect(stores.runs.put(fresh())).rejects.toBeInstanceOf(ProgramRunLiveError);
          // The holder ends without the marker being released: the marker is stale.
          await seed({
            ...legacy,
            status: "failed",
            endedAt: "2026-01-01T01:00:00.000Z" as IsoTimestamp,
            outcomeReason: "ended by the test",
          });
          const next = fresh();
          await stores.runs.put(next);
          expect(await stores.runs.get(a.scope, next.runId)).toEqual(next);
          await expect(stores.runs.put(fresh())).rejects.toMatchObject({
            liveRunId: next.runId,
          });
        },
      );

      legacyIt("persists a terminal put of a legacy run, and then accepts a new run", async () => {
        const legacy = seeded("running");
        await seed(legacy);
        const done: Run = {
          ...legacy,
          status: "failed",
          endedAt: "2026-01-01T01:00:00.000Z" as IsoTimestamp,
          outcomeReason: "ended by the test",
        };
        await stores.runs.put(done);
        expect(await stores.runs.get(a.scope, legacy.runId)).toEqual(done);
        await stores.runs.put(fresh());
      });

      legacyIt(
        "adopts a legacy pending run without settling it at the first start, then settles it past the grace",
        async () => {
          const legacy = seeded("pending");
          await seed(legacy);
          // Its own startedAt is long past the grace, but the trusted clock has only just seen it.
          clock.advance(NEVER_STARTED_GRACE * 4);
          const first = fresh();
          await expect(stores.runs.put(first)).rejects.toMatchObject({
            liveRunId: legacy.runId,
          });
          expect(await stores.runs.get(a.scope, legacy.runId)).toEqual(legacy);

          clock.advance(NEVER_STARTED_GRACE - 1000);
          await expect(stores.runs.put(first)).rejects.toMatchObject({
            liveRunId: legacy.runId,
          });

          clock.advance(2000);
          await stores.runs.put(first);
          expect(await stores.runs.get(a.scope, first.runId)).toEqual(first);
          expect(await stores.runs.get(a.scope, legacy.runId)).toMatchObject({
            status: "interrupted",
            endedAt: clock.now(),
            outcomeReason: "never started",
          });
        },
      );

      legacyIt("does not settle a legacy pending run that has a dispatch", async () => {
        const legacy = makeRun(a, { status: "pending", location: "remote" });
        await seed(legacy);
        await stores.dispatches.put(makeDispatch(a));
        const other = fresh();
        await expect(stores.runs.put(other)).rejects.toMatchObject({
          liveRunId: legacy.runId,
        });
        clock.advance(NEVER_STARTED_GRACE * 2);
        await expect(stores.runs.put(other)).rejects.toMatchObject({
          liveRunId: legacy.runId,
        });
        expect(await stores.runs.get(a.scope, legacy.runId)).toEqual(legacy);
      });

      legacyIt(
        "adopts one of several legacy live runs deterministically, and refuses",
        async () => {
          const first = seeded("running");
          const second = makeRun(a, {
            runId: a.ids.next("run") as RunId,
            status: "running",
          });
          await seed(first);
          await seed(second);
          const lowest = [first.runId, second.runId].sort()[0];
          const other = fresh();
          await expect(stores.runs.put(other)).rejects.toMatchObject({
            liveRunId: lowest,
          });
          await expect(stores.runs.put(other)).rejects.toMatchObject({
            liveRunId: lowest,
          });
          expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
        },
      );

      const live = async (): Promise<Run[]> =>
        (await stores.runs.listByProgram(a.scope)).items.filter(
          (r) => r.status === "pending" || r.status === "running",
        );
      const statusOf = async (runId: RunId): Promise<Run["status"] | undefined> =>
        (await stores.runs.get(a.scope, runId))?.status;

      legacyIt(
        "never admits a run beside a live legacy run when the adopted holder is settleable (F-01)",
        async () => {
          const pending = seeded("pending");
          const running = makeRun(a, {
            runId: a.ids.next("run") as RunId,
            status: "running",
          });
          await seed(pending);
          await seed(running);
          const other = fresh();
          // Adoption prefers the run that cannot be settled.
          await expect(stores.runs.put(other)).rejects.toMatchObject({
            liveRunId: running.runId,
          });
          clock.advance(NEVER_STARTED_GRACE * 2);
          const refusal = await stores.runs.put(other).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(refusal).toBeInstanceOf(ProgramRunLiveError);
          expect([pending.runId, running.runId]).toContain(
            (refusal as { liveRunId: RunId }).liveRunId,
          );
          expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
          expect((await live()).map((r) => r.runId).sort()).toEqual(
            [pending.runId, running.runId].sort(),
          );

          await stores.runs.put({
            ...running,
            status: "succeeded",
            endedAt: "2026-01-01T01:00:00.000Z" as IsoTimestamp,
          });
          // The remaining legacy run is settled one start at a time, then the run is admitted.
          for (let step = 0; step < 4; step += 1) {
            clock.advance(NEVER_STARTED_GRACE * 2);
            const outcome = await stores.runs.put(other).then(
              () => "admitted",
              (error: unknown) => error,
            );
            if (outcome === "admitted") break;
            expect(outcome).toBeInstanceOf(ProgramRunLiveError);
            expect((await live()).length).toBeLessThanOrEqual(1);
          }
          expect(await stores.runs.get(a.scope, other.runId)).toEqual(other);
          expect((await live()).map((r) => r.runId)).toEqual([other.runId]);
          expect(await statusOf(pending.runId)).toBe("interrupted");
        },
      );

      legacyIt(
        "settles two legacy pending runs one start at a time, then admits the new run",
        async () => {
          const first = seeded("pending");
          const second = makeRun(a, {
            runId: a.ids.next("run") as RunId,
            status: "pending",
          });
          await seed(first);
          await seed(second);
          const other = fresh();
          let admitted = false;
          for (let step = 0; step < 6 && !admitted; step += 1) {
            const outcome = await stores.runs.put(other).then(
              () => "admitted",
              (error: unknown) => error,
            );
            if (outcome === "admitted") {
              admitted = true;
            } else {
              expect(outcome).toBeInstanceOf(ProgramRunLiveError);
              expect(await stores.runs.get(a.scope, other.runId)).toBeUndefined();
              expect((await live()).length).toBeLessThanOrEqual(2);
              clock.advance(NEVER_STARTED_GRACE + 1000);
            }
          }
          expect(admitted).toBe(true);
          for (const legacy of [first, second]) {
            expect(await stores.runs.get(a.scope, legacy.runId)).toMatchObject({
              status: "interrupted",
              outcomeReason: "never started",
            });
          }
          expect((await live()).map((r) => r.runId)).toEqual([other.runId]);
        },
      );
    });

    describe("unused chain parts are still honoured", () => {
      it("distinguishes two runs of the same program", async () => {
        const runOne = makeRun(a);
        const secondRunId = a.ids.next("run") as RunId;
        const scopeTwo: RunScope = { ...a.scope, runId: secondRunId };

        // One live run per program (PIP-9): the first has ended when the second starts.
        await stores.runs.put({
          ...runOne,
          status: "succeeded",
          endedAt: "2026-01-01T01:00:00.000Z",
        });
        await stores.runs.put({ ...runOne, runId: secondRunId });

        expect((await stores.runs.listByProgram(a.scope)).items).toHaveLength(2);
        await stores.events.append(makeEvent(a, { idempotencyKey: "k" }));
        expect((await stores.events.listByRun(scopeTwo)).items).toHaveLength(0);
      });

      it("distinguishes two programs of the same project", async () => {
        const contract = makeProgramContract(a);
        const secondProgramId = a.ids.next("prog") as ProgramId;
        await stores.programContracts.put(contract);
        await stores.programContracts.put({
          ...contract,
          programId: secondProgramId,
        });
        expect((await stores.programContracts.listByProject(a.scope.projectId)).items).toHaveLength(
          2,
        );
      });
    });
  });
};
