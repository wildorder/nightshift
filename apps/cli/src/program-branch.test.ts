/**
 * The program branch, made the same at GitHub as here (2026-10-13), against
 * real git: a working clone and a bare `origin`, and for the other-machine
 * cases a second clone.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, nodeGitRunner } from "@nightshift/execution";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "./failures.js";
import { publishProgramBranch } from "./program-branch.js";

const BRANCH = "program/rooms";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) => git(nodeGitRunner, args, { cwd });
const headOf = async (cwd: string, ref: string) => (await run(cwd, "rev-parse", ref)).trim();

const commit = async (cwd: string, file: string): Promise<string> => {
  await writeFile(join(cwd, file), `${file}\n`, "utf8");
  await run(cwd, "add", file);
  await run(cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", file);
  return headOf(cwd, "HEAD");
};

/** A bare origin, and a clone of it with `main` and the program branch made locally. */
const world = async () => {
  const root = await mkdtemp(join(tmpdir(), "ns-branch-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const here = join(root, "here");
  await git(nodeGitRunner, ["init", "-q", "--bare", origin], { cwd: root });
  await git(nodeGitRunner, ["clone", "-q", origin, here], { cwd: root });
  await run(here, "checkout", "-q", "-b", "main");
  await commit(here, "base");
  await run(here, "push", "-q", "origin", "main");
  await run(here, "checkout", "-q", "-b", BRANCH);
  await commit(here, "plan");
  const clone = async (name: string) => {
    const there = join(root, name);
    await git(nodeGitRunner, ["clone", "-q", origin, there], { cwd: root });
    return there;
  };
  return { origin, here, clone };
};

const publish = (repo: string, push = true) => {
  const lines: string[] = [];
  return {
    lines,
    result: publishProgramBranch(nodeGitRunner, repo, BRANCH, {
      push,
      out: (line) => lines.push(line),
    }),
  };
};

describe("publishProgramBranch", () => {
  it("pushes a branch origin has never had, and says so", async () => {
    const { origin, here } = await world();
    const head = await headOf(here, BRANCH);
    const { lines, result } = publish(here);
    expect(await result).toEqual({ kind: "pushed", head });
    expect(await headOf(origin, BRANCH)).toBe(head);
    expect(lines.join("\n")).toMatch(
      /pushed program\/rooms to origin at [0-9a-f]{12} \(it was not there\)/,
    );
  });

  it("pushes a branch origin is behind on, fast-forward", async () => {
    const { origin, here } = await world();
    await run(here, "push", "-q", "origin", BRANCH);
    const before = await headOf(here, BRANCH);
    const head = await commit(here, "plan-revised");
    expect(await publish(here).result).toEqual({ kind: "pushed", head, from: before });
    expect(await headOf(origin, BRANCH)).toBe(head);
  });

  it("does nothing when origin already has it, and sees a push from another machine it had not fetched", async () => {
    const { here, clone } = await world();
    await run(here, "push", "-q", "origin", BRANCH);
    // The other machine: a clone made before the branch existed, so its copy
    // of origin knows nothing of it until it fetches.
    const there = await clone("there");
    await run(there, "fetch", "-q", "origin", `${BRANCH}:${BRANCH}`);
    await run(there, "update-ref", "-d", `refs/remotes/origin/${BRANCH}`);
    const head = await headOf(here, BRANCH);
    expect(await publish(there).result).toEqual({ kind: "in-step", head });
  });

  it("refuses when origin is ahead, saying to pull, and pushes nothing", async () => {
    const { origin, here, clone } = await world();
    await run(here, "push", "-q", "origin", BRANCH);
    const there = await clone("there");
    await run(there, "checkout", "-q", BRANCH);
    const ahead = await commit(there, "elsewhere");
    await run(there, "push", "-q", "origin", BRANCH);
    const error = await publish(here).result.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toMatch(/which is ahead/);
    expect((error as UsageError).usage).toMatch(/git pull --ff-only/);
    expect(await headOf(origin, BRANCH)).toBe(ahead);
  });

  it("refuses diverged history and never forces", async () => {
    const { origin, here, clone } = await world();
    await run(here, "push", "-q", "origin", BRANCH);
    const there = await clone("there");
    await run(there, "checkout", "-q", BRANCH);
    const theirs = await commit(there, "theirs");
    await run(there, "push", "-q", "origin", BRANCH);
    await commit(here, "ours");
    await expect(publish(here).result).rejects.toThrow(/diverged/);
    expect(await headOf(origin, BRANCH)).toBe(theirs);
  });

  it("with --no-push, refuses an unpushed branch as before and pushes nothing", async () => {
    const { origin, here } = await world();
    await expect(publish(here, false).result).rejects.toThrow(/has not been pushed/);
    await expect(headOf(origin, BRANCH)).rejects.toThrow();
  });

  it("names origin's copy when the branch is missing here", async () => {
    const { here, clone } = await world();
    await run(here, "push", "-q", "origin", BRANCH);
    const there = await clone("there");
    const error = await publish(there).result.catch((cause: unknown) => cause);
    expect(String(error)).toMatch(/does not exist/);
    expect((error as UsageError).usage).toMatch(/git switch program\/rooms/);
  });
});
