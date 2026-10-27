/**
 * The project line, end to end and offline (Pipkin M1b, S-04 J5).
 *
 * Real pieces, all on localhost: the control plane's handler over the memory
 * stores, the publisher (`publishAll` queues a landed range on the line,
 * `publishLine` moves the line) pushing to a real smart-HTTP git server that
 * stands in for GitHub, and the line owner (`runLineOwner`, booted by
 * `runRunner` as a line machine's runner is) over a fake machine. The owner's
 * agents go through `createLineAgents` over a fake harness whose `startLine`
 * scripts the processes.
 *
 * One stand-in is worth naming. The machine's `exec` swaps GitHub's clone URL
 * for the local server's, as the machine would reach GitHub.
 */
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ApiDeps, handleRequest } from "@nightshift/api";
import {
  type GitHttpServer,
  type PublisherDeps,
  publishAll,
  publishLine,
  smartHttpRemote,
  startGitHttpServer,
} from "@nightshift/api/testing";
import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type HeartbeatBody,
  HeartbeatResponseSchema,
  type LineDispatch,
  type LineRecord,
  LineViewSchema,
  NIGHTSHIFT_CONFIG_FILE,
  type OrgId,
  TakeLineBatchResponseSchema,
} from "@nightshift/contracts";
import {
  beginReplacement,
  type Clock,
  createCountingIdGenerator,
  createFixtures,
  type Fixtures,
  type GitHubAppClient,
  leaseLost,
  makeDispatch,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRun,
  nextUserId,
  recordIntent,
  systemClock,
  transitionDispatch,
} from "@nightshift/core";
import { nodeGitRunner } from "@nightshift/execution";
import type { Harness, HarnessExit } from "@nightshift/harness";
import {
  LINE_TAGS,
  type LineRunnerPlane,
  type Machine,
  runLineOwner,
  runRunner,
} from "@nightshift/mcp";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const START = Date.parse("2026-10-27T12:00:00.000Z");
const LINE = "nightshift/develop";
const LINE_REF = `refs/heads/${LINE}`;
const REPOSITORY = "https://github.com/wildorder/fixture";
const GITHUB_TOKEN = "gh-read-token";
const IDLE_SECONDS = 3;
/** How much faster than real time the plane's clock runs. */
const SPEED = 100;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

// --- the git server standing in for GitHub ------------------------------------------------

interface Origin {
  readonly root: string;
  readonly work: string;
  readonly server: GitHttpServer;
  readonly bare: string;
  /** Commits on the work repository: the base, and each program's landings. */
  readonly commits: Record<"base" | "a1" | "b1" | "a2", string>;
  /** The line pushes the git server took. */
  readonly linePushes: string[];
  refOf(ref: string): string | undefined;
  show(ref: string, file: string): string;
  isAncestor(ancestor: string, of: string): boolean;
  packOf(head: string, exclude: string): Uint8Array;
}

const makeOrigin = async (config: object): Promise<Origin> => {
  const root = mkdtempSync(join(tmpdir(), "nightshift-line-e2e-"));
  const bare = join(root, "line.git");
  git(root, "init", "-q", "--bare", "-b", "main", "line.git");
  git(bare, "config", "http.receivepack", "true");
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  const commit = (files: Record<string, string>, message: string): string => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, name)), { recursive: true });
      writeFileSync(join(work, name), text);
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };
  const base = commit(
    { [NIGHTSHIFT_CONFIG_FILE]: JSON.stringify(config), "shared.txt": "base\n" },
    "base",
  );
  git(work, "checkout", "-q", "-b", "program/a");
  const a1 = commit({ "a.txt": "a\n" }, "program a: a.txt");
  git(work, "checkout", "-q", "-b", "program/b", "main");
  const b1 = commit({ "b.txt": "b\n", "shared.txt": "from b\n" }, "program b: b.txt and shared");
  git(work, "checkout", "-q", "program/a");
  const a2 = commit({ "shared.txt": "from a\n" }, "program a: shared");
  for (const ref of ["main", LINE, "program/a", "program/b"]) {
    git(work, "push", "-q", bare, `${base}:refs/heads/${ref}`);
  }
  const linePushes: string[] = [];
  const refOf = (ref: string): string | undefined => {
    try {
      return git(bare, "rev-parse", "--verify", "-q", ref);
    } catch {
      return undefined;
    }
  };
  return {
    root,
    work,
    bare,
    server: await startGitHttpServer(root),
    commits: { base, a1, b1, a2 },
    linePushes,
    refOf,
    show: (ref, file) => git(bare, "show", `${ref}:${file}`),
    isAncestor: (ancestor, of) => {
      try {
        git(bare, "merge-base", "--is-ancestor", ancestor, of);
        return true;
      } catch {
        return false;
      }
    },
    packOf: (head, exclude) =>
      new Uint8Array(
        execFileSync("git", ["pack-objects", "--revs", "--stdout", "--quiet"], {
          cwd: work,
          input: `${head}\n^${exclude}\n`,
          maxBuffer: 64 * 1024 * 1024,
        }),
      ),
  };
};

// --- the control plane --------------------------------------------------------------------

interface Plane {
  readonly stores: InMemoryStores;
  readonly deps: ApiDeps;
  readonly clock: Clock & { at: number };
  readonly orgId: OrgId;
  /** Program fixtures by name; both belong to one project. */
  readonly programs: Record<"a" | "b", Fixtures>;
  readonly publisher: PublisherDeps;
  /** The machines the plane was asked to bring up, by generation. */
  readonly provisioned: number[];
  readonly bundles: Map<string, Uint8Array>;
  readonly projectId: Fixtures["scope"]["projectId"];
  readonly intents: Map<string, number>;
  land(name: "a" | "b", head: string, predecessor: string): Promise<void>;
  lineDispatch(): Promise<LineDispatch>;
  lineRecord(): Promise<LineRecord>;
}

const makePlane = async (origin: Origin): Promise<Plane> => {
  const stores = createInMemoryStores();
  // Plane time is real time run SPEED times faster, from START: every actor
  // reads one clock that moves on its own, so concurrent sleepers never move it
  // for each other and a slow host cannot make time race ahead of the work.
  // Setting `at` jumps it, as a lost machine's lease is waited out.
  const began = Date.now();
  let offset = 0;
  const clock = {
    now: () => START + (Date.now() - began) * SPEED + offset,
    get at(): number {
      return clock.now();
    },
    set at(value: number) {
      offset += value - clock.now();
    },
  };
  const a = createFixtures();
  // The second program is another program of the same project.
  const b: Fixtures = {
    ...a,
    scope: { ...a.scope, programId: a.ids.next("prog"), runId: a.ids.next("run") },
  };
  const programs = { a, b };
  const orgId = a.ids.next("org") as OrgId;
  await stores.memberships.put(makeMembership(nextUserId(a), orgId));
  await stores.projects.put(makeProject(a, { orgId }));
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
        recordedAt: "2026-10-27T11:00:00.000Z",
      },
    ],
    version: 1,
    updatedAt: "2026-10-27T11:00:00.000Z",
  });
  const branches = { a: "program/a", b: "program/b" } as const;
  for (const name of ["a", "b"] as const) {
    const f = programs[name];
    await stores.programContracts.put(
      makeProgramContract(f, {
        repository: { url: REPOSITORY, baseBranch: "main", programBranch: branches[name] },
        line: { branch: LINE },
      }),
    );
    // A dispatch is stored while its run is pending; the run then starts.
    await stores.runs.put(makeRun(f, { status: "pending", location: "remote" }));
    await stores.dispatches.put(makeDispatch(f, { status: "running", instanceId: "i-run" }));
    await stores.runs.put(makeRun(f, { status: "running", location: "remote" }));
  }

  const bundles = new Map<string, Uint8Array>();
  const provisioned: number[] = [];
  const lineKey = { projectId: a.scope.projectId, branch: LINE };
  const at = () => new Date(clock.at).toISOString();

  /** What provisioning does for a requested (or replacement) dispatch: a machine is being made. */
  const provisionLine = async (): Promise<void> => {
    const stored = await stores.lineDispatches.update(
      lineKey.projectId,
      lineKey.branch,
      (current) => {
        const claimed =
          current.status === "requested" ? transitionDispatch(current, "provision", at()) : current;
        return { ...claimed, instanceId: claimed.instanceId ?? `i-line-${current.generation}` };
      },
    );
    provisioned.push(stored?.generation ?? 0);
  };

  const counting = {
    advertise: smartHttpRemote.advertise,
    push: async (input: Parameters<typeof smartHttpRemote.push>[0]) => {
      if (input.ref === LINE_REF) origin.linePushes.push(input.newOid);
      return smartHttpRemote.push(input);
    },
  };
  const publisher: PublisherDeps = {
    stores,
    clock,
    github: { writeToken: async () => ({ token: "ghs_write", expiresAt: at() }) },
    bundles: {
      get: async (key) => {
        const found = bundles.get(key);
        if (found === undefined) throw new Error(`no bundle ${key}`);
        return found;
      },
    },
    remote: counting,
    remoteUrlOf: () => `${origin.server.url}/line.git`,
    startLineMachine: provisionLine,
  };

  const deps: ApiDeps = {
    stores,
    clock,
    github: {
      readToken: async () => ({ token: GITHUB_TOKEN, expiresAt: at() }),
    } as unknown as GitHubAppClient,
    dispatcher: {
      provision: async () => undefined,
      provisionLine,
      publishLine: async (target) => {
        await publishLine(publisher, target);
      },
    },
    uploads: {
      sign: async () => {
        throw new Error("not used");
      },
      signKey: async (key, contentType) => ({
        uri: `s3://bucket/${key}`,
        uploadUrl: `https://bucket.invalid/${key}?sig=1`,
        key,
        contentType,
        expiresAt: at(),
      }),
    },
  };

  const intents = new Map<string, number>();
  const land: Plane["land"] = async (name, head, predecessor) => {
    const f = programs[name];
    const key = `${f.scope.runId}/${head}.pack`;
    bundles.set(key, origin.packOf(head, predecessor));
    const dispatch = await stores.dispatches.get(f.scope);
    if (dispatch === undefined) throw new Error("no run dispatch");
    const { dispatch: next } = recordIntent(
      dispatch,
      { head: head as never, expectedPredecessor: predecessor as never, bundleKey: key },
      at(),
    );
    await stores.dispatches.put(next);
    const counts = await publishAll(publisher, f.scope);
    intents.set(head, counts.published ?? 0);
  };

  return {
    stores,
    deps,
    clock,
    orgId,
    programs,
    publisher,
    provisioned,
    bundles,
    projectId: a.scope.projectId,
    intents,
    land,
    lineDispatch: async () => {
      const found = await stores.lineDispatches.get(lineKey.projectId, lineKey.branch);
      if (found === undefined) throw new Error("no line dispatch");
      return found;
    },
    lineRecord: async () => {
      const found = await stores.lines.get(lineKey.projectId, lineKey.branch);
      if (found === undefined) throw new Error("no line record");
      return found;
    },
  };
};

/**
 * The owner's view of the plane (`LineRunnerPlane`), through the real handler as
 * the machine's HTTP adapter reaches it, bound to the dispatch's generation.
 */
const planeFor = (
  plane: Plane,
  dispatch: LineDispatch,
  hooks: {
    readonly bundleUploadUrl?: () => void;
    readonly afterSettle?: (settled: { batchId: string; pushed: boolean }) => Promise<void>;
  } = {},
): LineRunnerPlane & { readonly settles: { batchId: string; generation: number }[] } => {
  const { generation } = dispatch;
  const base = `/projects/${plane.projectId}/line/${encodeURIComponent(LINE)}`;
  const principal = {
    kind: "line",
    projectId: plane.projectId,
    branch: LINE,
    agentId: dispatch.engineAgentId,
    generation,
  } as never;
  const call = async (method: string, tail: string, body?: unknown): Promise<unknown> => {
    const response = await handleRequest(plane.deps, {
      method,
      path: `${base}${tail}`,
      query: {},
      body,
      principal,
    });
    if (response.status >= 400) {
      throw new Error(`${method} ${tail}: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body;
  };
  const settles: { batchId: string; generation: number }[] = [];
  return {
    settles,
    line: async () => LineViewSchema.parse(await call("GET", "")),
    takeBatch: async () =>
      TakeLineBatchResponseSchema.parse(await call("POST", "/batch", { generation })).batch,
    settle: async (body) => {
      await call("POST", "/settle", body);
      settles.push({ batchId: body.batchId, generation });
      await hooks.afterSettle?.({ batchId: body.batchId, pushed: body.push !== undefined });
    },
    heartbeat: async (body: HeartbeatBody) =>
      HeartbeatResponseSchema.parse(await call("POST", "/heartbeat", body)),
    bundleUploadUrl: async (id) => {
      hooks.bundleUploadUrl?.();
      const signed = (await call("POST", "/bundle-upload-url", { generation, id })) as {
        uploadUrl: string;
        key: string;
        contentType: string;
      };
      return { uploadUrl: signed.uploadUrl, key: signed.key, contentType: signed.contentType };
    },
    decide: async (decision) => {
      await call("POST", "/decisions", { ...decision, generation });
    },
    announce: async (agent) => {
      await call("POST", "/agents", { generation, agent });
    },
  };
};

// --- the machine --------------------------------------------------------------------------

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr = "no") => ({ exitCode: 1, stdout: "", stderr });

/** Runs the commands that touch the real checkout; answers the rest (mounts, SSM, the sampler). */
const REAL = new Set(["git", "env", "mkdir"]);

const lineMachine = (
  plane: Plane,
  origin: Origin,
  dispatch: LineDispatch,
): Machine & { readonly commands: string[] } => {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const tags: Record<string, string> = {
    [LINE_TAGS.kind]: "line",
    [LINE_TAGS.project]: plane.projectId,
    [LINE_TAGS.line]: LINE,
    [LINE_TAGS.agent]: dispatch.engineAgentId,
    [LINE_TAGS.generation]: String(dispatch.generation),
    [LINE_TAGS.stage]: "dev",
    [LINE_TAGS.api]: "https://api.dev.nightshift.invalid",
  };
  const github = `${REPOSITORY}.git`;
  const local = `${origin.server.url}/line.git`;
  const IMDS = "http://169.254.169.254";
  let parameterPresent = true;
  return {
    commands,
    exec: async (file, args) => {
      commands.push([file, ...args].join(" "));
      if (REAL.has(file)) {
        // The machine reaches GitHub; here that is the local server.
        const routed = args.map((arg) => (arg === github ? local : arg));
        return new Promise((resolve) => {
          execFile(file, routed, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = (error as { code?: unknown } | null)?.code;
            resolve({
              exitCode: error === null ? 0 : typeof code === "number" ? code : 1,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          });
        });
      }
      if (file === "mv" && args[0] === "-f") {
        const value = files.get(args[1] ?? "");
        if (value === undefined) return fail("missing source");
        files.set(args[2] ?? "", value);
        files.delete(args[1] ?? "");
        return ok();
      }
      if (file === "aws" && args[1] === "get-parameter") {
        return parameterPresent ? ok("eyJ.first.token\n") : fail("ParameterNotFound");
      }
      if (file === "aws" && args[1] === "delete-parameter") {
        parameterPresent = false;
        return ok();
      }
      if (file === "findmnt") return fail();
      if (file === "df") return ok("Use%\n 12%\n");
      return ok();
    },
    readFile: async (path) => files.get(path),
    writeFile: async (path, text) => {
      files.set(path, text);
    },
    http: async (method, url, headers) => {
      if (method === "PUT" && url === `${IMDS}/latest/api/token`) {
        return { status: 200, text: "imds-token" };
      }
      if (headers["X-aws-ec2-metadata-token"] !== "imds-token") return { status: 401, text: "" };
      const path = url.slice(`${IMDS}/latest/meta-data/`.length);
      if (path === "instance-id") return { status: 200, text: `i-line-${dispatch.generation}` };
      const tag = tags[path.replace("tags/instance/", "")];
      return tag === undefined ? { status: 404, text: "" } : { status: 200, text: tag };
    },
    // One clock for the machine and the plane: a sleep waits its plane time.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / SPEED)),
    now: () => plane.clock.at,
  };
};

// --- the agents ---------------------------------------------------------------------------

interface Launch {
  readonly role: string;
  readonly model: string;
}

/** A harness whose resolver merges the conflicted file and whose examiner approves. */
const scriptedHarnesses = (launches: Launch[]): { get(harness: string): Harness | undefined } => {
  const harness = (id: string): Harness => ({
    id,
    capabilities: { usage: true },
    start: async () => {
      throw new Error("the run path is not used by the line");
    },
    startLine: async (input) => {
      launches.push({ role: input.role, model: input.model.model });
      let exit: HarnessExit = { kind: "completed", result: "done" };
      if (input.role === "line_resolver") {
        writeFileSync(join(input.worktree, "shared.txt"), "from a and b\n");
      } else if (input.role === "line_examiner") {
        exit = { kind: "completed", result: '{"verdict":"approved","findings":[]}' };
      }
      return { agentId: input.agentId, exit: Promise.resolve(exit) };
    },
    cancel: async () => undefined,
    status: async () => "started",
  });
  const held = new Map([
    ["claude", harness("claude")],
    ["codex", harness("codex")],
  ]);
  return { get: (name) => held.get(name) };
};

// --- running an owner ---------------------------------------------------------------------

const CONFIG = (projectId: string) => ({
  schemaVersion: 1,
  projectId,
  contextDocs: [],
  verification: [{ id: "ok", command: 'node -e "process.exit(0)"' }],
  modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
  delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
  costPolicy: {},
});

let origin: Origin;
let plane: Plane;
let workspace: string;
beforeEach(async () => {
  const probe = createFixtures();
  origin = await makeOrigin(CONFIG(probe.scope.projectId));
  plane = await makePlane(origin);
  workspace = join(origin.root, "workspace");
  mkdirSync(workspace);
});
afterEach(async () => {
  await origin.server.close();
  rmSync(origin.root, { recursive: true, force: true });
});

/** Runs one owner generation as its machine's runner does, until the runner exits. */
const ownerFor = async (
  dispatch: LineDispatch,
  hooks: Parameters<typeof planeFor>[2] = {},
  launches: Launch[] = [],
) => {
  const linePlane = planeFor(plane, dispatch, hooks);
  const machine = lineMachine(plane, origin, dispatch);
  const uploads = join(origin.root, "uploads");
  mkdirSync(uploads, { recursive: true });
  const code = await runRunner({
    machine,
    log: () => undefined,
    workspace,
    device: "/dev/xvdf",
    engineUser: "engine",
    // The machine's PATH, as the runner binary passes it: steps find the toolchain where it is installed.
    ...(process.env.PATH === undefined ? {} : { inheritedPath: process.env.PATH }),
    plane: () => {
      throw new Error("this is a line machine: the run plane is not used");
    },
    linePlane: () => linePlane,
    lineWork: (context) =>
      runLineOwner(context, {
        git: nodeGitRunner,
        ids: createCountingIdGenerator(5_000 + dispatch.generation * 1_000),
        clock: systemClock,
        paths: { scratch: (checkout) => join(dirname(checkout), "scratch") },
        upload: async ({ url, file }) => {
          const key = new URL(url).pathname.slice(1);
          const stored = join(uploads, `${plane.bundles.size}-${dispatch.generation}.pack`);
          copyFileSync(file, stored);
          plane.bundles.set(key, new Uint8Array(readFileSync(stored)));
        },
        createHarnesses: () => scriptedHarnesses(launches),
        idleSeconds: IDLE_SECONDS,
        pollMs: 500,
      }),
  });
  return { code, linePlane, machine, launches };
};

describe("the project line, end to end", () => {
  it("composes two programs onto the line, repairs a later conflict, publishes it and idles out", async () => {
    const { commits } = origin;
    // Both programs land and publish their program branch: each range is queued
    // and one line dispatch is requested.
    await plane.land("a", commits.a1, commits.base);
    await plane.land("b", commits.b1, commits.base);
    expect(origin.refOf("refs/heads/program/a")).toBe(commits.a1);
    expect(origin.refOf("refs/heads/program/b")).toBe(commits.b1);
    const queued = await plane.lineRecord();
    expect(queued.queue.map((entry) => entry.upTo).sort()).toEqual([commits.a1, commits.b1].sort());
    const requested = await plane.lineDispatch();
    expect(requested.status).toBe("provisioning");
    expect(plane.provisioned).toEqual([1]);
    expect(origin.refOf(LINE_REF)).toBe(commits.base);

    // The owner boots for that dispatch. When its first push is published, a
    // later landing of program a arrives: it conflicts with program b's work.
    let later: Promise<void> | undefined;
    const launches: Launch[] = [];
    const { code, linePlane } = await ownerFor(
      requested,
      {
        afterSettle: async ({ pushed }) => {
          if (pushed && later === undefined) {
            expect(origin.refOf(LINE_REF)).not.toBe(commits.base);
            later = plane.land("a", commits.a2, commits.a1);
            await later;
          }
        },
      },
      launches,
    );
    expect(code).toBe(0);
    expect(later).toBeDefined();

    // The line on the git server holds both programs and main, repaired.
    const head = origin.refOf(LINE_REF);
    expect(head).toBeDefined();
    if (head === undefined) return;
    expect(origin.show(head, "a.txt")).toBe("a");
    expect(origin.show(head, "b.txt")).toBe("b");
    expect(origin.show(head, "shared.txt")).toBe("from a and b");
    for (const included of [commits.base, commits.a1, commits.b1, commits.a2]) {
      expect(origin.isAncestor(included, head)).toBe(true);
    }
    expect(origin.refOf("refs/heads/main")).toBe(commits.base);
    // The line moved by two pushes: the first composition and the repaired one.
    expect(origin.linePushes).toHaveLength(2);
    expect(origin.linePushes.at(-1)).toBe(head);

    // The line record: compositions pushed, a resolver's decision, nothing left.
    const record = await plane.lineRecord();
    expect(record.queue).toEqual([]);
    expect(record.batch).toBeUndefined();
    expect(record.parked).toEqual([]);
    expect(record.head).toBe(head);
    expect(record.push).toMatchObject({ head, status: "published" });
    expect(record.compositions).toHaveLength(2);
    expect(record.compositions.every((composition) => composition.pushed !== undefined)).toBe(true);
    const repaired = record.compositions.at(-1);
    expect(repaired?.commit).toBe(head);
    expect(repaired?.resolver).toBeDefined();
    expect(record.compositions[0]?.resolver).toBeUndefined();
    expect(record.decisions).toHaveLength(1);
    expect(record.decisions?.[0]).toMatchObject({ authority: "line", generation: 1 });

    // The agents were announced on the line dispatch, the examiner on another model.
    const dispatch = await plane.lineDispatch();
    const roles = (dispatch.agents ?? []).map((agent) => agent.role);
    expect(roles).toEqual(expect.arrayContaining(["line_resolver", "line_examiner"]));
    expect(dispatch.agents).toHaveLength(launches.length);
    const resolver = launches.find((launch) => launch.role === "line_resolver");
    const examiner = launches.find((launch) => launch.role === "line_examiner");
    expect(resolver).toBeDefined();
    expect(examiner).toBeDefined();
    expect(examiner?.model).not.toBe(resolver?.model);

    // The owner idled out, and the dispatch ended stopped, with no failure.
    expect(dispatch.status).toBe("stopped");
    expect(dispatch.failure).toBeUndefined();
    expect(dispatch.generation).toBe(1);
    expect(plane.provisioned).toEqual([1]);
    expect(linePlane.settles.length).toBeGreaterThanOrEqual(2);
  });

  it("creates the line branch on the git server when the first composition finds it absent", async () => {
    const { commits } = origin;
    // The configured line branch was never pushed.
    git(origin.bare, "update-ref", "-d", LINE_REF);
    expect(origin.refOf(LINE_REF)).toBeUndefined();
    await plane.land("a", commits.a1, commits.base);
    const record0 = await plane.lineRecord();
    expect(record0.head).toBeUndefined();
    const requested = await plane.lineDispatch();

    const { code } = await ownerFor(requested, {});
    expect(code).toBe(0);

    const head = origin.refOf(LINE_REF);
    expect(head).toBeDefined();
    if (head === undefined) return;
    expect(origin.show(head, "a.txt")).toBe("a");
    expect(origin.isAncestor(commits.base, head)).toBe(true);
    expect(origin.linePushes).toEqual([head]);
    const record = await plane.lineRecord();
    expect(record.head).toBe(head);
    expect(record.push).toMatchObject({
      head,
      expectedPredecessor: commits.base,
      status: "published",
    });
    expect(record.compositions[0]?.parent).toBe(commits.base);
    expect(origin.refOf("refs/heads/main")).toBe(commits.base);
  });

  it("resumes a held batch under a replacement generation and publishes it once", async () => {
    const { commits } = origin;
    await plane.land("a", commits.a1, commits.base);
    await plane.land("b", commits.b1, commits.base);
    const first = await plane.lineDispatch();

    // Generation 1 takes the batch and its machine is lost before it settles.
    let lost = false;
    const gen1 = await ownerFor(first, {
      bundleUploadUrl: () => {
        lost = true;
        throw new Error("the machine was lost");
      },
    });
    expect(lost).toBe(true);
    expect(gen1.code).not.toBe(0);
    expect(gen1.linePlane.settles).toEqual([]);
    const held = (await plane.lineRecord()).batch;
    expect(held).toMatchObject({ generation: 1 });
    expect((await plane.lineRecord()).queue).toEqual([]);
    expect(origin.linePushes).toEqual([]);
    expect((await plane.lineDispatch()).status).toBe("running");

    // Its lease lapses; a replacement generation is admitted.
    const stale = await plane.lineDispatch();
    plane.clock.at += 20 * 60_000;
    expect(leaseLost(stale, plane.clock.now())).toBe(true);
    await plane.stores.lineDispatches.update(plane.projectId, LINE, (current) =>
      beginReplacement(current, "lease_lost", new Date(plane.clock.now()).toISOString()),
    );
    await plane.deps.dispatcher?.provisionLine?.({ projectId: plane.projectId, branch: LINE });
    const replacement = await plane.lineDispatch();
    expect(replacement.generation).toBe(2);
    expect(plane.provisioned).toEqual([1, 2]);

    const gen2 = await ownerFor(replacement);
    expect(gen2.code).toBe(0);

    // The new generation composed the held batch, and the line moved once.
    expect(gen2.linePlane.settles).toEqual([{ batchId: held?.batchId, generation: 2 }]);
    const record = await plane.lineRecord();
    expect(record.batch).toBeUndefined();
    expect(record.queue).toEqual([]);
    expect(record.compositions).toHaveLength(1);
    const composition = record.compositions[0];
    expect(composition?.ranges.map((range) => range.upTo).sort()).toEqual(
      [commits.a1, commits.b1].sort(),
    );
    expect(composition?.pushed).toBeDefined();
    expect(origin.linePushes).toEqual([composition?.commit]);
    const head = origin.refOf(LINE_REF);
    expect(head).toBe(composition?.commit);
    if (head === undefined) return;
    expect(origin.show(head, "a.txt")).toBe("a");
    expect(origin.show(head, "b.txt")).toBe("b");
    expect(origin.show(head, "shared.txt")).toBe("from b");
    expect(origin.isAncestor(commits.base, head)).toBe(true);
    expect(record.push).toMatchObject({ head, status: "published", generation: 2 });
    expect((await plane.lineDispatch()).status).toBe("stopped");
  });
});
