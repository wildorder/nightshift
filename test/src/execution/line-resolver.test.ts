/** The line resolver against real git repositories. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommitSha, ProgramIdSchema } from "@nightshift/contracts";
import {
  git,
  type LineCheckoutPort,
  type LineFailure,
  type LineResolverAgentPort,
  type LineResolverDecision,
  type LineResolverPorts,
  type LineVerifierPort,
  type LineWorktree,
  nodeGitRunner,
  resolveLineFailure,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createLineRepo, type LineRepo, makeFakeVerifier } from "./line-repo.js";

const P1 = ProgramIdSchema.parse("prog_01J0000000000000000000000A");
const START = Date.parse("2026-10-01T00:00:00.000Z");
const DEADLINE = new Date(START + 60_000).toISOString();

const repos: LineRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
});

interface Opts {
  edit?: (wt: LineWorktree, n: number) => Promise<void>;
  resolverStatus?: (n: number) => "finished" | "failed" | "throw";
  examine?: (n: number) => { model: string; verdict: "approved" | "rejected"; findings: string[] };
  passes?: (read: (path: string) => Promise<string | undefined>) => boolean | Promise<boolean>;
  advanceOnVerify?: number;
  attempts?: number;
}

const setup = async (opts: Opts = {}) => {
  const lr = await createLineRepo({ programs: ["p1"] });
  repos.push(lr);
  const inner = lr.checkout();
  const opened: LineWorktree[] = [];
  const open = new Set<string>();
  const checkout: LineCheckoutPort = {
    ...inner,
    open: async (base) => {
      const wt = await inner.open(base);
      opened.push(wt);
      open.add(wt.path);
      return wt;
    },
    close: async (wt) => {
      open.delete(wt.path);
      await inner.close(wt);
    },
  };
  const now = { ms: START };
  const fake = makeFakeVerifier(lr, (_c, read) => (opts.passes ? opts.passes(read) : true));
  const verifyWts: string[] = [];
  const verifier: LineVerifierPort = {
    async verify(input) {
      verifyWts.push(input.worktree.path);
      const r = await fake.verify(input);
      now.ms += opts.advanceOnVerify ?? 0;
      return r;
    },
  };
  const briefs: string[] = [];
  const agentWts: { wt: LineWorktree; head: CommitSha }[] = [];
  let resolveCalls = 0;
  let examineCalls = 0;
  const agents: LineResolverAgentPort = {
    async resolve({ brief, worktree }) {
      resolveCalls += 1;
      briefs.push(brief);
      agentWts.push({ wt: worktree, head: await inner.head(worktree) });
      const status = opts.resolverStatus?.(resolveCalls) ?? "finished";
      if (status === "throw") throw new Error("agent crashed");
      if (status === "failed") return { model: "model-a", status: "failed" };
      await opts.edit?.(worktree, resolveCalls);
      return { model: "model-a", status: "finished", summary: "kept both sides" };
    },
    async examine() {
      examineCalls += 1;
      return (
        opts.examine?.(examineCalls) ?? { model: "model-b", verdict: "approved", findings: [] }
      );
    },
  };
  const recorded: LineResolverDecision[] = [];
  const ports: LineResolverPorts = {
    checkout,
    verifier,
    agents,
    decisions: { record: async (d) => void recorded.push(d) },
    clock: { now: () => now.ms },
    ...(opts.attempts ? { limits: { attempts: opts.attempts } } : {}),
  };
  return {
    lr,
    ports,
    briefs,
    agentWts,
    recorded,
    open,
    verifyWts,
    calls: () => ({ resolve: resolveCalls, examine: examineCalls }),
  };
};

const conflict = async (lr: LineRepo) => {
  const base = await lr.commit("line", { "a.txt": "line side\n" });
  const unit = await lr.commit("p1", { "a.txt": "program side\n" });
  const failure: LineFailure = {
    unit: { kind: "range", range: { program: P1, upTo: unit } },
    base,
    deadline: DEADLINE,
    cause: { kind: "conflict", paths: ["a.txt"], detail: "CONFLICT in a.txt" },
  };
  return { base, unit, failure };
};

const mergeEdit = async (wt: LineWorktree) => {
  await writeFile(join(wt.path, "a.txt"), "both\n", "utf8");
};

describe("resolveLineFailure", () => {
  it("resolves a conflict by file edits alone", async () => {
    const h = await setup({ edit: mergeEdit });
    const { base, unit, failure } = await conflict(h.lr);
    const res = await resolveLineFailure(h.ports, failure);
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.resolver).toEqual({ decision: "resolved", attempts: 1 });
    const parents = (
      await git(nodeGitRunner, ["rev-list", "--parents", "-n", "1", res.commit], {
        cwd: h.lr.repo,
        atMs: START,
      })
    )
      .trim()
      .split(" ");
    expect(parents.slice(1)).toEqual([base, unit]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.authority).toBe("line");
    expect(h.recorded[0]?.resolverModel).not.toBe(h.recorded[0]?.examinerModel);
    expect(res.decision).toBe(h.recorded[0]);
    expect(h.agentWts[0]?.head).toBe(base);
    expect(h.briefs[0]).toContain("already in progress");
    expect(h.briefs[0]).toContain("a.txt");
    expect(h.verifyWts).toHaveLength(1);
    expect(h.verifyWts[0]).not.toBe(h.agentWts[0]?.wt.path);
    expect(h.open.size).toBe(0);
  });

  it("puts a red failure's log tails in the first brief", async () => {
    const h = await setup({
      edit: async (wt) => {
        await writeFile(join(wt.path, "fix.txt"), "fixed\n", "utf8");
      },
    });
    const base = await h.lr.commit("line", { "a.txt": "x\n" });
    const unit = await h.lr.commit("p1", { "b.txt": "y\n" });
    const candidate = await h.lr.commit("cand", { "a.txt": "x\n", "b.txt": "y\n" });
    const failure: LineFailure = {
      unit: { kind: "main", commit: unit },
      base,
      deadline: DEADLINE,
      cause: {
        kind: "red",
        candidate,
        verification: {
          verificationId: "ver_1" as never,
          phase: "line",
          commitSha: candidate,
          baseSha: base,
          commands: [{ stepId: "t", command: "npm test", exitCode: 1, durationMs: 1 }],
          outcome: "failed",
          startedAt: new Date(START).toISOString(),
          endedAt: new Date(START).toISOString(),
        },
        logs: [{ stepId: "t", command: "npm test", exitCode: 1, tail: "TAIL-MARKER boom" }],
      },
    };
    const res = await resolveLineFailure(h.ports, failure);
    expect(h.briefs[0]).toContain("TAIL-MARKER boom");
    expect(h.briefs[0]).toContain("npm test");
    expect(res.kind).toBe("resolved");
  });

  it("parks after three mixed failures with no decision and no fourth call", async () => {
    const h = await setup({
      resolverStatus: (n) => (n === 1 ? "throw" : n === 2 ? "failed" : "finished"),
    });
    const { failure } = await conflict(h.lr);
    const res = await resolveLineFailure(h.ports, failure);
    expect(res.kind).toBe("parked");
    if (res.kind !== "parked") return;
    expect(res.resolver).toEqual({ decision: "gave_up", attempts: 3 });
    expect(res.reason).toContain("attempt limit");
    expect(h.recorded).toHaveLength(0);
    expect(h.calls().resolve).toBe(3);
    expect(h.open.size).toBe(0);
  });

  it("feeds rejected findings into the next brief and never accepts the resolver's own model", async () => {
    const h = await setup({
      edit: mergeEdit,
      examine: (n) =>
        n === 1
          ? { model: "model-b", verdict: "rejected", findings: ["FINDING-ONE dropped a line"] }
          : { model: "model-a", verdict: "approved", findings: [] },
    });
    const { failure } = await conflict(h.lr);
    const res = await resolveLineFailure(h.ports, failure);
    expect(h.briefs[1]).toContain("FINDING-ONE dropped a line");
    expect(res.kind).toBe("parked");
    expect(h.recorded).toHaveLength(0);
  });

  it("parks when the verification of a candidate stays red, with the last candidate", async () => {
    const h = await setup({ edit: mergeEdit, passes: () => false });
    const { failure } = await conflict(h.lr);
    const res = await resolveLineFailure(h.ports, failure);
    expect(res.kind).toBe("parked");
    if (res.kind !== "parked") return;
    expect(res.commit).toBeDefined();
    expect(res.verification?.outcome).toBe("failed");
    expect(h.briefs[1]).toContain("red");
    expect(h.calls().examine).toBe(0);
  });

  it("starts nothing once the deadline has passed, not even examination", async () => {
    const h = await setup({ edit: mergeEdit, advanceOnVerify: 61_000 });
    const { failure } = await conflict(h.lr);
    const res = await resolveLineFailure(h.ports, failure);
    expect(res.kind).toBe("parked");
    if (res.kind !== "parked") return;
    expect(res.reason).toContain("time limit");
    expect(h.calls().examine).toBe(0);
    expect(h.calls().resolve).toBe(1);
    expect(h.open.size).toBe(0);
  });
});
