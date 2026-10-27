/**
 * The publisher's two line paths over a local git server standing in for
 * GitHub (Pipkin M1b): queueing a published range durably, and moving the line
 * by compare-and-swap.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommitSha,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type Dispatch,
  type OrgId,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  lineQueueOwed,
  makeDispatch,
  makeLineRecord,
  makeLineVerification,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRun,
  nextUserId,
  nowIso,
  recordIntent,
} from "@nightshift/core";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHttpServer, startGitHttpServer } from "../github/git-http-server.js";
import { ZERO_OID } from "../github/smart-http.js";
import {
  type BundleStore,
  type GitRemote,
  publishAll,
  publishLine,
  smartHttpRemote,
} from "./publisher.js";

const NOW = "2026-10-27T12:00:00.000Z";
const LINE = "nightshift/develop";
const PROGRAM_REF = "refs/heads/program/fixture";
const LINE_REF = `refs/heads/${LINE}`;

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
const bare = () => join(root, "line.git");
const refOf = (ref: string): string | undefined => {
  try {
    return git(bare(), "rev-parse", "--verify", "-q", ref);
  } catch {
    return undefined;
  }
};
const setRef = (ref: string, sha: string | undefined) => {
  if (sha === undefined) {
    if (refOf(ref) !== undefined) git(bare(), "update-ref", "-d", ref);
  } else git(work, "push", "-q", "-f", bare(), `${sha}:${ref}`);
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ns-publine-"));
  git(root, "init", "-q", "--bare", "line.git");
  git(bare(), "config", "http.receivepack", "true");
  work = await mkdtemp(join(tmpdir(), "ns-publinework-"));
  git(work, "init", "-q", "-b", "main");
  base = commit(work, "a.txt", "one\n", "first");
  git(work, "push", "-q", bare(), "main:refs/heads/main");
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
  readonly deps: Parameters<typeof publishAll>[0];
  readonly started: { projectId: string; branch: string }[];
  readonly dispatch: () => Promise<Dispatch>;
  readonly intend: (head: string, predecessor: string, pack: Uint8Array) => Promise<void>;
}

const world = async (options: { line?: boolean; remote?: GitRemote } = {}): Promise<World> => {
  setRef(PROGRAM_REF, base);
  setRef(LINE_REF, undefined);
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
    installations: [
      {
        installationId: 166952409,
        account: "wildorder",
        repositories: ["wildorder/fixture"],
        recordedAt: NOW,
      },
    ],
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
      ...(options.line === false ? {} : { line: { branch: LINE } }),
    }),
  );
  await stores.runs.put(makeRun(f, { status: "pending", location: "remote" }));
  await stores.dispatches.put(makeDispatch(f, { status: "running", instanceId: "i-1" }));
  await stores.runs.put(makeRun(f, { status: "running", location: "remote" }));
  const bundles = new Map<string, Uint8Array>();
  const bundleStore: BundleStore = {
    get: async (key) => {
      const found = bundles.get(key);
      if (found === undefined) throw new Error(`no bundle ${key}`);
      return found;
    },
  };
  const started: { projectId: string; branch: string }[] = [];
  const deps: Parameters<typeof publishAll>[0] = {
    stores,
    clock: createFixedClock(Date.parse(NOW)),
    github: { writeToken: async () => ({ token: "ghs_write", expiresAt: NOW }) },
    bundles: bundleStore,
    remote: options.remote ?? smartHttpRemote,
    remoteUrlOf: () => `${server.url}/line.git`,
    startLineMachine: async (target) => {
      started.push(target);
    },
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
  return { stores, f, bundles, deps, started, dispatch, intend };
};

describe("queueing a published range on the line", () => {
  it("queues a published push once, starts one line dispatch, and not twice on a repeat", async () => {
    const w = await world();
    const next = commit(work, "b.txt", "two\n", "second");
    await w.intend(next, base, await packOf(work, next, base));
    expect(await publishAll(w.deps, w.f.scope)).toEqual({ published: 1, nothing_pending: 1 });
    expect(refOf(PROGRAM_REF)).toBe(next);

    const line = await w.stores.lines.get(w.f.scope.projectId, LINE);
    expect(line?.queue.map(({ program, upTo }) => ({ program, upTo }))).toEqual([
      { program: w.f.scope.programId, upTo: next },
    ]);
    expect(line?.repositoryUrl).toBe("https://github.com/wildorder/fixture");
    expect(line?.head).toBeUndefined();
    const after = await w.dispatch();
    expect(after.publication.lineOwed).toBe(true);
    expect(after.publication.lineQueuedUpTo).toBe(next);
    expect(lineQueueOwed(after)).toBe(false);
    expect(w.started).toEqual([{ projectId: w.f.scope.projectId, branch: LINE }]);
    expect((await w.stores.lineDispatches.get(w.f.scope.projectId, LINE))?.status).toBe(
      "requested",
    );

    await publishAll(w.deps, w.f.scope);
    expect((await w.stores.lines.get(w.f.scope.projectId, LINE))?.queue).toHaveLength(1);
    expect(w.started).toHaveLength(1);
  });

  it("reads the line's head from the remote when it creates the record", async () => {
    const w = await world();
    setRef(LINE_REF, base);
    const next = commit(work, "c.txt", "three\n", "third");
    await w.intend(next, base, await packOf(work, next, base));
    await publishAll(w.deps, w.f.scope);
    expect((await w.stores.lines.get(w.f.scope.projectId, LINE))?.head).toBe(base);
  });

  it("queues an already_published push the same way", async () => {
    const w = await world();
    const next = commit(work, "d.txt", "four\n", "fourth");
    setRef(PROGRAM_REF, next);
    await w.intend(next, base, new Uint8Array());
    expect(await publishAll(w.deps, w.f.scope)).toEqual({
      already_published: 1,
      nothing_pending: 1,
    });
    const line = await w.stores.lines.get(w.f.scope.projectId, LINE);
    expect(line?.queue.map((entry) => entry.upTo)).toEqual([next]);
    expect((await w.dispatch()).publication.lineQueuedUpTo).toBe(next);
    expect(w.started).toHaveLength(1);
    await publishAll(w.deps, w.f.scope);
    expect((await w.stores.lines.get(w.f.scope.projectId, LINE))?.queue).toHaveLength(1);
    expect(w.started).toHaveLength(1);
  });

  it("leaves a project without a line untouched", async () => {
    const w = await world({ line: false });
    const next = commit(work, "e.txt", "five\n", "fifth");
    await w.intend(next, base, await packOf(work, next, base));
    expect(await publishAll(w.deps, w.f.scope)).toEqual({ published: 1, nothing_pending: 1 });
    expect(await w.stores.lines.get(w.f.scope.projectId, LINE)).toBeUndefined();
    expect(await w.stores.lineDispatches.get(w.f.scope.projectId, LINE)).toBeUndefined();
    expect((await w.dispatch()).publication.lineOwed).toBeUndefined();
    expect(w.started).toEqual([]);
  });
});

describe("a failure in the line path", () => {
  it("keeps the obligation, and a later publishAll with nothing pending finishes it", async () => {
    const w = await world();
    const next = commit(work, "f.txt", "six\n", "sixth");
    await w.intend(next, base, await packOf(work, next, base));
    const lines = w.stores.lines;
    const realUpdate = lines.update.bind(lines);
    let failing = true;
    lines.update = async (...args) => {
      if (failing) throw new Error("table unavailable");
      return realUpdate(...args);
    };
    const before = await publishAll(w.deps, w.f.scope);
    expect(before).toEqual({ published: 1, nothing_pending: 1 });
    const stuck = await w.dispatch();
    expect(stuck.publication.intents.map((intent) => intent.status)).toEqual(["published"]);
    expect(stuck.publication.blocked).toBeUndefined();
    expect(lineQueueOwed(stuck)).toBe(true);
    expect(w.started).toEqual([]);

    failing = false;
    expect(await publishAll(w.deps, w.f.scope)).toEqual({ nothing_pending: 1 });
    const done = await w.dispatch();
    expect(done.publication.lineQueuedUpTo).toBe(next);
    expect(lineQueueOwed(done)).toBe(false);
    expect((await lines.get(w.f.scope.projectId, LINE))?.queue).toHaveLength(1);
    expect(w.started).toHaveLength(1);
  });

  it("does not change the run's counts, intents or block when starting the machine fails", async () => {
    const w = await world();
    const next = commit(work, "g.txt", "seven\n", "seventh");
    await w.intend(next, base, await packOf(work, next, base));
    const logs: string[] = [];
    const counts = await publishAll(
      {
        ...w.deps,
        log: (line) => logs.push(line),
        startLineMachine: async () => {
          throw new Error("lambda unavailable");
        },
      },
      w.f.scope,
    );
    expect(counts).toEqual({ published: 1, nothing_pending: 1 });
    const after = await w.dispatch();
    expect(after.publication.intents.map((intent) => intent.status)).toEqual(["published"]);
    expect(after.publication.blocked).toBeUndefined();
    expect(after.publication.lineQueuedUpTo).toBe(next);
    expect(logs.some((line) => line.includes("lambda unavailable"))).toBe(true);
  });
});

describe("publishLine", () => {
  const cas = (line: string, parent: string) => ({
    head: line as CommitSha,
    expectedPredecessor: parent as CommitSha,
    bundleKey: `line/${line}.pack`,
    generation: 1,
    status: "pending" as const,
    requestedAt: NOW,
  });
  const arrange = async (w: World, head: string, predecessor: string, pack: Uint8Array) => {
    w.bundles.set(`line/${head}.pack`, pack);
    await w.stores.lines.update(w.f.scope.projectId, LINE, () =>
      makeLineRecord(w.f, {
        repositoryUrl: "https://github.com/wildorder/fixture",
        push: cas(head, predecessor),
        compositions: [
          {
            compositionId: "comp-1",
            commit: head as CommitSha,
            parent: predecessor as CommitSha,
            ranges: [{ program: w.f.scope.programId, upTo: head as CommitSha }],
            verification: makeLineVerification(w.f),
            composedAt: NOW,
          },
        ],
      }),
    );
  };
  const guardDispatch = (w: World) => {
    const writes: string[] = [];
    const put = w.stores.dispatches.put.bind(w.stores.dispatches);
    w.stores.dispatches.put = async (next) => {
      writes.push(next.runId);
      return put(next);
    };
    return writes;
  };
  const projectId = (w: World) => w.f.scope.projectId;

  it("pushes the bundle, moves the remote ref, and marks the composition pushed", async () => {
    const w = await world();
    setRef(LINE_REF, base);
    const head = commit(work, "h.txt", "eight\n", "eighth");
    await arrange(w, head, base, await packOf(work, head, base));
    const writes = guardDispatch(w);
    expect(await publishLine(w.deps, { projectId: projectId(w), branch: LINE })).toBe("published");
    expect(refOf(LINE_REF)).toBe(head);
    const line = await w.stores.lines.get(projectId(w), LINE);
    expect(line?.head).toBe(head);
    expect(line?.push?.status).toBe("published");
    expect(line?.compositions[0]?.pushed).toBeDefined();
    expect(writes).toEqual([]);
    // Nothing pending any more.
    expect(await publishLine(w.deps, { projectId: projectId(w), branch: LINE })).toBe(
      "nothing_pending",
    );
  });

  it("creates a missing line branch from ZERO_OID", async () => {
    const w = await world();
    const head = commit(work, "i.txt", "nine\n", "ninth");
    expect(refOf(LINE_REF)).toBeUndefined();
    await arrange(w, head, ZERO_OID, await packOf(work, head, base));
    expect(await publishLine(w.deps, { projectId: projectId(w), branch: LINE })).toBe("published");
    expect(refOf(LINE_REF)).toBe(head);
    expect((await w.stores.lines.get(projectId(w), LINE))?.head).toBe(head);
  });

  it("creates an absent line from main's head by an absent-ref compare-and-swap", async () => {
    const olds: string[] = [];
    const remote: GitRemote = {
      advertise: smartHttpRemote.advertise,
      push: async (input) => {
        olds.push(input.expectedOld);
        return smartHttpRemote.push(input);
      },
    };
    const w = await world({ remote });
    const head = commit(work, "o.txt", "fifteen\n", "fifteenth");
    expect(refOf(LINE_REF)).toBeUndefined();
    await arrange(w, head, base, await packOf(work, head, base));
    expect(await publishLine(w.deps, { projectId: projectId(w), branch: LINE })).toBe("published");
    expect(olds).toEqual([ZERO_OID]);
    expect(refOf(LINE_REF)).toBe(head);
    const line = await w.stores.lines.get(projectId(w), LINE);
    expect(line?.head).toBe(head);
    expect(line?.push?.status).toBe("published");
  });

  it("treats an absent ref as a conflict when the record has had a head", async () => {
    const pushes: string[] = [];
    const remote: GitRemote = {
      advertise: smartHttpRemote.advertise,
      push: async (input) => {
        pushes.push(input.newOid);
        return smartHttpRemote.push(input);
      },
    };
    const w = await world({ remote });
    const head = commit(work, "p.txt", "sixteen\n", "sixteenth");
    await arrange(w, head, base, await packOf(work, head, base));
    await w.stores.lines.update(projectId(w), LINE, (current) =>
      current === undefined ? undefined : { ...current, head: base as CommitSha },
    );
    expect(await publishLine(w.deps, { projectId: projectId(w), branch: LINE })).toBe("conflict");
    expect(pushes).toEqual([]);
    expect(refOf(LINE_REF)).toBeUndefined();
    expect((await w.stores.lines.get(projectId(w), LINE))?.push?.status).toBe("conflict");
  });

  it("records a conflict when a ref created meanwhile beats the absent-ref swap", async () => {
    const w = await world();
    const theirs = commit(work, "q.txt", "seventeen\n", "seventeenth");
    const ours = commit(work, "r.txt", "eighteen\n", "eighteenth");
    await arrange(w, ours, base, await packOf(work, ours, base));
    const remote: GitRemote = {
      advertise: smartHttpRemote.advertise,
      push: async (input) => {
        setRef(LINE_REF, theirs);
        return smartHttpRemote.push(input);
      },
    };
    expect(
      await publishLine({ ...w.deps, remote }, { projectId: projectId(w), branch: LINE }),
    ).toBe("conflict");
    expect(refOf(LINE_REF)).toBe(theirs);
    expect((await w.stores.lines.get(projectId(w), LINE))?.push?.status).toBe("conflict");
  });

  it("records a conflict with the remote head when the line moved, and pushes nothing", async () => {
    const pushes: string[] = [];
    const remote: GitRemote = {
      advertise: smartHttpRemote.advertise,
      push: async (input) => {
        pushes.push(input.newOid);
        return smartHttpRemote.push(input);
      },
    };
    const w = await world({ remote });
    setRef(LINE_REF, base);
    const theirs = commit(work, "j.txt", "ten\n", "tenth");
    setRef(LINE_REF, theirs);
    const ours = commit(work, "k.txt", "eleven\n", "eleventh");
    await arrange(w, ours, base, await packOf(work, ours, base));
    const writes = guardDispatch(w);
    expect(await publishLine(w.deps, { projectId: projectId(w), branch: LINE })).toBe("conflict");
    expect(pushes).toEqual([]);
    expect(refOf(LINE_REF)).toBe(theirs);
    const line = await w.stores.lines.get(projectId(w), LINE);
    expect(line?.push?.status).toBe("conflict");
    expect(line?.push?.detail).toContain(theirs.slice(0, 12));
    expect(line?.head).toBe(theirs);
    expect(line?.compositions[0]?.pushed).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("records a protection refusal as protected", async () => {
    const protectedRemote: GitRemote = {
      advertise: smartHttpRemote.advertise,
      push: async () => ({ kind: "rejected", reason: "protected branch hook declined" }),
    };
    const w = await world({ remote: protectedRemote });
    setRef(LINE_REF, base);
    const head = commit(work, "l.txt", "twelve\n", "twelfth");
    await arrange(w, head, base, await packOf(work, head, base));
    expect(await publishLine(w.deps, { projectId: projectId(w), branch: LINE })).toBe("protected");
    const line = await w.stores.lines.get(projectId(w), LINE);
    expect(line?.push?.status).toBe("protected");
    expect(line?.push?.detail).toContain("protected");
    expect(line?.head).toBeUndefined();
  });

  it("retries a transient failure, then records an error", async () => {
    const flaky: GitRemote = {
      advertise: smartHttpRemote.advertise,
      push: async () => ({ kind: "error", detail: "unpack failed: short read" }),
    };
    const w = await world({ remote: flaky });
    setRef(LINE_REF, base);
    const head = commit(work, "m.txt", "thirteen\n", "thirteenth");
    await arrange(w, head, base, await packOf(work, head, base));
    const run = () => publishLine(w.deps, { projectId: projectId(w), branch: LINE });
    expect(await run()).toBe("retrying");
    expect((await w.stores.lines.get(projectId(w), LINE))?.push?.status).toBe("pending");
    expect(await run()).toBe("retrying");
    expect(await run()).toBe("error");
    expect((await w.stores.lines.get(projectId(w), LINE))?.push?.status).toBe("error");
  });

  it("treats a line already at the head as published", async () => {
    const w = await world();
    const head = commit(work, "n.txt", "fourteen\n", "fourteenth");
    setRef(LINE_REF, head);
    await arrange(w, head, base, new Uint8Array());
    expect(await publishLine(w.deps, { projectId: projectId(w), branch: LINE })).toBe(
      "already_published",
    );
    const line = await w.stores.lines.get(projectId(w), LINE);
    expect(line?.push?.status).toBe("published");
    expect(line?.head).toBe(head);
  });

  it("does not run twice at once for one line", async () => {
    const w = await world();
    const lock = {
      acquire: async () => false,
      release: async () => undefined,
    };
    expect(await publishLine({ ...w.deps, lock }, { projectId: projectId(w), branch: LINE })).toBe(
      "locked",
    );
  });
});
