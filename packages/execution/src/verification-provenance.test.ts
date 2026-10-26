/** What a verification records of what it ran against: base, gate fingerprint, environment. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSha } from "@nightshift/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintAtCommit, gitBlobReader } from "./gate-fingerprint.js";
import { git, nodeGitRunner, revParse } from "./git/index.js";
import {
  endGatesBaseOf,
  gateFingerprintOf,
  verificationEnvironmentOf,
} from "./verification-provenance.js";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const repoWithTwoCommits = async () => {
  const repo = await mkdtemp(join(tmpdir(), "ns-prov-"));
  made.push(repo);
  const run = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: repo, atMs: AT });
  await run(["init", "-b", "main"]);
  await run(["config", "user.email", "t@example.invalid"]);
  await run(["config", "user.name", "t"]);
  await writeFile(join(repo, "a.txt"), "a");
  await run(["add", "."]);
  await run(["commit", "-m", "one"]);
  const base = (await revParse(nodeGitRunner, repo, "HEAD")) as CommitSha;
  await run(["checkout", "-b", "work"]);
  await writeFile(join(repo, "b.txt"), "b");
  await run(["add", "."]);
  await run(["commit", "-m", "two"]);
  const head = (await revParse(nodeGitRunner, repo, "HEAD")) as CommitSha;
  return { repo, base, head };
};

describe("the environment a verification records", () => {
  it("is the laptop with no site or a laptop site", () => {
    expect(verificationEnvironmentOf(undefined)).toEqual({ where: "laptop" });
    expect(verificationEnvironmentOf({ where: "laptop" })).toEqual({ where: "laptop" });
  });

  it("is the machine's generation and image, the image unknown when the site lacks one", () => {
    const dispatch = { runId: "run_01HZZZZZZZZZZZZZZZZZZZZZZZ", generation: 3 } as never;
    expect(
      verificationEnvironmentOf({ where: "machine", dispatch, imageVersion: "1.2.3" }),
    ).toEqual({ where: "machine", generation: 3, imageVersion: "1.2.3" });
    expect(verificationEnvironmentOf({ where: "machine", dispatch })).toEqual({
      where: "machine",
      generation: 3,
      imageVersion: "unknown",
    });
  });
});

describe("the base the end gates record", () => {
  it("is the merge-base with the base branch", async () => {
    const { repo, base, head } = await repoWithTwoCommits();
    const session = { repoPath: repo, program: { repository: { baseBranch: "main" } } } as never;
    expect(await endGatesBaseOf({ git: nodeGitRunner }, session, head)).toBe(base);
  });

  it("is the head itself when the base branch cannot be resolved", async () => {
    const { repo, head } = await repoWithTwoCommits();
    const session = { repoPath: repo, program: { repository: { baseBranch: "nope" } } } as never;
    expect(await endGatesBaseOf({ git: nodeGitRunner }, session, head)).toBe(head);
  });
});

describe("the gate fingerprint a verification records", () => {
  const gates = { setup: [], verification: [{ id: "test", command: "npm test" }] };

  it("is the one fingerprintAtCommit gives, when a gate-health record exists", async () => {
    const { repo, head } = await repoWithTwoCommits();
    const record = { machinery: ["a.txt"] };
    const environment = { stores: { gateHealth: { get: async () => record } } } as never;
    const session = { repoPath: repo, scope: { projectId: "proj_1" } } as never;
    expect(await gateFingerprintOf(environment, session, head, gates)).toBe(
      await fingerprintAtCommit(gitBlobReader(repo), head, gates, ["a.txt"]),
    );
  });

  it("is absent with no record or no store, without failing", async () => {
    const { repo, head } = await repoWithTwoCommits();
    const session = { repoPath: repo, scope: { projectId: "proj_1" } } as never;
    const none = { stores: { gateHealth: { get: async () => undefined } } } as never;
    expect(await gateFingerprintOf(none, session, head, gates)).toBeUndefined();
    expect(await gateFingerprintOf({ stores: {} } as never, session, head, gates)).toBeUndefined();
  });
});
