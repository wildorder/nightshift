/** The line composer against real git repositories. */
import {
  type CommitSha,
  type LineBatch,
  LineCompositionBodySchema,
  LineParkBodySchema,
  type LineRecord,
  type ProgramId,
  ProgramIdSchema,
} from "@nightshift/contracts";
import {
  appendQueueEntry,
  createFixtures,
  makeLineRecord,
  settleBatch,
  takeBatch,
} from "@nightshift/core";
import {
  composeLineBatch,
  drainLine,
  type LineBatchOutcome,
  type LineCheckoutPort,
  type LineComposerPorts,
  type LineFailure,
  type LineResolution,
  type LineSettlement,
  type LineVerifierPort,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createLineRepo, type LineRepo, makeFakeVerifier } from "./line-repo.js";

const P1 = ProgramIdSchema.parse("prog_01J0000000000000000000000A");
const P2 = ProgramIdSchema.parse("prog_01J0000000000000000000000B");
const START = Date.parse("2026-10-01T00:00:00.000Z");

const repos: LineRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
});

const entry = (program: ProgramId, upTo: CommitSha, minute: number) => ({
  program,
  upTo,
  enqueuedAt: new Date(START + minute * 60_000).toISOString(),
});
const batchOf = (entries: LineBatch["entries"], batchId = "b1"): LineBatch => ({
  batchId,
  entries,
  takenAt: new Date(START).toISOString(),
  generation: 1,
});

interface Harness {
  lr: LineRepo;
  ports: LineComposerPorts;
  settled: LineSettlement[];
  published: { head: CommitSha; expectedPredecessor: CommitSha }[];
  staged: { head: CommitSha; expectedPredecessor: CommitSha }[];
  resolves: LineFailure[];
  verifies: { commit: CommitSha; deadline?: string }[];
  open: Set<string>;
  now: { ms: number };
  queue: LineBatch[];
  lastComposed: Record<string, CommitSha | undefined>;
}

const setup = async (
  opts: {
    passes?: (read: (path: string) => Promise<string | undefined>) => boolean | Promise<boolean>;
    resolve?: (failure: LineFailure, h: Harness) => Promise<LineResolution> | LineResolution;
    reject?: boolean;
    stageThrows?: boolean;
    advanceOnVerify?: number;
    timedOut?: boolean;
  } = {},
): Promise<Harness> => {
  const lr = await createLineRepo({ programs: ["p1", "p2"] });
  repos.push(lr);
  const inner = lr.checkout();
  const open = new Set<string>();
  const checkout: LineCheckoutPort = {
    ...inner,
    open: async (base) => {
      const wt = await inner.open(base);
      open.add(wt.path);
      return wt;
    },
    close: async (wt) => {
      open.delete(wt.path);
      await inner.close(wt);
    },
  };
  const fake = makeFakeVerifier(lr, (_c, read) => (opts.passes ? opts.passes(read) : true));
  const now = { ms: START };
  const h = {
    lr,
    settled: [],
    published: [],
    staged: [],
    resolves: [],
    verifies: [],
    open,
    now,
    queue: [],
    lastComposed: {},
  } as unknown as Harness;
  const verifier: LineVerifierPort = {
    async verify(input) {
      h.verifies.push({
        commit: input.commit,
        ...(input.deadline ? { deadline: input.deadline } : {}),
      });
      const result = await fake.verify(input);
      now.ms += opts.advanceOnVerify ?? 0;
      return opts.timedOut ? { ...result, timedOut: true } : result;
    },
  };
  h.ports = {
    queue: {
      takeBatch: async () => h.queue.shift(),
      lastComposed: async (program) => h.lastComposed[program],
      settle: async (s) => {
        h.settled.push(s);
      },
    },
    checkout,
    verifier,
    publisher: {
      stage: async (input) => {
        if (opts.stageThrows) throw new Error("upload failed");
        h.staged.push(input);
        return { bundleKey: `bundles/${input.head}` };
      },
      outcome: async (input) => {
        h.published.push({
          head: input.head,
          expectedPredecessor: h.staged.at(-1)?.expectedPredecessor as CommitSha,
        });
        return opts.reject ? { status: "rejected", detail: "moved" } : { status: "published" };
      },
    },
    resolve: async (failure) => {
      h.resolves.push(failure);
      if (!opts.resolve) throw new Error("unexpected resolve");
      return opts.resolve(failure, h);
    },
    clock: { now: () => now.ms },
  };
  return h;
};

const assertSchemas = (h: Harness) => {
  for (const s of h.settled) {
    if (s.composition)
      expect(
        LineCompositionBodySchema.safeParse({
          batchId: s.batchId,
          ...s.composition,
        }).success,
      ).toBe(true);
    for (const p of s.parked)
      expect(LineParkBodySchema.safeParse({ batchId: s.batchId, ...p }).success).toBe(true);
  }
};

const isAnc = async (lr: LineRepo, a: CommitSha, d: CommitSha) => lr.checkout().isAncestor(a, d);

describe("composeLineBatch", () => {
  it("composes two programs and main into one verified composition", async () => {
    const h = await setup();
    const { lr } = h;
    const line = await lr.commit("line", { "l.txt": "l\n" });
    const main = await lr.commit("main", { "m.txt": "m\n" });
    const a = await lr.commit("p1", { "a.txt": "a\n" });
    const b = await lr.commit("p2", { "b.txt": "b\n" });
    const out = await composeLineBatch(h.ports, {
      lineHead: line,
      mainHead: main,
      batch: batchOf([entry(P1, a, 1), entry(P2, b, 2)]),
    });
    expect(h.settled).toHaveLength(1);
    const c = h.settled[0]?.composition;
    expect(c?.parent).toBe(line);
    expect(c?.verification.outcome).toBe("passed");
    expect(c?.ranges).toEqual([
      { program: P1, upTo: a },
      { program: P2, upTo: b },
    ]);
    for (const x of [main, a, b]) expect(await isAnc(lr, x, c?.commit as CommitSha)).toBe(true);
    expect(h.settled[0]?.parked).toEqual([]);
    expect(h.published).toEqual([{ head: c?.commit, expectedPredecessor: line }]);
    expect(h.settled[0]?.push).toEqual({
      head: c?.commit,
      expectedPredecessor: line,
      bundleKey: `bundles/${c?.commit}`,
    });
    expect(out.head).toBe(c?.commit);
    expect(h.open.size).toBe(0);
    assertSchemas(h);
  });

  it("makes one range per program from the last entry and lastComposed", async () => {
    const h = await setup();
    const a1 = await h.lr.commit("p1", { "a.txt": "1\n" });
    h.lastComposed[P1] = a1;
    const a = a1;
    const a_ = await h.lr.commit("p1", { "a2.txt": "2\n" });
    const out = await composeLineBatch(h.ports, {
      lineHead: h.lr.initial,
      mainHead: h.lr.initial,
      batch: batchOf([entry(P1, a, 1), entry(P1, a_, 2)]),
    });
    expect(out.composed).toEqual([{ program: P1, from: a1, upTo: a_ }]);
  });

  it("composes one at a time on a conflict and resolves only the failing range", async () => {
    const h = await setup({
      resolve: async (f) => ({
        kind: "resolved",
        commit: f.base,
        verification: (await h2(f)).verification,
        resolver: { decision: "resolved", attempts: 1 },
        decision: undefined as never,
      }),
    });
    async function h2(f: LineFailure) {
      return h.ports.verifier.verify({
        worktree: { path: "" },
        commit: f.base,
        base: f.base,
      });
    }
    const { lr } = h;
    const a = await lr.commit("p1", { "a.txt": "a\n" });
    const x = await lr.commit("p2", { "x.txt": "p2\n" });
    const y = await lr.commit("line", { "x.txt": "line\n" });
    const out = await composeLineBatch(h.ports, {
      lineHead: y,
      mainHead: y,
      batch: batchOf([entry(P1, a, 1), entry(P2, x, 2)]),
    });
    expect(h.resolves).toHaveLength(1);
    const f = h.resolves[0] as LineFailure;
    expect(f.unit).toEqual({ kind: "range", range: { program: P2, upTo: x } });
    expect(f.cause.kind).toBe("conflict");
    expect(f.base).not.toBe(y);
    expect(await isAnc(lr, a, f.base)).toBe(true);
    expect(out.composed).toHaveLength(2);
    const c = h.settled[0]?.composition;
    expect(c?.resolver?.decision).toBe("resolved");
    expect(c?.resolver?.detail).toContain(x);
    expect(c?.commit).toBe(f.base);
    expect(h.open.size).toBe(0);
    assertSchemas(h);
  });

  it("falls back on a red batch, parks the failing range and still composes the rest", async () => {
    const h = await setup({
      passes: async (read) => (await read("bad.txt")) === undefined,
      resolve: () => ({
        kind: "parked",
        reason: "could not fix",
        resolver: { decision: "gave_up", attempts: 2, detail: "tried" },
      }),
    });
    const { lr } = h;
    const a = await lr.commit("p1", { "a.txt": "a\n" });
    const b = await lr.commit("p2", { "bad.txt": "x\n" });
    const out = await composeLineBatch(h.ports, {
      lineHead: lr.initial,
      mainHead: lr.initial,
      batch: batchOf([entry(P1, a, 1), entry(P2, b, 2)]),
    });
    expect(h.resolves).toHaveLength(1);
    const f = h.resolves[0] as LineFailure;
    expect(f.unit).toEqual({ kind: "range", range: { program: P2, upTo: b } });
    expect(f.cause.kind === "red" && f.cause.logs[0]?.tail).toBe("red");
    const s = h.settled[0];
    expect(s?.parked).toHaveLength(1);
    expect(s?.parked[0]?.reason).toBe("could not fix");
    expect(s?.parked[0]?.resolver?.decision).toBe("gave_up");
    expect(s?.composition?.ranges).toEqual([{ program: P1, upTo: a }]);
    expect(out.head).toBe(s?.composition?.commit);
    expect(h.published).toHaveLength(1);
    expect(h.open.size).toBe(0);
    assertSchemas(h);
  });

  it("settles nothing for ranges already on the line", async () => {
    const h = await setup();
    const a = await h.lr.commit("p1", { "a.txt": "a\n" });
    const line = await h.lr.commit("line", { "a.txt": "a\n" });
    const out = await composeLineBatch(h.ports, {
      lineHead: line,
      mainHead: line,
      batch: batchOf([entry(P1, h.lr.initial, 1)]),
    });
    void a;
    expect(h.settled).toEqual([{ batchId: "b1", parked: [] }]);
    expect(h.published).toEqual([]);
    expect(out.head).toBe(line);
  });

  it("publishes nothing when main merges but every range parks", async () => {
    const h = await setup({
      passes: async (read) => (await read("bad.txt")) === undefined,
      resolve: () => ({
        kind: "parked",
        reason: "no",
        resolver: { decision: "gave_up", attempts: 1 },
      }),
    });
    const { lr } = h;
    const main = await lr.commit("main", { "m.txt": "m\n" });
    const b = await lr.commit("p2", { "bad.txt": "x\n" });
    const out = await composeLineBatch(h.ports, {
      lineHead: lr.initial,
      mainHead: main,
      batch: batchOf([entry(P2, b, 1)]),
    });
    expect(h.settled[0]?.composition).toBeUndefined();
    expect(h.settled[0]?.parked).toHaveLength(1);
    expect(h.published).toEqual([]);
    expect(out.head).toBe(lr.initial);
    expect(h.open.size).toBe(0);
    assertSchemas(h);
  });

  it("uses one deadline and parks the rest once it passes", async () => {
    const h = await setup({
      passes: async (read) =>
        (await read("bad1.txt")) === undefined && (await read("bad2.txt")) === undefined,
      advanceOnVerify: 1000,
      resolve: (_f, hh) => {
        hh.now.ms += 3_600_000;
        return {
          kind: "parked",
          reason: "no",
          resolver: { decision: "gave_up", attempts: 1 },
        };
      },
    });
    const { lr } = h;
    const b1 = await lr.commit("p1", { "bad1.txt": "x\n" });
    const b2 = await lr.commit("p2", { "bad2.txt": "x\n" });
    const out = await composeLineBatch(h.ports, {
      lineHead: lr.initial,
      mainHead: lr.initial,
      batch: batchOf([entry(P1, b1, 1), entry(P2, b2, 2)]),
    });
    const deadline = new Date(START + 3600_000).toISOString();
    expect(h.resolves.map((f) => f.deadline)).toEqual([deadline]);
    expect(h.verifies.every((v) => v.deadline === deadline)).toBe(true);
    const verifiesBefore = h.verifies.length;
    expect(out.parked).toHaveLength(2);
    expect(out.parked[1]?.reason).toContain("time limit");
    expect(h.verifies.length).toBe(verifiesBefore);
    expect(h.published).toEqual([]);
  });

  it("passes the same deadline to every resolve", async () => {
    const h = await setup({
      passes: async (read) =>
        (await read("bad1.txt")) === undefined && (await read("bad2.txt")) === undefined,
      resolve: () => ({
        kind: "parked",
        reason: "no",
        resolver: { decision: "gave_up", attempts: 1 },
      }),
    });
    const { lr } = h;
    const a = await lr.commit("p1", { "a.txt": "a\n" });
    const b1 = await lr.commit("p1", { "bad1.txt": "x\n" });
    const b2 = await lr.commit("p2", { "bad2.txt": "x\n" });
    void a;
    await composeLineBatch(h.ports, {
      lineHead: lr.initial,
      mainHead: lr.initial,
      batch: batchOf([entry(P1, b1, 1), entry(P2, b2, 2)]),
    });
    expect(h.resolves).toHaveLength(2);
    expect(h.resolves[0]?.deadline).toBe(h.resolves[1]?.deadline);
  });

  it("parks a green batch that finished after the deadline or timed out", async () => {
    for (const opts of [{ advanceOnVerify: 3_700_000 }, { timedOut: true }]) {
      const h = await setup(opts);
      const a = await h.lr.commit("p1", { "a.txt": "a\n" });
      const out = await composeLineBatch(h.ports, {
        lineHead: h.lr.initial,
        mainHead: h.lr.initial,
        batch: batchOf([entry(P1, a, 1)]),
      });
      expect(h.published).toEqual([]);
      expect(h.resolves).toEqual([]);
      expect(h.verifies).toHaveLength(1);
      expect(out.parked[0]?.reason).toContain("time limit");
      expect(h.settled[0]?.composition).toBeUndefined();
      expect(h.open.size).toBe(0);
      assertSchemas(h);
    }
  });
});

describe("drainLine", () => {
  it("drains batches until the queue is empty", async () => {
    const h = await setup();
    const a = await h.lr.commit("p1", { "a.txt": "a\n" });
    let head = h.lr.initial;
    h.queue.push(batchOf([entry(P1, a, 1)], "b1"));
    const b = await h.lr.commit("p2", { "b.txt": "b\n" });
    h.queue.push(batchOf([entry(P2, b, 2)], "b2"));
    const outs: LineBatchOutcome[] = await drainLine(h.ports, async () => {
      const r = { lineHead: head, mainHead: h.lr.initial };
      return r;
    }).then((o) => {
      return o;
    });
    void head;
    head = h.lr.initial;
    expect(outs.map((o) => o.batchId)).toEqual(["b1", "b2"]);
    expect(h.published).toHaveLength(2);
  });

  it("stops after a rejected publication", async () => {
    const h = await setup({ reject: true });
    const a = await h.lr.commit("p1", { "a.txt": "a\n" });
    h.queue.push(batchOf([entry(P1, a, 1)], "b1"), batchOf([entry(P1, a, 1)], "b2"));
    const outs = await drainLine(h.ports, async () => ({
      lineHead: h.lr.initial,
      mainHead: h.lr.initial,
    }));
    expect(outs).toHaveLength(1);
    expect(h.queue).toHaveLength(1);
  });

  it("settles nothing when staging throws, and the batch can be composed again", async () => {
    const opts = { stageThrows: true };
    const h = await setup(opts);
    const line = await h.lr.commit("line", { "l.txt": "l\n" });
    const a = await h.lr.commit("p1", { "a.txt": "a\n" });
    const batch = batchOf([entry(P1, a, 1)]);
    await expect(
      composeLineBatch(h.ports, { lineHead: line, mainHead: line, batch }),
    ).rejects.toThrow("upload failed");
    expect(h.settled).toEqual([]);
    expect(h.open.size).toBe(0);
    opts.stageThrows = false;
    const out = await composeLineBatch(h.ports, {
      lineHead: line,
      mainHead: line,
      batch,
    });
    expect(out.composed).toHaveLength(1);
  });

  it("gives two conflicting ranges one shared budget of three resolver attempts", async () => {
    const h = await setup({
      resolve: async (f) => ({
        kind: "parked",
        reason: "no luck",
        resolver: { decision: "gave_up", attempts: f.attemptsLeft },
      }),
    });
    const line = await h.lr.commit("line", { "x.txt": "base\n" });
    const a = await h.lr.commit("p1", { "x.txt": "a\n" });
    const b = await h.lr.commit("p2", { "x.txt": "b\n" });
    const out = await composeLineBatch(h.ports, {
      lineHead: line,
      mainHead: line,
      batch: batchOf([entry(P1, a, 1), entry(P2, b, 2)]),
    });
    expect(h.resolves.map((f) => f.attemptsLeft)).toEqual([3]);
    expect(out.parked.map((p) => p.ranges.length)).toEqual([1, 1]);
    expect(out.parked.some((p) => p.reason.includes("resolver attempts are spent"))).toBe(true);
  });

  it("leaves a pending push to the composition and no batch when the owner dies after settling", async () => {
    const h = await setup();
    const fixtures = createFixtures();
    const at = new Date(START).toISOString();
    const line = await h.lr.commit("line", { "l.txt": "l\n" });
    const a = await h.lr.commit("p1", { "a.txt": "a\n" });
    let record: LineRecord = appendQueueEntry(
      makeLineRecord(fixtures),
      { program: P1, upTo: a },
      at,
    );
    // The real rules over an in-memory record.
    let outcomeCalls = 0;
    h.ports.queue.takeBatch = async () => {
      const taken = takeBatch(record, 1, { batchId: "b1" }, at);
      record = taken.record;
      return taken.batch ?? record.batch;
    };
    h.ports.queue.settle = async (s) => {
      const change = settleBatch(record, s, { compositionId: "comp-1", parkedIds: [] }, 1, at);
      if (!change.ok) throw new Error("settle refused");
      record = change.record;
    };
    h.ports.publisher.outcome = async () => {
      outcomeCalls += 1;
      throw new Error("owner died");
    };
    const batch = (await h.ports.queue.takeBatch()) as LineBatch;
    await expect(
      composeLineBatch(h.ports, { lineHead: line, mainHead: line, batch }),
    ).rejects.toThrow("owner died");
    expect(outcomeCalls).toBe(1);
    const commit = record.compositions[0]?.commit;
    expect(record.batch).toBeUndefined();
    expect(record.compositions).toHaveLength(1);
    expect(record.push).toMatchObject({
      status: "pending",
      head: commit,
      expectedPredecessor: line,
    });
  });
});
