/**
 * The CLI's fingerprint at a commit (P15, D-P15-02): git's bytes, not the
 * working tree's and not decoded text, and the lockfile list `core` counts held
 * to the one `@nightshift/verification` installs by.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintAtCommit, gitBlobReader } from "@nightshift/cli";
import { GATE_LOCKFILES } from "@nightshift/core";
import { LOCKFILES } from "@nightshift/verification";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let repo: string;

const git = (...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "core.autocrlf=false", ...args],
    { cwd: repo, encoding: "utf8" },
  ).trim();

const commitAll = (message: string): string => {
  git("add", "-A");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "nightshift-fingerprint-"));
  git("init", "-q", "--initial-branch=main");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const steps = { verification: [{ id: "test", command: "node --test" }] };

describe("the gate fingerprint at a commit", () => {
  it("counts the lockfiles verification installs by, no more and no fewer", () => {
    expect([...GATE_LOCKFILES]).toEqual([...LOCKFILES]);
  });

  it("reads the committed bytes exactly, absent as absent, and a directory as no file", async () => {
    const bytes = Buffer.from([0x66, 0x0d, 0x0a, 0xff, 0x00, 0x0a]);
    await writeFile(join(repo, "gate.bin"), bytes);
    await mkdir(join(repo, "scripts"));
    await writeFile(join(repo, "scripts", "a.mjs"), "x\n");
    const first = commitAll("first");
    const read = gitBlobReader(repo);
    expect(Buffer.from((await read(first, "gate.bin")) ?? [])).toEqual(bytes);
    expect(await read(first, "missing.txt")).toBeUndefined();
    expect(await read(first, "scripts")).toBeUndefined();

    // The working tree does not count; the commit does.
    await writeFile(join(repo, "gate.bin"), "changed");
    expect(Buffer.from((await read(first, "gate.bin")) ?? [])).toEqual(bytes);
  });

  it("changes with a named file or a lockfile, and not with anything else", async () => {
    await writeFile(join(repo, "package.json"), "{}\n");
    await writeFile(join(repo, "README.md"), "one\n");
    const first = commitAll("first");
    const read = gitBlobReader(repo);
    const at = (commit: string) => fingerprintAtCommit(read, commit, steps, ["package.json"]);
    const base = await at(first);
    expect(base).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(repo, "README.md"), "two\n");
    expect(await at(commitAll("readme"))).toBe(base);

    await writeFile(join(repo, "package-lock.json"), "{}\n");
    const locked = await at(commitAll("a lockfile"));
    expect(locked).not.toBe(base);

    await writeFile(join(repo, "package.json"), '{"scripts":{}}\n');
    expect(await at(commitAll("machinery"))).not.toBe(locked);
  });
});
