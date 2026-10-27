/** The line verifier on real trivial shell steps in a real git checkout. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CommitSha, LineVerificationSchema, stepRunsAt } from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixedClock,
  isLandingEvidence,
  systemClock,
} from "@nightshift/core";
import {
  createLineVerifier,
  type GateDefinitions,
  LINE_LOG_TAIL_CHARS,
  type LineVerifierPort,
  nodeGitRunner,
} from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createLineRepo, type LineRepo } from "./line-repo.js";

const repos: LineRepo[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const node = (code: string): string => `node -e "${code}"`;

const setup = async (
  gates: GateDefinitions,
  files: Record<string, string> = { "seed.txt": "seed\n" },
  clock: { now(): number } = systemClock,
) => {
  const lr = await createLineRepo();
  repos.push(lr);
  const commit = await lr.commit("line", files);
  const wt = await lr.checkout().open(commit);
  const scratchRoot = await mkdtemp(join(tmpdir(), "line-verifier-scratch-"));
  dirs.push(scratchRoot);
  const verifier: LineVerifierPort = createLineVerifier({
    gates,
    ids: createCountingIdGenerator(),
    clock,
    runner: nodeGitRunner,
    paths: {
      scratch: (checkout) => join(scratchRoot, Buffer.from(checkout).toString("hex").slice(-40)),
    },
  });
  return { lr, commit, wt, verifier, base: lr.initial };
};

describe("createLineVerifier", () => {
  it("passes when every step exits 0, and the record is a schema-valid line verification", async () => {
    const { verifier, wt, commit, base } = await setup({
      setup: [{ id: "prep", command: node("0") }],
      verification: [
        { id: "a", command: node("console.log(1)") },
        { id: "b", command: node("0") },
      ],
    });
    const result = await verifier.verify({ worktree: wt, commit, base });
    expect(LineVerificationSchema.safeParse(result.verification).success).toBe(true);
    expect(result.verification.phase).toBe("line");
    expect(result.verification.outcome).toBe("passed");
    expect(result.verification.commitSha).toBe(commit);
    expect(result.verification.baseSha).toBe(base);
    expect(result.verification.commands.map((c) => c.stepId)).toEqual(["setup:prep", "a", "b"]);
    expect(result.timedOut).toBe(false);
    expect(isLandingEvidence("line")).toBe(false);
  });

  it("a failing step fails with its exit code and the tail of its output", async () => {
    const long = "x".repeat(LINE_LOG_TAIL_CHARS + 100);
    const { verifier, wt, commit, base } = await setup({
      setup: [],
      verification: [
        { id: "red", command: node(`console.log('${long}'+'EN'+'D');process.exit(3)`) },
        { id: "after", command: node("0") },
      ],
    });
    const result = await verifier.verify({ worktree: wt, commit, base });
    expect(result.verification.outcome).toBe("failed");
    expect(result.verification.commands.find((c) => c.stepId === "red")?.exitCode).toBe(3);
    const log = result.logs.find((l) => l.stepId === "red");
    expect(log?.exitCode).toBe(3);
    expect(log?.tail.length).toBeLessThanOrEqual(LINE_LOG_TAIL_CHARS);
    expect(log?.tail).toContain("END");
    expect(JSON.stringify(result.verification)).not.toContain("END");
  });

  it("never runs a step declared at end", async () => {
    const { verifier, wt, commit, base } = await setup({
      setup: [],
      verification: [
        { id: "now", command: node("0") },
        { id: "later", command: node("process.exit(1)"), at: "end" },
      ],
    });
    expect(stepRunsAt({ at: "end" })).toBe("end");
    const result = await verifier.verify({ worktree: wt, commit, base });
    expect(result.verification.outcome).toBe("passed");
    expect(result.verification.commands.map((c) => c.stepId)).toEqual(["now"]);
  });

  it("decides on the commit alone, not on uncommitted, untracked or ignored files", async () => {
    const check = node("process.exit(require('fs').existsSync('marker')?0:1)");
    const { verifier, wt, commit, base } = await setup(
      { setup: [], verification: [{ id: "marker", command: check }] },
      { ".gitignore": "ignored.txt\n", "tracked.txt": "one\n" },
    );
    await writeFile(join(wt.path, "marker"), "x");
    await writeFile(join(wt.path, "ignored.txt"), "x");
    await mkdir(join(wt.path, "sub"), { recursive: true });
    await writeFile(join(wt.path, "tracked.txt"), "changed\n");
    const result = await verifier.verify({ worktree: wt, commit, base });
    expect(result.verification.outcome).toBe("failed");
  });

  it("stops a step still running at the deadline", async () => {
    const { verifier, wt, commit, base } = await setup({
      setup: [],
      verification: [
        { id: "slow", command: node("setTimeout(()=>{},60000)"), cleanupSeconds: 1 },
        { id: "never", command: node("0") },
      ],
    });
    const started = Date.now();
    const result = await verifier.verify({
      worktree: wt,
      commit,
      base,
      deadline: new Date(started + 1000).toISOString(),
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.timedOut).toBe(true);
    expect(result.verification.outcome).not.toBe("passed");
    expect(result.verification.commands.map((c) => c.stepId)).toEqual(["slow"]);
  });

  it("runs no step when the deadline has already passed", async () => {
    const { verifier, wt, commit, base, lr } = await setup({
      setup: [],
      verification: [{ id: "a", command: node("require('fs').writeFileSync('ran','1')") }],
    });
    const result = await verifier.verify({
      worktree: wt,
      commit,
      base,
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    expect(result.timedOut).toBe(true);
    expect(result.verification.outcome).not.toBe("passed");
    expect(await lr.readFileAtCommit(commit, "ran")).toBeUndefined();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(wt.path, "ran"))).toBe(false);
  });

  it("tells steps the commit and base, and keeps a log id only from recordLog", async () => {
    const lr = await createLineRepo();
    repos.push(lr);
    const commit = await lr.commit("line", { x: "1" });
    const wt = await lr.checkout().open(commit);
    const scratchRoot = await mkdtemp(join(tmpdir(), "line-verifier-scratch-"));
    dirs.push(scratchRoot);
    const verifier = createLineVerifier({
      gates: {
        setup: [],
        verification: [
          {
            id: "facts",
            command: node(
              `process.exit(process.env.NIGHTSHIFT_BASE_SHA==='${lr.initial}'&&process.env.NIGHTSHIFT_HEAD_SHA==='${commit}'?0:1)`,
            ),
          },
        ],
      },
      ids: createCountingIdGenerator(),
      clock: createFixedClock(Date.parse("2026-10-01T00:00:00.000Z")),
      runner: nodeGitRunner,
      paths: { scratch: () => join(scratchRoot, "s") },
      recordLog: async () => "art_01J0000000000000000000000A" as never,
    });
    const result = await verifier.verify({
      worktree: wt,
      commit: commit as CommitSha,
      base: lr.initial,
    });
    expect(result.verification.outcome).toBe("passed");
    expect(result.verification.commands[0]?.logArtifactId).toBe("art_01J0000000000000000000000A");
  });

  it("runs every setup and landing step through `as`, with the worktree and scratch granted first and reclaimed after", async () => {
    const lr = await createLineRepo();
    repos.push(lr);
    const commit = await lr.commit("line", { x: "1" });
    const wt = await lr.checkout().open(commit);
    const scratchRoot = await mkdtemp(join(tmpdir(), "line-verifier-scratch-"));
    dirs.push(scratchRoot);
    const trace: string[] = [];
    const verifier = createLineVerifier({
      gates: {
        setup: [{ id: "prep", command: node("0") }],
        verification: [
          { id: "a", command: node("0") },
          { id: "b", command: node("0") },
        ],
      },
      ids: createCountingIdGenerator(),
      clock: systemClock,
      runner: nodeGitRunner,
      paths: { scratch: () => join(scratchRoot, "s") },
      grant: async (path) => {
        trace.push(`grant:${path}`);
      },
      reclaim: async (path) => {
        trace.push(`reclaim:${path}`);
      },
      as: (invocation) => {
        trace.push("as");
        return invocation;
      },
    });
    const result = await verifier.verify({ worktree: wt, commit, base: lr.initial });
    expect(result.verification.outcome).toBe("passed");
    expect(trace.filter((e) => e === "as")).toHaveLength(3);
    const root = dirname(wt.path);
    expect(trace.indexOf(`grant:${root}`)).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf(`grant:${root}`)).toBeLessThan(trace.indexOf("as"));
    expect(trace.indexOf(`grant:${join(scratchRoot, "s")}`)).toBeLessThan(trace.indexOf("as"));
    expect(trace.lastIndexOf("as")).toBeLessThan(trace.indexOf(`reclaim:${root}`));
  });
});
