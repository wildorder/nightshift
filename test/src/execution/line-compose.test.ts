/** The line composer against real git repositories, with fake queue, publisher and repair. */
import {
  type CommitSha,
  type LineBatch,
  LineCompositionBodySchema,
  LineParkBodySchema,
  type LineQueueEntry,
  type LineRepairRef,
  type ProgramId,
  ProgramIdSchema,
} from "@nightshift/contracts";
import {
  createLineComposer,
  git,
  type LineComposerPorts,
  type LineRepairRequest,
  type LineSettlement,
  nodeGitRunner,
  type RepairOutcome,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createLineRepo, type LineRepo, makeFakeVerifier } from "./line-repo.js";

const P1 = ProgramIdSchema.parse("prog_01J0000000000000000000000A");
const P2 = ProgramIdSchema.parse("prog_01J0000000000000000000000B");
const P3 = ProgramIdSchema.parse("prog_01J0000000000000000000000C");
const START = Date.parse("2026-10-01T00:00:00.000Z");
const REF: LineRepairRef = {
  runId: "run_01J0000000000000000000000A" as LineRepairRef["runId"],
  jobContractId: "job_01J0000000000000000000000A" as LineRepairRef["jobContractId"],
};

const repos: LineRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
});

const entry = (
  program: ProgramId,
  upTo: CommitSha,
  minute: number,
  repairs?: number,
  repaired?: CommitSha,
): LineQueueEntry => ({
  program,
  upTo,
  enqueuedAt: new Date(START + minute * 60_000).toISOString(),
  ...(repairs === undefined ? {} : { repairs }),
  ...(repaired === undefined ? {} : { repaired }),
});

interface Deferred {
  request: LineRepairRequest;
  resolve: (outcome: RepairOutcome) => void;
}

interface Harness {
  lr: LineRepo;
  composer: ReturnType<typeof createLineComposer>;
  queue: LineQueueEntry[];
  held: LineQueueEntry[];
  settled: LineSettlement[];
  repairs: Deferred[];
  released: { program: ProgramId; upTo: CommitSha }[][];
  /** Pushes still to be rejected; a rejection requeues the composition's ranges as the plane does. */
  reject: number;
}

const setup = async (
  opts: { repair?: (request: LineRepairRequest) => RepairOutcome } = {},
): Promise<Harness> => {
  const lr = await createLineRepo({ programs: ["p1", "p2", "p3"] });
  repos.push(lr);
  const inner = lr.checkout();
  // Red when any file holds RED; conflict markers also fail it.
  const verifier = makeFakeVerifier(lr, async (commit) => {
    const files = await git(nodeGitRunner, ["grep", "-l", "-e", "RED", commit], {
      cwd: lr.repo,
    }).catch(() => "");
    return files.trim() === "";
  });
  const h: Harness = {
    lr,
    queue: [],
    held: [],
    settled: [],
    repairs: [],
    released: [],
    reject: 0,
  } as unknown as Harness;
  const composed: Record<string, CommitSha> = {};
  let batchNo = 0;
  const ports: LineComposerPorts = {
    queue: {
      takeBatch: async (release) => {
        if (release) {
          h.released.push(release);
          const back = h.held.filter((e) =>
            release.some((r) => r.program === e.program && r.upTo === e.upTo),
          );
          h.held = h.held.filter((e) => !back.includes(e));
          h.queue.unshift(...back);
        }
        if (h.queue.length === 0) return undefined;
        const entries = h.queue.splice(0);
        batchNo++;
        return {
          batchId: `b${batchNo}`,
          entries,
          takenAt: new Date(START).toISOString(),
          generation: 1,
        } satisfies LineBatch;
      },
      heldEntries: async () => [...h.held],
      lastComposed: async (program) => composed[program],
      settle: async (s) => {
        h.settled.push(s);
        for (const range of s.composition?.ranges ?? []) composed[range.program] = range.upTo;
        h.held.push(...(s.held ?? []));
      },
    },
    checkout: inner,
    verifier,
    publisher: {
      stage: async (input) => ({ bundleKey: `bundles/${input.head}` }),
      outcome: async ({ head }) => {
        if (h.reject > 0) {
          h.reject--;
          const rejected = h.settled.at(-1)?.composition;
          h.queue.unshift(
            ...(rejected?.ranges ?? []).map((range) => ({
              program: range.program,
              upTo: range.upTo,
              enqueuedAt: new Date(START).toISOString(),
              ...(range.repairs === undefined ? {} : { repairs: range.repairs }),
              ...(range.repaired === undefined ? {} : { repaired: range.repaired }),
            })),
          );
          return { status: "rejected", detail: "the line moved" };
        }
        await git(nodeGitRunner, ["update-ref", "refs/heads/line", head], { cwd: lr.repo });
        return { status: "published" };
      },
    },
    repair: (request) =>
      opts.repair
        ? Promise.resolve(opts.repair(request))
        : new Promise((resolve) => h.repairs.push({ request, resolve })),
    clock: { now: () => START },
  };
  h.composer = createLineComposer(ports, async () => ({
    lineHead: await lr.tip("line"),
    mainHead: await lr.tip("main"),
  }));
  return h;
};

const assertSchemas = (h: Harness) => {
  for (const s of h.settled) {
    if (s.composition) {
      expect(
        LineCompositionBodySchema.safeParse({ batchId: s.batchId, ...s.composition }).success,
      ).toBe(true);
    }
    for (const p of s.parked)
      expect(LineParkBodySchema.safeParse({ batchId: s.batchId, ...p }).success).toBe(true);
  }
};

const parentsOf = async (lr: LineRepo, commit: string) =>
  (await git(nodeGitRunner, ["rev-list", "--parents", "-n", "1", commit], { cwd: lr.repo }))
    .trim()
    .split(" ")
    .slice(1);

describe("the line composer", () => {
  it("composes a batch that is clean and green and goes idle", async () => {
    const h = await setup();
    const a = await h.lr.commit("p1", { "a.txt": "a\n" });
    const b = await h.lr.commit("p2", { "b.txt": "b\n" });
    h.queue.push(entry(P1, a, 1), entry(P2, b, 2));
    const out = await h.composer.drain();
    expect(out).toHaveLength(1);
    expect(out[0]?.composed).toEqual([
      { program: P1, upTo: a },
      { program: P2, upTo: b },
    ]);
    expect(h.composer.idle()).toBe(true);
    assertSchemas(h);
  });

  it("keeps composing other files while a conflicting range is repaired, then composes the repair first", async () => {
    const h = await setup();
    const { lr } = h;
    const line0 = await lr.commit("line", { "shared.txt": "line\n" });
    const p1 = await lr.commit("p1", { "shared.txt": "p1\n", "new.txt": "n\n" });
    const p2 = await lr.commit("p2", { "other.txt": "o\n" });
    const p3 = await lr.commit("p3", { "new.txt": "n\n" });
    // p1..p3 branch from the initial commit: p1 conflicts with the line on shared.txt.
    h.queue.push(entry(P1, p1, 1), entry(P2, p2, 2), entry(P3, p3, 3));

    const first = await h.composer.step();
    expect(first.idle).toBe(false);

    // One repair in flight, started from the candidate.
    expect(h.repairs).toHaveLength(1);
    const request = h.repairs[0]?.request as LineRepairRequest;
    expect(request.cause).toBe("line_conflict");
    expect(request.attempt).toBe(1);
    expect(request.lineHead).toBe(line0);
    expect(request.paths).toEqual(["shared.txt"]);
    expect(await parentsOf(lr, request.base)).toEqual([line0, p1]);
    expect(await lr.readFileAtCommit(request.base, "shared.txt")).toContain("<<<<<<<");
    expect(await lr.readFileAtCommit(request.base, "new.txt")).toBe("n\n");

    // p2 (other files) was composed and pushed; p1 and p3 (reserved paths) are held.
    const settled = h.settled[0] as LineSettlement;
    expect(settled.composition?.ranges).toEqual([{ program: P2, upTo: p2 }]);
    expect(settled.held?.map((e) => [e.program, e.repairs])).toEqual([
      [P1, 1],
      [P3, undefined],
    ]);
    const line1 = await lr.tip("line");
    expect(line1).toBe(settled.composition?.commit);
    expect(await lr.readFileAtCommit(line1, "other.txt")).toBe("o\n");
    expect(await lr.readFileAtCommit(line1, "new.txt")).toBeUndefined();

    // The repair resolves the candidate.
    await git(nodeGitRunner, ["branch", "repair", request.base], { cwd: lr.repo });
    const fixed = await lr.commit("repair", { "shared.txt": "resolved\n" });
    h.repairs[0]?.resolve({ kind: "repaired", commit: fixed, repair: REF });
    await h.composer.repairSettled();

    const second = await h.composer.step();
    expect(second.outcome?.composed.map((r) => r.program)).toEqual([P1, P3]);
    const composition = h.settled[1]?.composition;
    expect(composition?.ranges[0]).toEqual({ program: P1, upTo: p1, repairs: 1, repaired: fixed });
    expect(composition?.repair).toEqual(REF);
    const line2 = await lr.tip("line");
    expect(await lr.readFileAtCommit(line2, "other.txt")).toBe("o\n");
    expect(await lr.readFileAtCommit(line2, "new.txt")).toBe("n\n");
    expect(await lr.readFileAtCommit(line2, "shared.txt")).toBe("resolved\n");
    expect(h.composer.idle()).toBe(true);
    assertSchemas(h);
  });

  it("repairs a red range from its red merge", async () => {
    const h = await setup();
    const { lr } = h;
    await lr.commit("line", { "l.txt": "l\n" });
    const p1 = await lr.commit("p1", { "bad.txt": "RED\n" });
    h.queue.push(entry(P1, p1, 1));
    await h.composer.step();
    const request = h.repairs[0]?.request as LineRepairRequest;
    expect(request.cause).toBe("line_red");
    expect(request.paths).toEqual(["bad.txt"]);
    expect(request.checks.length).toBeGreaterThan(0);
    expect(await parentsOf(lr, request.base)).toEqual([await lr.tip("line"), p1]);
  });

  it("parks a lineage after three failed repairs with the cause and the agent's words", async () => {
    const h = await setup({ repair: () => ({ kind: "failed", words: "I could not decide" }) });
    const { lr } = h;
    await lr.commit("line", { "shared.txt": "line\n" });
    const p1 = await lr.commit("p1", { "shared.txt": "p1\n" });
    h.queue.push(entry(P1, p1, 1));
    const attempts: number[] = [];
    for (let i = 0; i < 8 && !(i > 0 && h.composer.idle()); i++) {
      await h.composer.step();
      await h.composer.repairSettled();
    }
    await h.composer.step();
    attempts.push(...h.settled.flatMap((s) => s.held ?? []).map((e) => e.repairs ?? 0));
    expect(attempts).toEqual([1]);
    const parked = h.settled.flatMap((s) => s.parked);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.reason).toContain("conflicted in shared.txt");
    expect(parked[0]?.reason).toContain("I could not decide");
    expect(parked[0]?.ranges[0]?.repairs).toBe(3);
    expect(h.composer.idle()).toBe(true);
    assertSchemas(h);
  });

  it("parks an entry that arrives with its repairs spent, without a fourth repair", async () => {
    const seen: number[] = [];
    const h = await setup({
      repair: (request) => {
        seen.push(request.attempt);
        return { kind: "failed", words: "no" };
      },
    });
    const { lr } = h;
    await lr.commit("line", { "shared.txt": "line\n" });
    const p1 = await lr.commit("p1", { "shared.txt": "p1\n" });
    h.queue.push(entry(P1, p1, 1, 3));
    const out = await h.composer.drain();
    expect(seen).toEqual([]);
    expect(out[0]?.parked).toHaveLength(1);
    expect(out[0]?.parked[0]?.reason).toContain("3 repairs");
    expect(h.composer.idle()).toBe(true);
  });

  it("composes a repaired range alone, then a later range of the same program on top of it", async () => {
    const h = await setup();
    const { lr } = h;
    const line0 = await lr.commit("line", { "shared.txt": "line\n" });
    const a = await lr.commit("p1", { "shared.txt": "p1\n" });
    h.queue.push(entry(P1, a, 1));
    await h.composer.step();
    const request = h.repairs[0]?.request as LineRepairRequest;
    expect(request.lineHead).toBe(line0);

    // B descends from A and adds a file the repair does not touch.
    const b = await lr.commit("p1", { "extra.txt": "extra\n" });
    h.queue.push(entry(P1, b, 2));
    await h.composer.step();
    expect(h.settled[1]?.composition).toBeUndefined();
    expect(h.settled[1]?.held?.map((e) => e.upTo)).toEqual([b]);

    await git(nodeGitRunner, ["branch", "repair", request.base], { cwd: lr.repo });
    const fixed = await lr.commit("repair", { "shared.txt": "resolved\n" });
    h.repairs[0]?.resolve({ kind: "repaired", commit: fixed, repair: REF });
    await h.composer.repairSettled();

    const out = await h.composer.step();
    expect(out.outcome?.composed).toEqual([
      { program: P1, upTo: a, repairs: 1, repaired: fixed },
      { program: P1, from: a, upTo: b },
    ]);
    const head = await lr.tip("line");
    expect(await lr.readFileAtCommit(head, "shared.txt")).toBe("resolved\n");
    expect(await lr.readFileAtCommit(head, "extra.txt")).toBe("extra\n");
    expect(h.composer.idle()).toBe(true);
    assertSchemas(h);
  });

  /** Two failed repairs and a third that succeeds, composed, with the push rejected. */
  const thirdRepairRejected = async (h: Harness) => {
    const { lr } = h;
    await lr.commit("line", { "shared.txt": "line\n" });
    const p1 = await lr.commit("p1", { "shared.txt": "p1\n" });
    h.queue.push(entry(P1, p1, 1));
    await h.composer.step();
    for (const attempt of [0, 1]) {
      h.repairs[attempt]?.resolve({ kind: "failed", words: "no" });
      await h.composer.repairSettled();
      await h.composer.step();
    }
    expect(h.repairs).toHaveLength(3);
    const request = h.repairs[2]?.request as LineRepairRequest;
    expect(request.attempt).toBe(3);
    await git(nodeGitRunner, ["branch", "repair", request.base], { cwd: lr.repo });
    const fixed = await lr.commit("repair", { "shared.txt": "resolved\n" });
    h.repairs[2]?.resolve({ kind: "repaired", commit: fixed, repair: REF });
    await h.composer.repairSettled();
    h.reject = 1;
    const rejected = await h.composer.step();
    expect(rejected.outcome?.published?.status).toBe("rejected");
    return { p1, fixed };
  };

  it("recomposes the repair commit after a rejected push without spending a repair", async () => {
    const h = await setup();
    const { p1, fixed } = await thirdRepairRejected(h);
    expect(h.settled.at(-1)?.composition?.ranges).toEqual([
      { program: P1, upTo: p1, repairs: 3, repaired: fixed },
    ]);
    expect(h.composer.idle()).toBe(false);

    const again = await h.composer.step();
    expect(again.outcome?.published?.status).toBe("published");
    expect(again.outcome?.parked).toEqual([]);
    expect(h.repairs).toHaveLength(3);
    const composition = h.settled.at(-1)?.composition;
    // The plane's newest composition of the program is the rejected one, so `from` is its upTo.
    expect(composition?.ranges).toEqual([
      { program: P1, from: p1, upTo: p1, repairs: 3, repaired: fixed },
    ]);
    expect(composition?.repair).toEqual(REF);
    expect(await h.lr.readFileAtCommit(await h.lr.tip("line"), "shared.txt")).toBe("resolved\n");
    expect(h.settled.flatMap((s) => s.parked)).toEqual([]);
    expect(h.composer.idle()).toBe(true);
    assertSchemas(h);
  });

  it("keeps the reservation of a repaired lineage until its composition is published", async () => {
    const h = await setup();
    const { fixed } = await thirdRepairRejected(h);
    // Rejected: the lineage is still held by the composer (not idle), the repair commit kept.
    expect(h.composer.idle()).toBe(false);
    h.reject = 1;
    const again = await h.composer.step();
    expect(again.outcome?.published?.status).toBe("rejected");
    expect(again.outcome?.composed[0]?.repaired).toBe(fixed);
    expect(h.composer.idle()).toBe(false);
    const last = await h.composer.step();
    expect(last.outcome?.published?.status).toBe("published");
    expect(h.composer.idle()).toBe(true);
  });

  it("a fresh composer composes the repair commit an entry carries, spending no repair", async () => {
    const h = await setup();
    const { lr } = h;
    await lr.commit("line", { "shared.txt": "line\n" });
    const p1 = await lr.commit("p1", { "shared.txt": "p1\n" });
    // A repair made on the line head, as a previous owner's would have been.
    await git(nodeGitRunner, ["branch", "repair", await lr.tip("line")], { cwd: lr.repo });
    const fixed = await lr.commit("repair", { "shared.txt": "resolved\n" });
    h.queue.push(entry(P1, p1, 1, 3, fixed));
    const out = await h.composer.drain();
    expect(out[0]?.published?.status).toBe("published");
    expect(out[0]?.parked).toEqual([]);
    expect(h.repairs).toHaveLength(0);
    expect(await lr.readFileAtCommit(await lr.tip("line"), "shared.txt")).toBe("resolved\n");
    expect(h.composer.idle()).toBe(true);
  });

  it("composes the original range when the repair commit is not present locally", async () => {
    const h = await setup();
    const { lr } = h;
    await lr.commit("line", { "shared.txt": "line\n" });
    const p1 = await lr.commit("p1", { "shared.txt": "p1\n" });
    const gone = "f".repeat(40) as CommitSha;
    h.queue.push(entry(P1, p1, 1, 3, gone));
    const out = await h.composer.drain();
    expect(out[0]?.notes?.[0]).toContain("not present locally");
    expect(out[0]?.parked).toHaveLength(1);
    expect(out[0]?.parked[0]?.reason).toContain("not present locally");
    expect(h.repairs).toHaveLength(0);
  });

  it("is not idle on a fresh composer until it has released the held entries it finds", async () => {
    const h = await setup();
    const { lr } = h;
    await lr.commit("line", { "shared.txt": "line\n" });
    const clean = await lr.commit("p2", { "other.txt": "o\n" });
    const clashing = await lr.commit("p1", { "shared.txt": "p1\n" });
    h.held.push(entry(P2, clean, 1, 1), entry(P1, clashing, 2, 1));
    expect(h.composer.needsRecovery()).toBe(true);
    expect(h.composer.idle()).toBe(false);

    const out = await h.composer.step();
    expect(h.released).toHaveLength(1);
    expect(h.released[0]?.map((r) => r.program).sort()).toEqual([P1, P2].sort());
    expect(out.outcome?.composed).toEqual([{ program: P2, upTo: clean, repairs: 1 }]);
    expect(h.composer.needsRecovery()).toBe(false);
    // The clashing one went into a repair, with its count kept and spent one more.
    expect(h.repairs).toHaveLength(1);
    expect(h.repairs[0]?.request.attempt).toBe(2);
    expect(h.composer.idle()).toBe(false);
    assertSchemas(h);
  });
});
