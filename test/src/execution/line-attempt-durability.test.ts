/**
 * F-01 (the three-repair budget is durable): the line composer against the real
 * line routes over the memory stores, with a git repository. Every consumed
 * repair attempt and the last failed worker's words are written to the plane
 * before a paid repair launches, so a replacement owner (the same run at a higher
 * generation) finds the budget as it was spent and never launches a fourth repair.
 */
import { handleRequest } from "@nightshift/api";
import {
  type CommitSha,
  type LineBatch,
  type LineQueueEntry,
  type LineRecord,
  LineViewSchema,
  TakeLineBatchResponseSchema,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  type Fixtures,
  lineProgramId,
  makeDispatch,
  makeLineRecord,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRun,
  nextUserId,
} from "@nightshift/core";
import {
  createLineComposer,
  type LineComposerPorts,
  type LineRepairRequest,
  type RepairOutcome,
} from "@nightshift/execution";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, describe, expect, it } from "vitest";
import { createLineRepo, type LineRepo, makeFakeVerifier } from "./line-repo.js";

const NOW = "2026-10-01T12:00:00.000Z";
const BRANCH = "nightshift/develop";

const repos: LineRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
});

interface Deferred {
  request: LineRepairRequest;
  resolve: (outcome: RepairOutcome) => void;
}

const world = async () => {
  const lr = await createLineRepo({ programs: ["p1"] });
  repos.push(lr);
  const stores = createInMemoryStores();
  const f: Fixtures = createFixtures();
  const orgId = f.ids.next("org");
  await stores.memberships.put(makeMembership(nextUserId(f), orgId));
  await stores.projects.put(makeProject(f, { orgId }));
  const programId = lineProgramId(f.scope.projectId, BRANCH);
  await stores.programContracts.put(makeProgramContract(f, { line: { branch: BRANCH } }));
  await stores.programContracts.put(
    makeProgramContract(f, {
      programId,
      kind: "line",
      repository: {
        url: "https://example.invalid/repo.git",
        baseBranch: "main",
        programBranch: BRANCH,
      },
    }),
  );
  const runId = f.ids.next("run");
  await stores.runs.put(makeRun(f, { programId, runId, status: "pending" }));
  const dispatch = makeDispatch(f, {
    programId,
    runId,
    generation: 1,
    status: "running",
    instanceId: "i-1",
  });
  await stores.dispatches.put(dispatch);
  await stores.runs.put(makeRun(f, { programId, runId, status: "running" }));
  const deps = {
    stores,
    clock: createFixedClock(Date.parse(NOW)),
    dispatcher: { provision: async () => undefined, publishLine: async () => undefined },
  } as never;

  const call = async (generation: number, method: string, tail: string, body?: unknown) => {
    const response = await handleRequest(deps, {
      method,
      path: `/projects/${f.scope.projectId}/line${tail}`,
      query: { branch: BRANCH },
      body,
      principal: {
        kind: "execution",
        projectId: f.scope.projectId,
        programId,
        runId,
        nodeId: f.rootNodeId,
        agentId: f.ids.next("agent"),
        role: "engine",
        generation,
      } as never,
    });
    if (response.status >= 400) {
      throw new Error(`${method} ${tail}: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body;
  };
  const record = async (): Promise<LineRecord> => {
    const found = await stores.lines.get(f.scope.projectId, BRANCH);
    if (found === undefined) throw new Error("no line record");
    return found;
  };
  /** The owner becomes generation `generation`, as a replacement machine is dispatched. */
  const replaceOwner = async (generation: number) => {
    await stores.dispatches.put({ ...dispatch, generation });
  };

  const repairs: Deferred[] = [];
  /** A composer for one owner generation, its queue the line routes over the shared stores. */
  const composerAt = (
    generation: number,
    options: { failAttempt?: () => boolean } = {},
  ): ReturnType<typeof createLineComposer> => {
    const ports: LineComposerPorts = {
      queue: {
        takeBatch: async (release): Promise<LineBatch | undefined> =>
          TakeLineBatchResponseSchema.parse(
            await call(generation, "POST", "/batch", {
              generation,
              ...(release === undefined ? {} : { release }),
            }),
          ).batch,
        heldEntries: async () =>
          LineViewSchema.parse(await call(generation, "GET", "")).record.held,
        lastComposed: async () => undefined,
        settle: async (s) => {
          await call(generation, "POST", "/settle", {
            batchId: s.batchId,
            ...(s.composition === undefined ? {} : { composition: s.composition }),
            ...(s.push === undefined ? {} : { push: s.push }),
            parked: s.parked,
            ...(s.held === undefined ? {} : { held: s.held }),
          });
        },
        recordAttempt: async ({ program, upTo, repairs: spent, words }) => {
          if (options.failAttempt?.()) throw new Error("the plane is unreachable");
          await call(generation, "POST", "/attempt", {
            generation,
            program,
            upTo,
            repairs: spent,
            ...(words === undefined ? {} : { lastWords: words }),
          });
        },
      },
      checkout: lr.checkout(),
      verifier: makeFakeVerifier(lr, async () => true),
      publisher: {
        stage: async (input) => ({ bundleKey: `bundles/${input.head}` }),
        outcome: async () => {
          throw new Error("nothing is pushed in this scenario");
        },
      },
      repair: (request) => new Promise((resolve) => repairs.push({ request, resolve })),
      clock: { now: () => Date.parse(NOW) },
    };
    return createLineComposer(ports, async () => ({
      lineHead: await lr.tip("line"),
      mainHead: await lr.tip("main"),
    }));
  };

  /** A range that conflicts with the line on shared.txt, queued as a feeding program's. */
  const enqueueConflict = async (): Promise<CommitSha> => {
    await lr.commit("line", { "shared.txt": "line\n" });
    const p1 = await lr.commit("p1", { "shared.txt": "p1\n" });
    await stores.lines.update(f.scope.projectId, BRANCH, () =>
      makeLineRecord(f, {
        queue: [{ program: f.scope.programId, upTo: p1, enqueuedAt: NOW } as LineQueueEntry],
      }),
    );
    return p1;
  };

  const settleFailure = async (index: number, words: string) => {
    repairs[index]?.resolve({ kind: "failed", words });
  };
  return {
    lr,
    f,
    stores,
    repairs,
    record,
    replaceOwner,
    composerAt,
    enqueueConflict,
    settleFailure,
  };
};

const heldOf = async (w: Awaited<ReturnType<typeof world>>) => (await w.record()).held;

describe("the repair budget is durable across composer replacement (F-01)", () => {
  it("persists attempt 2 before it launches, and a replacement owner picks up from it", async () => {
    const w = await world();
    const p1 = await w.enqueueConflict();
    const first = w.composerAt(1);
    await first.step();
    expect(w.repairs).toHaveLength(1);
    expect((await heldOf(w))[0]).toMatchObject({ upTo: p1, repairs: 1 });

    await w.settleFailure(0, "first words");
    await first.repairSettled();
    await first.step();
    // Attempt 2 is running, and the plane already knows it was spent, with attempt 1's words.
    expect(w.repairs).toHaveLength(2);
    expect(w.repairs[1]?.request.attempt).toBe(2);
    expect((await heldOf(w))[0]).toMatchObject({ upTo: p1, repairs: 2, lastWords: "first words" });

    // The owner is replaced while attempt 2 is in flight: the next owner spends attempt 3, not 2 again.
    await w.replaceOwner(2);
    const second = w.composerAt(2);
    await second.step();
    expect(w.repairs.map((r) => r.request.attempt)).toEqual([1, 2, 3]);
    expect((await heldOf(w))[0]).toMatchObject({ upTo: p1, repairs: 3 });
  });

  it("never launches a fourth repair across repeated replacement, and parks with the failed words", async () => {
    const w = await world();
    const p1 = await w.enqueueConflict();
    await w.composerAt(1).step();
    await w.settleFailure(0, "words one");

    // Replacement after attempt 1 failed (its words never reached a second persist): attempt 2.
    await w.replaceOwner(2);
    const second = w.composerAt(2);
    await second.step();
    expect(w.repairs.map((r) => r.request.attempt)).toEqual([1, 2]);
    await w.settleFailure(1, "words two");
    await second.repairSettled();
    await second.step();
    expect(w.repairs.map((r) => r.request.attempt)).toEqual([1, 2, 3]);
    expect((await heldOf(w))[0]).toMatchObject({ repairs: 3, lastWords: "words two" });

    // The third fails; the words are durable before anything is released.
    await w.settleFailure(2, "the final words");
    await second.repairSettled();
    await second.step();
    expect(w.repairs).toHaveLength(3);
    expect((await w.record()).parked.map((p) => p.reason).join("\n")).toContain("the final words");

    // Still replaced again and again: no repair is launched.
    for (const generation of [3, 4]) {
      await w.replaceOwner(generation);
      await w.composerAt(generation).drain();
    }
    expect(w.repairs).toHaveLength(3);
    const parked = (await w.record()).parked;
    expect(parked).toHaveLength(1);
    expect(parked[0]?.ranges[0]).toMatchObject({ upTo: p1, repairs: 3 });
  });

  it("a replacement after attempt 3 launched parks with the last failure's words, without a fourth repair", async () => {
    const w = await world();
    const p1 = await w.enqueueConflict();
    const first = w.composerAt(1);
    await first.step();
    await w.settleFailure(0, "words one");
    await first.repairSettled();
    await first.step();
    await w.settleFailure(1, "words two");
    await first.repairSettled();
    await first.step();
    expect(w.repairs.map((r) => r.request.attempt)).toEqual([1, 2, 3]);
    expect((await heldOf(w))[0]).toMatchObject({ upTo: p1, repairs: 3, lastWords: "words two" });

    // Attempt 3 is in flight when the owner is replaced.
    await w.replaceOwner(2);
    const out = await w.composerAt(2).drain();
    expect(w.repairs).toHaveLength(3);
    const reason = (await w.record()).parked[0]?.reason ?? "";
    expect(reason).toContain("3 repairs");
    expect(reason).toContain("the last repair failed: words two");
    expect(out.flatMap((o) => o.parked)).toHaveLength(1);
  });

  it("launches no repair for an attempt the plane did not record", async () => {
    const w = await world();
    const p1 = await w.enqueueConflict();
    let down = false;
    const first = w.composerAt(1, { failAttempt: () => down });
    await first.step();
    await w.settleFailure(0, "words one");
    await first.repairSettled();

    down = true;
    await expect(first.step()).rejects.toThrow("unreachable");
    expect(w.repairs).toHaveLength(1);
    expect((await heldOf(w))[0]).toMatchObject({ upTo: p1, repairs: 1 });

    // The plane is back: the answer is folded in again and attempt 2 is recorded, then launched.
    down = false;
    await first.step();
    expect(w.repairs.map((r) => r.request.attempt)).toEqual([1, 2]);
    expect((await heldOf(w))[0]).toMatchObject({ repairs: 2, lastWords: "words one" });
  });

  it("refuses an attempt from a generation that no longer holds the entries", async () => {
    const w = await world();
    await w.enqueueConflict();
    const first = w.composerAt(1);
    await first.step();
    await w.settleFailure(0, "words one");
    await first.repairSettled();
    await w.replaceOwner(2);
    await w.composerAt(2).step();
    // The old owner's late write is refused, so it cannot move the new owner's count.
    await expect(first.step()).rejects.toThrow();
    expect(w.repairs.map((r) => r.request.attempt)).toEqual([1, 2]);
  });
});
