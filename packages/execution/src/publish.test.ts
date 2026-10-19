/**
 * A strand's branch, published as it moves (A-60): one branch at a time, the
 * newest head winning over any that waited behind a push, each pack whole
 * from the base, and a failure only logged, for the next move to carry.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitSha, StrandPublicationBody } from "@nightshift/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { git, nodeGitRunner, revParse } from "./git/index.js";
import { createStrandPublication } from "./publish.js";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const repository = async () => {
  const repo = await mkdtemp(join(tmpdir(), "nightshift-publish-"));
  made.push(repo);
  const run = (args: readonly string[]) => git(nodeGitRunner, args, { cwd: repo, atMs: AT });
  await run(["init", "-q", "--initial-branch", "main"]);
  let n = 0;
  const commit = async (): Promise<CommitSha> => {
    n += 1;
    await writeFile(join(repo, `f${n}.txt`), `${n}\n`);
    await run(["add", "-A"]);
    await run(["commit", "-qm", `c${n}`]);
    return revParse(nodeGitRunner, repo, "HEAD");
  };
  return { repo, commit };
};

describe("a strand's branch, published as it moves (A-60)", () => {
  it("sends the newest head of a branch once the push before it is done, and none in between", async () => {
    const { repo, commit } = await repository();
    const base = await commit();
    const heads = [await commit(), await commit(), await commit()];
    const requests: StrandPublicationBody[] = [];
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = createStrandPublication({
      baseSha: base,
      packDir: join(repo, ".git", "packs"),
      upload: async (pack, head) => {
        expect(pack.length).toBeGreaterThan(0);
        // The first push is slow; the strand moves twice meanwhile.
        if (head === heads[0]) await first;
        return { key: `k-${head}` };
      },
      request: async (body) => {
        requests.push(body);
      },
      log: () => undefined,
    });
    const branch = "nightshift/run_1/node_s01";
    const sent = [publish({ branch, head: heads[0] as CommitSha, repoPath: repo })];
    await new Promise((resolve) => setTimeout(resolve, 20));
    sent.push(publish({ branch, head: heads[1] as CommitSha, repoPath: repo }));
    sent.push(publish({ branch, head: heads[2] as CommitSha, repoPath: repo }));
    release();
    await Promise.all(sent);
    expect(requests.map((request) => request.head)).toEqual([heads[0], heads[2]]);
    expect(requests[1]).toEqual({ branch, head: heads[2], bundleKey: `k-${heads[2]}` });

    // Afterwards, a new move starts afresh.
    const later = await commit();
    await publish({ branch, head: later, repoPath: repo });
    expect(requests.at(-1)?.head).toBe(later);
  });

  it("never throws: a request that fails is logged, and the next move carries the work", async () => {
    const { repo, commit } = await repository();
    const base = await commit();
    const lines: string[] = [];
    let failing = true;
    const requests: string[] = [];
    const publish = createStrandPublication({
      baseSha: base,
      packDir: join(repo, ".git", "packs"),
      upload: async (_pack, head) => ({ key: head }),
      request: async (body) => {
        if (failing) throw new Error("the plane is away");
        requests.push(body.head);
      },
      log: (line) => lines.push(line),
    });
    const branch = "nightshift/run_1/node_s01";
    const one = await commit();
    await expect(publish({ branch, head: one, repoPath: repo })).resolves.toBeUndefined();
    expect(lines.at(-1)).toContain("could not be published: the plane is away");
    failing = false;
    const two = await commit();
    await publish({ branch, head: two, repoPath: repo });
    expect(requests).toEqual([two]);
  });
});
