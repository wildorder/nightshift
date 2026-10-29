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
): LineQueueEntry => ({
  program,
  upTo,
  enqueuedAt: new Date(START + minute * 60_000).toISOString(),
  ...(repairs === undefined ? {} : { repairs }),
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
    expect(composition?.ranges[0]).toEqual({ program: P1, upTo: p1, repairs: 1 });
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
});
