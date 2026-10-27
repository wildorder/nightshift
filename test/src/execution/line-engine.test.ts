/**
 * The line engine end to end, offline: drainLine with the real resolver, the
 * real verifier and the real checkout over a real git repository. The queue,
 * publisher, decision port and agents are in-memory fakes.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommitSha,
  type LineBatch,
  LineCompositionBodySchema,
  LineParkBodySchema,
  type LineVerification,
  type ProgramId,
  ProgramIdSchema,
} from "@nightshift/contracts";
import { createCountingIdGenerator } from "@nightshift/core";
import {
  createLineVerifier,
  drainLine,
  type LineBatchOutcome,
  type LineComposerPorts,
  type LineResolverAgentPort,
  type LineResolverDecision,
  type LineSettlement,
  nodeGitRunner,
  resolveLineFailure,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createLineRepo, type LineRepo } from "./line-repo.js";

const P1 = ProgramIdSchema.parse("prog_01J0000000000000000000000A");
const P2 = ProgramIdSchema.parse("prog_01J0000000000000000000000B");
const P3 = ProgramIdSchema.parse("prog_01J0000000000000000000000C");
const START = Date.parse("2026-10-01T00:00:00.000Z");
const MINUTE = 60_000;

/** Fails when a .txt file holds the marker, unless an (ignored) override file exists. */
const CHECK =
  "node -e \"const fs=require('fs');const t=fs.readdirSync('.').filter(f=>f.endsWith('.txt')).map(f=>fs.readFileSync(f,'utf8')).join('');if(t.includes('BROKEN')&&!fs.existsSync('override.ign')){console.log('found the BROKEN marker');process.exit(1)}\"";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const batchOf = (batchId: string, entries: [ProgramId, CommitSha][]): LineBatch => ({
  batchId,
  entries: entries.map(([program, upTo], i) => ({
    program,
    upTo,
    enqueuedAt: new Date(START + i * MINUTE).toISOString(),
  })),
  takenAt: new Date(START).toISOString(),
  generation: 1,
});

type AgentStep = (
  call: { brief: string; worktree: { path: string }; n: number },
  now: { ms: number },
) => Promise<{ status?: "finished" | "failed"; model?: string }>;

const setup = async (
  opts: { agent?: AgentStep; examiner?: (input: { model: string }) => string } = {},
) => {
  const lr: LineRepo = await createLineRepo();
  cleanups.push(() => lr.close());
  const scratchRoot = await mkdtemp(join(tmpdir(), "line-engine-scratch-"));
  cleanups.push(() => rm(scratchRoot, { recursive: true, force: true }));
  const lineHead0 = await lr.commit("line", { ".gitignore": "*.ign\n" }, "line seed");
  const line = { head: lineHead0 };
  const now = { ms: START };
  const clock = { now: () => now.ms };
  const checkout = lr.checkout();

  const verifications: LineVerification[] = [];
  const realVerifier = createLineVerifier({
    gates: { setup: [], verification: [{ id: "check", command: CHECK }] },
    ids: createCountingIdGenerator(),
    clock,
    runner: nodeGitRunner,
    paths: {
      scratch: (dir) => join(scratchRoot, Buffer.from(dir).toString("hex").slice(-40)),
    },
  });
  const verifier: typeof realVerifier = {
    async verify(input) {
      const result = await realVerifier.verify(input);
      verifications.push(result.verification);
      return result;
    },
  };

  const briefs: string[] = [];
  const decisions: LineResolverDecision[] = [];
  const examined: { model: string; avoidModel: string }[] = [];
  let agentCalls = 0;
  const agents: LineResolverAgentPort = {
    async resolve({ brief, worktree }) {
      agentCalls += 1;
      briefs.push(brief);
      const out = (await opts.agent?.({ brief, worktree, n: agentCalls }, now)) ?? {};
      return {
        model: out.model ?? "model-a",
        status: out.status ?? "finished",
      };
    },
    async examine({ avoidModel }) {
      const model = opts.examiner?.({ model: avoidModel }) ?? "model-b";
      examined.push({ model, avoidModel });
      return { model, verdict: "approved", findings: [] };
    },
  };

  const settled: LineSettlement[] = [];
  const published: { head: CommitSha; expectedPredecessor: CommitSha }[] = [];
  const queue: LineBatch[] = [];
  const lastComposed: Record<string, CommitSha | undefined> = {};
  const ports: LineComposerPorts = {
    queue: {
      takeBatch: async () => queue.shift(),
      lastComposed: async (program) => lastComposed[program],
      settle: async (s) => {
        settled.push(s);
      },
    },
    checkout,
    verifier,
    publisher: {
      stage: async (input) => ({ bundleKey: `bundles/${input.head}` }),
      outcome: async ({ head }) => {
        const push = settled.at(-1)?.push;
        published.push({
          head,
          expectedPredecessor: push?.expectedPredecessor as CommitSha,
        });
        line.head = head;
        return { status: "published" };
      },
    },
    resolve: (failure) =>
      resolveLineFailure(
        {
          checkout,
          verifier,
          agents,
          decisions: { record: async (d) => void decisions.push(d) },
          clock,
        },
        failure,
      ),
    clock,
  };
  const drain = (): Promise<LineBatchOutcome[]> =>
    drainLine(ports, async () => ({
      lineHead: line.head,
      mainHead: lr.initial,
    }));
  const assertSchemas = () => {
    for (const s of settled) {
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
  return {
    lr,
    line,
    now,
    queue,
    lastComposed,
    settled,
    published,
    verifications,
    briefs,
    decisions,
    examined,
    agentCalls: () => agentCalls,
    drain,
    assertSchemas,
  };
};

describe("the line engine, end to end", () => {
  it("a green batch gives one published composition recording its members", async () => {
    const t = await setup();
    const p1a = await t.lr.commit("p1", { "a.txt": "one\n" });
    const p1b = await t.lr.commit("p1", { "a2.txt": "two\n" });
    const p2 = await t.lr.commit("p2", { "b.txt": "b\n" });
    t.lastComposed[P1] = p1a;
    t.queue.push(
      batchOf("b1", [
        [P1, p1b],
        [P2, p2],
      ]),
    );
    const before = t.line.head;
    const outcomes = await t.drain();
    expect(outcomes).toHaveLength(1);
    expect(t.published).toHaveLength(1);
    expect(t.published[0]?.expectedPredecessor).toBe(before);
    expect(t.settled).toHaveLength(1);
    const composition = t.settled[0]?.composition;
    expect(composition?.ranges).toEqual([
      { program: P1, from: p1a, upTo: p1b },
      { program: P2, upTo: p2 },
    ]);
    expect(composition?.parent).toBe(before);
    expect(composition?.commit).toBe(t.published[0]?.head);
    expect(composition?.verification.phase).toBe("line");
    expect(composition?.verification.outcome).toBe("passed");
    expect(composition?.resolver).toBeUndefined();
    t.assertSchemas();
  });

  it("composes a conflicting range one at a time, fixed by a checked and examined resolver", async () => {
    const t = await setup({
      agent: async ({ worktree }) => {
        await writeFile(join(worktree.path, "a.txt"), "merged\n", "utf8");
        return {};
      },
    });
    const p1 = await t.lr.commit("p1", { "a.txt": "from p1\n" });
    const p2 = await t.lr.commit("p2", {
      "a.txt": "from p2\n",
      "b.txt": "b\n",
    });
    t.queue.push(
      batchOf("b1", [
        [P1, p1],
        [P2, p2],
      ]),
    );
    const outcomes = await t.drain();
    expect(outcomes[0]?.composed).toHaveLength(2);
    expect(outcomes[0]?.parked).toEqual([]);
    expect(t.agentCalls()).toBe(1);
    // The resolver was given the conflicting range at the line head with p1 merged.
    const decision = t.decisions[0];
    expect(t.decisions).toHaveLength(1);
    expect(decision?.authority).toBe("line");
    expect(decision?.attempts).toBe(1);
    expect(decision?.unit).toEqual({
      kind: "range",
      range: { program: P2, upTo: p2 },
    });
    expect(decision?.base).not.toBe(t.settled[0]?.composition?.parent);
    expect(await t.lr.readFileAtCommit(decision?.base as CommitSha, "a.txt")).toBe("from p1\n");
    // Checked by the verifier and examined by a different model.
    expect(
      t.verifications.some((v) => v.commitSha === decision?.commit && v.outcome === "passed"),
    ).toBe(true);
    expect(t.examined).toEqual([{ model: "model-b", avoidModel: "model-a" }]);
    expect(decision?.resolverModel).not.toBe(decision?.examinerModel);
    // The published head holds everything.
    const head = t.published[0]?.head as CommitSha;
    expect(await t.lr.readFileAtCommit(head, "a.txt")).toBe("merged\n");
    expect(await t.lr.readFileAtCommit(head, "b.txt")).toBe("b\n");
    expect(t.settled[0]?.composition?.resolver?.decision).toBe("resolved");
    t.assertSchemas();
  });

  it("parks a red range after 3 attempts, whatever an agent leaves in ignored files, and moves on", async () => {
    const t = await setup({
      agent: async ({ worktree, n }) => {
        // Still broken (a different tree each time), plus an ignored file that would pass a dirty check.
        await writeFile(join(worktree.path, "a.txt"), `BROKEN again ${n}\n`, "utf8");
        await writeFile(join(worktree.path, "override.ign"), "x\n", "utf8");
        return {};
      },
    });
    const p1 = await t.lr.commit("p1", { "a.txt": "BROKEN\n" });
    const p2 = await t.lr.commit("p2", { "b.txt": "b\n" });
    t.queue.push(batchOf("b1", [[P1, p1]]), batchOf("b2", [[P2, p2]]));
    const outcomes = await t.drain();
    expect(outcomes).toHaveLength(2);
    expect(t.agentCalls()).toBe(3);
    // The failing step's own output reached the brief.
    expect(t.briefs[0]).toContain("found the BROKEN marker");
    expect(t.briefs[0]).toContain(CHECK);
    expect(t.briefs[2]).toContain("Attempt 2:");
    // Each candidate was rejected by the real verifier.
    const failed = t.verifications.filter((v) => v.outcome === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(4); // batch, unit, and three candidates
    expect(t.decisions).toEqual([]);
    expect(t.examined).toEqual([]);
    // Parked, nothing published for it.
    expect(t.settled[0]?.composition).toBeUndefined();
    expect(t.settled[0]?.parked).toHaveLength(1);
    expect(t.settled[0]?.parked[0]?.resolver).toEqual({
      decision: "gave_up",
      attempts: 3,
    });
    expect(outcomes[0]?.published).toBeUndefined();
    // The queue moved on to the next batch, which published.
    expect(t.published).toHaveLength(1);
    expect(t.settled[1]?.composition?.ranges).toEqual([{ program: P2, upTo: p2 }]);
    expect(await t.lr.readFileAtCommit(t.line.head, "b.txt")).toBe("b\n");
    t.assertSchemas();
  });

  it("shares one hour between failing ranges, then parks what remains", async () => {
    const t = await setup({
      agent: async ({ worktree, n }, now) => {
        now.ms += (n === 1 ? 40 : 30) * MINUTE;
        if (n === 1) await writeFile(join(worktree.path, "a.txt"), "fixed\n", "utf8");
        else await writeFile(join(worktree.path, "b.txt"), "BROKEN still\n", "utf8");
        return {};
      },
    });
    const p1 = await t.lr.commit("p1", { "a.txt": "BROKEN\n" });
    const p2 = await t.lr.commit("p2", { "b.txt": "BROKEN\n" });
    const p3 = await t.lr.commit("p3", { "c.txt": "c\n" });
    t.queue.push(
      batchOf("b1", [
        [P1, p1],
        [P2, p2],
        [P3, p3],
      ]),
    );
    const outcomes = await t.drain();
    expect(t.agentCalls()).toBe(2);
    expect(outcomes[0]?.composed).toEqual([{ program: P1, upTo: p1 }]);
    const parked = t.settled[0]?.parked ?? [];
    expect(parked.map((p) => p.ranges.map((r) => r.program))).toEqual([[P2], [P3]]);
    expect(parked[0]?.reason).toContain("time limit");
    expect(parked[1]?.reason).toContain("time limit");
    expect(t.settled[0]?.composition?.ranges).toEqual([{ program: P1, upTo: p1 }]);
    const head = t.published[0]?.head as CommitSha;
    expect(await t.lr.readFileAtCommit(head, "a.txt")).toBe("fixed\n");
    expect(await t.lr.readFileAtCommit(head, "c.txt")).toBeUndefined();
    t.assertSchemas();
  });

  it("publishes nothing when every range parks, and the settlement passes the schemas", async () => {
    const t = await setup({ agent: async () => ({ status: "failed" }) });
    const p1 = await t.lr.commit("p1", { "a.txt": "BROKEN\n" });
    const p2 = await t.lr.commit("p2", { "b.txt": "BROKEN\n" });
    t.queue.push(
      batchOf("b1", [
        [P1, p1],
        [P2, p2],
      ]),
    );
    const before = t.line.head;
    const outcomes = await t.drain();
    expect(t.published).toEqual([]);
    expect(t.line.head).toBe(before);
    expect(outcomes[0]?.composed).toEqual([]);
    expect(t.settled).toHaveLength(1);
    expect(t.settled[0]?.composition).toBeUndefined();
    expect(t.settled[0]?.parked).toHaveLength(2);
    expect(t.agentCalls()).toBeLessThanOrEqual(3);
    expect(t.agentCalls()).toBe(3);
    t.assertSchemas();
  });
});
