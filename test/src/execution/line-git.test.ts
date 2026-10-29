/** The line checkout adapter against a real repository. */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LineVerificationSchema } from "@nightshift/contracts";
import { git, nodeGitRunner } from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { createLineRepo, type LineRepo, makeFakeVerifier } from "./line-repo.js";

const repos: LineRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
});
const setup = async () => {
  const lr = await createLineRepo({ programs: ["p1", "p2"] });
  repos.push(lr);
  return { lr, checkout: lr.checkout() };
};
const inWt = (path: string, ...args: string[]) => git(nodeGitRunner, args, { cwd: path });
const parents = async (lr: LineRepo, commit: string) =>
  (await git(nodeGitRunner, ["rev-list", "--parents", "-n", "1", commit], { cwd: lr.repo }))
    .trim()
    .split(" ")
    .slice(1);

describe("createLineCheckout", () => {
  it("opens a detached worktree at base and closes it", async () => {
    const { lr, checkout } = await setup();
    const wt = await checkout.open(lr.initial);
    expect(await checkout.head(wt)).toBe(lr.initial);
    expect((await inWt(wt.path, "symbolic-ref", "-q", "HEAD").catch(() => "")).trim()).toBe("");
    await checkout.close(wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(nodeGitRunner, ["worktree", "list"], { cwd: lr.repo })).not.toContain(wt.path);
  });

  it("makes the worktree's root enterable by the engine's group, for the project user to be given it (2026-10-29)", async () => {
    if (process.platform === "win32") return;
    const { lr, checkout } = await setup();
    const wt = await checkout.open(lr.initial);
    const mode = (await stat(dirname(wt.path))).mode;
    // group rwx, and setgid so what the project user makes inside stays the group's
    expect(mode & 0o070).toBe(0o070);
    expect(mode & 0o2000).toBe(0o2000);
    await checkout.close(wt);
  });

  it("merges a non-conflicting commit with a two-parent merge commit", async () => {
    const { lr, checkout } = await setup();
    const a = await lr.commit("line", { "a.txt": "a\n" });
    const b = await lr.commit("p1", { "b.txt": "b\n" });
    const wt = await checkout.open(a);
    const out = await checkout.merge(wt, b, "merge p1");
    expect(out.kind).toBe("merged");
    if (out.kind !== "merged") return;
    expect(out.head).toBe(await checkout.head(wt));
    expect(await parents(lr, out.head)).toEqual([a, b]);
    await checkout.close(wt);
  });

  it("an already-contained commit is merged at the unchanged head", async () => {
    const { lr, checkout } = await setup();
    const a = await lr.commit("line", { "a.txt": "a\n" });
    const wt = await checkout.open(a);
    expect(await checkout.merge(wt, lr.initial, "noop")).toEqual({ kind: "merged", head: a });
    expect(await checkout.merge(wt, a, "noop")).toEqual({ kind: "merged", head: a });
    await checkout.close(wt);
  });

  it("a conflicting merge reports paths and leaves the worktree clean at its head", async () => {
    const { lr, checkout } = await setup();
    const a = await lr.commit("line", { "x.txt": "line\n" });
    const b = await lr.commit("p1", { "x.txt": "program\n" });
    const wt = await checkout.open(a);
    const out = await checkout.merge(wt, b, "merge p1");
    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") expect(out.paths).toEqual(["x.txt"]);
    expect(await checkout.head(wt)).toBe(a);
    expect((await inWt(wt.path, "status", "--porcelain")).trim()).toBe("");
    expect(existsSync(join(wt.path, ".git", "MERGE_HEAD"))).toBe(false);
    await checkout.close(wt);
  });

  it("startMerge leaves conflicts; commitMerge commits agent edits including new and deleted files", async () => {
    const { lr, checkout } = await setup();
    const base = await lr.commit("line", { "x.txt": "line\n", "gone.txt": "bye\n" });
    const b = await lr.commit("p1", { "x.txt": "program\n" });
    const wt = await checkout.open(base);
    const started = await checkout.startMerge(wt, b);
    expect(started).toEqual({ kind: "conflict", paths: ["x.txt"] });
    expect(await readFile(join(wt.path, "x.txt"), "utf8")).toContain("<<<<<<<");

    // Unresolved markers are refused, whether or not the file was staged.
    await expect(checkout.commitMerge(wt, "too early")).rejects.toThrow();

    await writeFile(join(wt.path, "x.txt"), "both\n", "utf8");
    await mkdir(join(wt.path, "sub"), { recursive: true });
    await writeFile(join(wt.path, "sub", "new.txt"), "new\n", "utf8");
    await rm(join(wt.path, "gone.txt"));
    const made = await checkout.commitMerge(wt, "resolve");
    expect(await parents(lr, made)).toEqual([base, b]);
    expect(await lr.readFileAtCommit(made, "x.txt")).toBe("both\n");
    expect(await lr.readFileAtCommit(made, "sub/new.txt")).toBe("new\n");
    expect(await lr.readFileAtCommit(made, "gone.txt")).toBeUndefined();
    expect(await checkout.head(wt)).toBe(made);
    await checkout.close(wt);
  });

  it("startMerge of a clean merge leaves it in progress; commitMerge without one throws", async () => {
    const { lr, checkout } = await setup();
    const a = await lr.commit("line", { "a.txt": "a\n" });
    const b = await lr.commit("p1", { "b.txt": "b\n" });
    const wt = await checkout.open(a);
    await expect(checkout.commitMerge(wt, "nothing")).rejects.toThrow(/no merge/);
    expect(await checkout.startMerge(wt, b)).toEqual({ kind: "clean" });
    expect(await checkout.head(wt)).toBe(a);
    const made = await checkout.commitMerge(wt, "merge");
    expect(await parents(lr, made)).toEqual([a, b]);
    await checkout.close(wt);
  });

  it("commitMerge refuses markers left in a file", async () => {
    const { lr, checkout } = await setup();
    const a = await lr.commit("line", { "x.txt": "line\n" });
    const b = await lr.commit("p1", { "x.txt": "program\n" });
    const wt = await checkout.open(a);
    await checkout.startMerge(wt, b);
    await inWt(wt.path, "add", "x.txt"); // staged with the markers still in it
    await expect(checkout.commitMerge(wt, "bad")).rejects.toThrow(/marker/);
    await checkout.close(wt);
  });

  it("isAncestor and sameTree", async () => {
    const { lr, checkout } = await setup();
    const a = await lr.commit("line", { "a.txt": "a\n" });
    const b = await lr.commit("p1", { "b.txt": "b\n" });
    const same = await lr.commit("p2", { "a.txt": "a\n" });
    expect(await checkout.isAncestor(lr.initial, a)).toBe(true);
    expect(await checkout.isAncestor(a, lr.initial)).toBe(false);
    expect(await checkout.isAncestor(a, b)).toBe(false);
    expect(await checkout.isAncestor(a, a)).toBe(true);
    expect(await checkout.sameTree(a, same)).toBe(true);
    expect(await checkout.sameTree(a, b)).toBe(false);
  });
});

describe("makeFakeVerifier", () => {
  it("decides from the commit's content, with schema-valid results", async () => {
    const { lr, checkout } = await setup();
    const green = await lr.commit("line", { "ok.txt": "yes\n" });
    const red = await lr.commit("p1", { "ok.txt": "no\n" });
    const verifier = makeFakeVerifier(lr, async (_c, read) => (await read("ok.txt")) === "yes\n");
    const wt = await checkout.open(green);
    const pass = await verifier.verify({ worktree: wt, commit: green, base: lr.initial });
    const fail = await verifier.verify({ worktree: wt, commit: red, base: lr.initial });
    expect(pass.verification.outcome).toBe("passed");
    expect(fail.verification.outcome).toBe("failed");
    for (const r of [pass, fail]) {
      expect(LineVerificationSchema.safeParse(r.verification).success).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.logs.length).toBeGreaterThan(0);
    }
    await checkout.close(wt);
  });
});

describe("changedPaths and conflictCandidate", () => {
  it("lists the paths changed from..upTo, and from the merge-base when from is absent", async () => {
    const { lr, checkout } = await setup();
    const a = await lr.commit("p1", { "a.txt": "a\n" });
    const b = await lr.commit("p1", { "dir/b.txt": "b\n", "a.txt": "a2\n" });
    expect(await checkout.changedPaths(a, b)).toEqual(["a.txt", "dir/b.txt"]);
    const line = await lr.commit("line", { "l.txt": "l\n" });
    expect(await checkout.changedPaths(undefined, b, line)).toEqual(["a.txt", "dir/b.txt"]);
  });

  it("commits a conflicting merge with the markers and the non-conflicting changes", async () => {
    const { lr, checkout } = await setup();
    const line = await lr.commit("line", { "s.txt": "line\n" });
    const p1 = await lr.commit("p1", { "s.txt": "p1\n", "new.txt": "n\n" });
    const wt = await checkout.open(line);
    const candidate = await checkout.conflictCandidate(wt, p1, "candidate");
    expect(await checkout.head(wt)).toBe(line);
    expect(await parents(lr, candidate)).toEqual([line, p1]);
    expect(await lr.readFileAtCommit(candidate, "s.txt")).toContain("<<<<<<<");
    expect(await lr.readFileAtCommit(candidate, "new.txt")).toBe("n\n");
    await checkout.close(wt);
  });
});
