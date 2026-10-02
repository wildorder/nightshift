/**
 * The publisher over a local git server standing in for GitHub (P10, T4,
 * D-P10-22): the lease holds, the lease is stale, the reply was lost, the
 * branch is protected, the pack is wrong.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type Dispatch,
  type OrgId,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  makeDispatch,
  makeMembership,
  makeProgramContract,
  makeProject,
  nextUserId,
  nowIso,
  recordIntent,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHttpServer, startGitHttpServer } from "../github/git-http-server.js";
import {
  type BundleStore,
  type GitRemote,
  publishAll,
  publishNext,
  smartHttpRemote,
} from "./publisher.js";

const NOW = "2026-10-02T12:00:00.000Z";
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (work: string, file: string, text: string, message: string): string => {
  execFileSync(
    "node",
    ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2])", file, text],
    { cwd: work },
  );
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
};
const packOf = async (work: string, head: string, exclude: string): Promise<Uint8Array> => {
  const prefix = join(work, ".git", `pack-${head.slice(0, 8)}`);
  const hash = execFileSync("git", ["pack-objects", "--revs", prefix], {
    cwd: work,
    input: `${head}\n^${exclude}\n`,
    encoding: "utf8",
  }).trim();
  return new Uint8Array(await readFile(`${prefix}-${hash}.pack`));
};

let root: string;
let work: string;
let server: GitHttpServer;
let base: string;
const bare = () => join(root, "fixture.git");
const branchHead = () => git(bare(), "rev-parse", "refs/heads/program/fixture");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ns-pub-"));
  git(root, "init", "-q", "--bare", "fixture.git");
  git(bare(), "config", "http.receivepack", "true");
  work = await mkdtemp(join(tmpdir(), "ns-pubwork-"));
  git(work, "init", "-q", "-b", "main");
  base = commit(work, "a.txt", "one\n", "first");
  git(work, "push", "-q", bare(), "main:refs/heads/program/fixture");
  server = await startGitHttpServer(root);
});
afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

interface World {
  readonly stores: InMemoryStores;
  readonly f: ReturnType<typeof createFixtures>;
  readonly bundles: Map<string, Uint8Array>;
  readonly deps: Parameters<typeof publishNext>[0];
  readonly dispatch: () => Promise<Dispatch>;
  readonly intend: (head: string, predecessor: string, pack: Uint8Array) => Promise<void>;
}

const world = async (remote: GitRemote = smartHttpRemote): Promise<World> => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const orgId = f.ids.next("org") as OrgId;
  await stores.memberships.put(makeMembership(nextUserId(f), orgId));
  await stores.projects.put(makeProject(f, { orgId }));
  await stores.orgConfigs.put({
    schemaVersion: 1,
    orgId,
    routingPolicy: DEFAULT_ROUTING_POLICY,
    examinationPolicy: DEFAULT_EXAMINATION_POLICY,
    github: {
      installationId: 166952409,
      account: "wildorder",
      repositories: ["wildorder/fixture"],
      recordedAt: NOW,
    },
    version: 1,
    updatedAt: NOW,
  });
  await stores.programContracts.put(
    makeProgramContract(f, {
      repository: {
        url: "https://github.com/wildorder/fixture",
        baseBranch: "main",
        programBranch: "program/fixture",
      },
    }),
  );
  await stores.dispatches.put(makeDispatch(f, { status: "running", instanceId: "i-1" }));
  const bundles = new Map<string, Uint8Array>();
  const bundleStore: BundleStore = {
    get: async (key) => {
      const found = bundles.get(key);
      if (found === undefined) throw new Error(`no bundle ${key}`);
      return found;
    },
  };
  const deps: Parameters<typeof publishNext>[0] = {
    stores,
    clock: createFixedClock(Date.parse(NOW)),
    github: { writeToken: async () => ({ token: "ghs_write", expiresAt: NOW }) },
    bundles: bundleStore,
    remote,
    remoteUrlOf: () => `${server.url}/fixture.git`,
  };
  const dispatch = async () => {
    const found = await stores.dispatches.get(f.scope);
    if (found === undefined) throw new Error("no dispatch");
    return found;
  };
  const intend = async (head: string, predecessor: string, pack: Uint8Array) => {
    const key = `proj/${f.scope.runId}/${head}.pack`;
    bundles.set(key, pack);
    const { dispatch: next } = recordIntent(
      await dispatch(),
      { head: head as never, expectedPredecessor: predecessor as never, bundleKey: key },
      nowIso(deps.clock),
    );
    await stores.dispatches.put(next);
  };
  return { stores, f, bundles, deps, dispatch, intend };
};

describe("the publisher (D-P10-22)", () => {
  it("pushes each pending intent in order with the lease, and records the branch head", async () => {
    const w = await world();
    const second = commit(work, "b.txt", "two\n", "second");
    const third = commit(work, "c.txt", "three\n", "third");
    await w.intend(second, base, await packOf(work, second, base));
    await w.intend(third, second, await packOf(work, third, second));
    expect(await publishAll(w.deps, w.f.scope)).toEqual({ published: 2, nothing_pending: 1 });
    expect(branchHead()).toBe(third);
    const after = await w.dispatch();
    expect(after.publication.head).toBe(third);
    expect(after.publication.blocked).toBeUndefined();
    expect(after.publication.intents.map((intent) => intent.status)).toEqual([
      "published",
      "published",
    ]);
  });

  it("records a conflict, never forces, and marks every later intent as superseded", async () => {
    const w = await world();
    const head = branchHead();
    // Someone else moves the branch directly.
    const elsewhere = await mkdtemp(join(tmpdir(), "ns-else-"));
    git(elsewhere, "clone", "-q", "-b", "program/fixture", bare(), ".");
    const theirs = commit(elsewhere, "z.txt", "theirs\n", "theirs");
    git(elsewhere, "push", "-q", "origin", "HEAD:refs/heads/program/fixture");
    await rm(elsewhere, { recursive: true, force: true });

    const ours = commit(work, "d.txt", "four\n", "fourth");
    const later = commit(work, "e.txt", "five\n", "fifth");
    await w.intend(ours, head, await packOf(work, ours, head));
    await w.intend(later, ours, await packOf(work, later, ours));
    expect(await publishNext(w.deps, w.f.scope)).toBe("conflict");
    expect(branchHead()).toBe(theirs);
    const after = await w.dispatch();
    expect(after.publication.blocked).toContain("someone else moved");
    expect(after.publication.intents.map((intent) => intent.status)).toEqual([
      "conflict",
      "conflict",
    ]);
    expect(after.publication.intents[1]?.detail).toContain("superseded");
    expect(await publishNext(w.deps, w.f.scope)).toBe("nothing_pending");
    // Reset the fixture branch for the tests that follow.
    git(work, "push", "-q", "-f", bare(), `${later}:refs/heads/program/fixture`);
  });

  it("treats a branch already at the head as published: the reply was lost", async () => {
    const w = await world();
    const head = branchHead();
    await w.intend(head, base, new Uint8Array());
    expect(await publishNext(w.deps, w.f.scope)).toBe("already_published");
    expect((await w.dispatch()).publication.head).toBe(head);
  });

  it("records a protected branch as protected, and a transient failure as retrying then error", async () => {
    const head = branchHead();
    const next = commit(work, "f.txt", "six\n", "sixth");
    const pack = await packOf(work, next, head);

    const protectedRemote: GitRemote = {
      advertise: async () => new Map([["refs/heads/program/fixture", head]]),
      push: async () => ({ kind: "rejected", reason: "protected branch hook declined" }),
    };
    const p = await world(protectedRemote);
    await p.intend(next, head, pack);
    expect(await publishNext(p.deps, p.f.scope)).toBe("protected");
    expect((await p.dispatch()).publication.blocked).toContain("protected");

    const flaky: GitRemote = {
      advertise: async () => new Map([["refs/heads/program/fixture", head]]),
      push: async () => ({ kind: "error", detail: "unpack failed: short read" }),
    };
    const e = await world(flaky);
    await e.intend(next, head, pack);
    expect(await publishNext(e.deps, e.f.scope)).toBe("retrying");
    expect(await publishNext(e.deps, e.f.scope)).toBe("retrying");
    expect(await publishNext(e.deps, e.f.scope)).toBe("error");
    const after = await e.dispatch();
    expect(after.publication.intents[0]?.status).toBe("error");
    expect(after.publication.blocked).toContain("giving up");
  });

  it("refuses a pack whose objects do not add up to the head", async () => {
    const w = await world();
    const head = branchHead();
    const next = commit(work, "g.txt", "seven\n", "seventh");
    // A pack of nothing: the remote cannot complete the ref and says so.
    await w.intend(next, head, new Uint8Array());
    const step = await publishNext(w.deps, w.f.scope);
    expect(["retrying", "error", "conflict"]).toContain(step);
    expect(branchHead()).toBe(head);
  });
});
