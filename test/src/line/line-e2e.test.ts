/**
 * The project line, end to end and offline (Pipkin M1b, S-04; S-02).
 *
 * Real pieces, all on localhost: the control plane's handler over the memory
 * stores, the publisher (`publishAll` queues a landed range on the line and
 * starts a run of the line program; `publishLine` moves the line) pushing to a
 * real smart-HTTP git server that stands in for GitHub, and the line owner
 * (`runLineOwner`, booted by `runRunner` as a line run's machine is) over a fake
 * machine. The owner is the engine of its run: it reaches the line routes with
 * the run's engine token, heartbeats the run's dispatch, and sits in the run's
 * root seat as the composer's orchestrator Agent. A range that conflicts is an
 * ordinary engine repair job on the line's run, worked by a fake harness (the
 * one thing that is not real): the engine examines it, integrates it, and the
 * composer composes and pushes it, while the line goes on composing other
 * ranges and holds only the ones that touch the repair's paths.
 *
 * One stand-in is worth naming. The machine's `exec` swaps GitHub's clone URL
 * for the local server's, as the machine would reach GitHub.
 */
import { execFile, execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ApiDeps, handleRequest } from "@nightshift/api";
import {
  encodeTestPrincipal,
  type GitHttpServer,
  type LocalControlPlane,
  type PublisherDeps,
  publishAll,
  publishLine,
  smartHttpRemote,
  startGitHttpServer,
  startLocalControlPlane,
} from "@nightshift/api/testing";
import {
  DEFAULT_COMPUTE_CEILINGS,
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type Dispatch,
  ExaminationSchema,
  type HeartbeatBody,
  HeartbeatResponseSchema,
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
  createUlidIdGenerator,
  type Fixtures,
  type GitHubAppClient,
  leaseLost,
  lineProgramId,
  makeDispatch,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRun,
  nextUserId,
  nowIso,
  recordIntent,
  systemClock,
  transitionDispatch,
} from "@nightshift/core";
import {
  completeJob,
  createEventOutbox,
  EXAMINATION_CONTEXT_ENV,
  type ExaminationContext,
  failJob,
  nodeGitRunner,
} from "@nightshift/execution";
import type { HarnessExit, HarnessStartInput } from "@nightshift/harness";
import {
  createRunnerLog,
  LINE_TAG,
  type LineRunnerPlane,
  type Machine,
  type Runtime,
  runLineOwner,
  runRunner,
} from "@nightshift/mcp";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpExecutionTokenMinter,
  createHttpStores,
  routes,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeHarness, type ScriptContext } from "../execution/fake-harness.js";
import { localPathsIn } from "../execution/world.js";

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
  readonly commits: Record<"base" | "a1" | "b1" | "a2" | "b2" | "b3", string>;
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
  // shared.txt is long enough that edits at its two ends never conflict with each other.
  const shared = (first: string, last: string): string =>
    [first, "l2", "l3", "l4", "l5", "l6", "l7", "l8", last].join("\n").concat("\n");
  const base = commit(
    {
      [NIGHTSHIFT_CONFIG_FILE]: JSON.stringify(config),
      "shared.txt": shared("l1", "l9"),
    },
    "base",
  );
  git(work, "checkout", "-q", "-b", "program/a");
  const a1 = commit({ "a.txt": "a\n" }, "program a: a.txt");
  git(work, "checkout", "-q", "-b", "program/b", "main");
  const b1 = commit(
    { "b.txt": "b\n", "shared.txt": shared("from b", "l9") },
    "program b: b.txt and the top of shared",
  );
  const b2 = commit({ "c.txt": "c\n" }, "program b: c.txt");
  const b3 = commit({ "shared.txt": shared("from b", "b3 line") }, "program b: the end of shared");
  git(work, "checkout", "-q", "program/a");
  const a2 = commit(
    { "shared.txt": shared("from a", "l9"), "a2.txt": "a2\n" },
    "program a: the top of shared and a2.txt",
  );
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
    commits: { base, a1, b1, a2, b2, b3 },
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
  /** The runs the plane was asked to bring a machine up for, by run id and generation. */
  readonly provisioned: { runId: string; generation: number }[];
  readonly bundles: Map<string, Uint8Array>;
  readonly projectId: Fixtures["scope"]["projectId"];
  readonly intents: Map<string, number>;
  land(name: "a" | "b", head: string, predecessor: string): Promise<void>;
  /** The line program's one run, and its dispatch. */
  lineRun(): Promise<{ readonly runId: string; readonly dispatch: Dispatch }>;
  /** The line program's runs. */
  lineRuns(): Promise<readonly { readonly runId: string; readonly status: string }[]>;
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
    // The two program runs are live beside the line's: room for a third.
    compute: { ...DEFAULT_COMPUTE_CEILINGS, maxConcurrentRuns: 3 },
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
        // The line program inherits these: a repair runs the gate below and is examined.
        scope: { includes: ["**"], excludes: [], forbiddenActions: [] },
        verification: [{ id: "ok", command: 'node -e "process.exit(0)"' }],
        modelPolicy: {
          allowedProviders: ["anthropic", "openai"],
          allowedModels: [],
          forbiddenModels: [],
        },
      }),
    );
    // A dispatch is stored while its run is pending; the run then starts.
    await stores.runs.put(makeRun(f, { status: "pending", location: "remote" }));
    await stores.dispatches.put(makeDispatch(f, { status: "running", instanceId: "i-run" }));
    await stores.runs.put(makeRun(f, { status: "running", location: "remote" }));
  }

  const bundles = new Map<string, Uint8Array>();
  const provisioned: { runId: string; generation: number }[] = [];
  const lineKey = { projectId: a.scope.projectId, branch: LINE };
  const lineProgram = lineProgramId(a.scope.projectId, LINE);
  const at = () => new Date(clock.at).toISOString();

  /** What provisioning does for a requested (or replacement) dispatch: a machine is being made. */
  const provisionRun = async (scope: {
    projectId: typeof lineKey.projectId;
    programId: string;
    runId: string;
  }): Promise<void> => {
    const current = await stores.dispatches.get(scope as never);
    if (current === undefined) throw new Error("no dispatch to provision");
    const claimed =
      current.status === "requested" ? transitionDispatch(current, "provision", at()) : current;
    await stores.dispatches.put({
      ...claimed,
      instanceId: `i-line-${current.generation}`,
      updatedAt: at(),
    });
    provisioned.push({ runId: scope.runId, generation: current.generation });
  };

  const counting = {
    advertise: smartHttpRemote.advertise,
    push: async (input: Parameters<typeof smartHttpRemote.push>[0]) => {
      if (input.ref === LINE_REF) origin.linePushes.push(input.newOid);
      return smartHttpRemote.push(input);
    },
  };

  const deps: ApiDeps = {
    stores,
    clock,
    github: {
      readToken: async () => ({ token: GITHUB_TOKEN, expiresAt: at() }),
      // The refs of the git server standing in for GitHub.
      branchHead: async (_installationId: number, _repository: string, branch: string) =>
        origin.refOf(`refs/heads/${branch}`),
    } as unknown as GitHubAppClient,
    dispatcher: {
      provision: provisionRun,
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
    // Landing a range starts a run of the line program, through the same admission as any dispatch.
    plane: deps,
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
    lineRuns: async () =>
      (
        await stores.runs.listByProgram({ projectId: lineKey.projectId, programId: lineProgram })
      ).items.map((run) => ({ runId: run.runId, status: run.status })),
    lineRun: async () => {
      const runs = (
        await stores.runs.listByProgram({ projectId: lineKey.projectId, programId: lineProgram })
      ).items;
      const run = runs.at(-1);
      if (run === undefined || runs.length !== 1) {
        throw new Error(`the line program has ${runs.length} runs, not one`);
      }
      const dispatch = await stores.dispatches.get({
        projectId: lineKey.projectId,
        programId: lineProgram,
        runId: run.runId,
      });
      if (dispatch === undefined) throw new Error("no line dispatch");
      return { runId: run.runId, dispatch };
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
 * the machine's HTTP adapter reaches it: the line routes and the run's dispatch
 * heartbeat, under the run's engine token, bound to the dispatch's generation.
 */
const planeFor = (
  plane: Plane,
  run: { readonly runId: string; readonly dispatch: Dispatch },
  generation: number,
  hooks: {
    readonly bundleUploadUrl?: () => void;
    readonly afterSettle?: (settled: { batchId: string; pushed: boolean }) => Promise<void>;
  } = {},
): LineRunnerPlane & { readonly settles: { batchId: string; generation: number }[] } => {
  const programId = lineProgramId(plane.projectId, LINE);
  const scope = { projectId: plane.projectId, programId, runId: run.runId as never };
  const base = `/projects/${plane.projectId}/line`;
  const call = async (
    method: string,
    path: string,
    query: Record<string, string>,
    body?: unknown,
  ) => {
    const stored = await plane.stores.runs.get(scope, scope.runId);
    const response = await handleRequest(plane.deps, {
      method,
      path,
      query,
      body,
      principal: {
        kind: "execution",
        ...scope,
        nodeId: stored?.rootNodeId,
        agentId: run.dispatch.engineAgentId,
        role: "engine",
        generation,
      } as never,
    });
    if (response.status >= 400) {
      throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body;
  };
  const line = (method: string, tail: string, body?: unknown) =>
    call(method, `${base}${tail}`, { branch: LINE }, body);
  const settles: { batchId: string; generation: number }[] = [];
  return {
    settles,
    line: async () => LineViewSchema.parse(await line("GET", "")),
    dispatch: () => plane.stores.dispatches.get(scope),
    takeBatch: async (release) =>
      TakeLineBatchResponseSchema.parse(
        await line("POST", "/batch", { generation, ...(release === undefined ? {} : { release }) }),
      ).batch,
    settle: async (body) => {
      await line("POST", "/settle", body);
      settles.push({ batchId: body.batchId, generation });
      await hooks.afterSettle?.({ batchId: body.batchId, pushed: body.push !== undefined });
    },
    heartbeat: async (body: HeartbeatBody) =>
      HeartbeatResponseSchema.parse(await call("POST", routes.dispatchHeartbeat(scope), {}, body)),
    bundleUploadUrl: async (id) => {
      hooks.bundleUploadUrl?.();
      const signed = (await line("POST", "/bundle-upload-url", { generation, id })) as {
        uploadUrl: string;
        key: string;
        contentType: string;
      };
      return { uploadUrl: signed.uploadUrl, key: signed.key, contentType: signed.contentType };
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
  runId: string,
  generation: number,
): Machine & { readonly commands: string[] } => {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const tags: Record<string, string> = {
    [LINE_TAG]: LINE,
    "nightshift-project": plane.projectId,
    "nightshift-program": lineProgramId(plane.projectId, LINE),
    "nightshift-run": runId,
    "nightshift-generation": String(generation),
    "nightshift-stage": "dev",
    "nightshift-api": "https://api.dev.nightshift.invalid",
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
      if (path === "instance-id") return { status: 200, text: `i-line-${generation}` };
      const tag = tags[path.replace("tags/instance/", "")];
      return tag === undefined ? { status: 404, text: "" } : { status: 200, text: tag };
    },
    // One clock for the machine and the plane: a sleep waits its plane time.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / SPEED)),
    now: () => plane.clock.at,
  };
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

// --- the fake repair worker ---------------------------------------------------------------

/** What the fake harness's worker does for a repair: it is told the objective, and answers `done` or its own words. */
type RepairWorker = (context: {
  readonly worktree: string;
  readonly objective: string;
}) => Promise<"done" | string>;

const MARKERS = /^(<<<<<<<|=======|>>>>>>>)/m;

/** Writes the whole of shared.txt, resolving the conflict at its top. */
const resolveShared = (worktree: string): void => {
  const file = join(worktree, "shared.txt");
  const text = readFileSync(file, "utf8");
  if (!MARKERS.test(text)) throw new Error("shared.txt carries no conflict markers");
  writeFileSync(
    file,
    ["from a and b", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n").concat("\n"),
  );
};

const mcpLaunch = (identity: {
  readonly role: string;
  readonly executionToken: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}) => ({
  name: "nightshift",
  command: process.execPath,
  args: ["--version"],
  env: {
    ...identity.extraEnv,
    NIGHTSHIFT_ROLE: identity.role,
    NIGHTSHIFT_EXECUTION_TOKEN: identity.executionToken,
  },
});

/** The examiner finds nothing, recording its examination under its own token. */
const examine = async (cp: LocalControlPlane, input: HarnessStartInput): Promise<HarnessExit> => {
  const context = JSON.parse(input.mcp?.env[EXAMINATION_CONTEXT_ENV] ?? "{}") as ExaminationContext;
  const stores = createHttpStores({
    transport: createFetchTransport({
      endpoint: cp.url,
      tokens: staticTokenProvider(input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
    }),
  });
  await stores.examinations.put(
    ExaminationSchema.parse({
      schemaVersion: 1,
      projectId: input.node.projectId,
      programId: input.node.programId,
      runId: input.node.runId,
      examinationId: context.examinationId,
      executionNodeId: input.node.executionNodeId,
      verificationId: context.verificationId,
      commitSha: context.commitSha,
      patchId: context.patchId,
      implementerAgentId: context.implementerAgentId,
      examinerAgentId: input.agent.agentId,
      examinerRoute: context.examinerRoute,
      requiredByRisk: context.requiredByRisk,
      blocking: context.blocking,
      fixAttempt: context.fixAttempt,
      questions: context.questions,
      outcome: "passed",
      findings: [],
      createdAt: nowIso(systemClock),
    }),
  );
  return { kind: "completed" };
};

/**
 * The line run's runtime, as `createRuntime` makes one for a machine's engine but
 * over the loopback plane on the memory stores, with the fake harness for the
 * one thing that is not real: a worker's model.
 */
const engineRuntime = (
  cp: LocalControlPlane,
  token: string,
  stateDir: string,
  worker: RepairWorker,
  seen: { readonly objectives: string[] },
): Runtime => {
  const transport = createFetchTransport({ endpoint: cp.url, tokens: staticTokenProvider(token) });
  const ids = createUlidIdGenerator();
  const harness = createFakeHarness({
    script: async (context: ScriptContext) => {
      if (context.input.agent.role === "examiner") return examine(cp, context.input);
      seen.objectives.push(context.input.job.objective);
      const stores = createHttpStores({
        transport: createFetchTransport({
          endpoint: cp.url,
          tokens: staticTokenProvider(context.input.mcp?.env.NIGHTSHIFT_EXECUTION_TOKEN ?? ""),
        }),
      });
      const outbox = createEventOutbox({
        events: stores.events,
        scope: context.identity.scope,
        clock: systemClock,
        ids,
        writerId: context.identity.agentId,
        initialDelayMs: 1,
      });
      const environment = { stores, clock: systemClock, git: nodeGitRunner, outbox };
      const said = await worker({
        worktree: context.worktree,
        objective: context.input.job.objective,
      });
      if (said === "done") await completeJob(environment, context.identity, "resolved it");
      else await failJob(environment, context.identity, said);
      await outbox.flush();
      return said === "done" ? { kind: "completed" } : { kind: "failed", exitCode: 1 };
    },
  });
  return {
    stores: createHttpStores({ transport }),
    bodies: createHttpArtifactBodyStore({
      transport,
      read: async (scope, artifactId) =>
        cp.bodies.get(`${scope.projectId}/${scope.programId}/${scope.runId}/${artifactId}`)?.body,
    }),
    tokens: createHttpExecutionTokenMinter({ transport }),
    harness,
    paths: localPathsIn(stateDir),
    git: nodeGitRunner,
    transport,
    ids,
    clock: systemClock,
    endpoint: cp.url,
    workerLaunch: mcpLaunch,
    workerEnvironment: (launch) => {
      const stores = createHttpStores({
        transport: createFetchTransport({
          endpoint: cp.url,
          tokens: staticTokenProvider(launch.executionToken),
        }),
      });
      return {
        stores,
        clock: systemClock,
        git: nodeGitRunner,
        outbox: createEventOutbox({
          events: stores.events,
          scope: {
            projectId: launch.projectId,
            programId: launch.programId,
            runId: launch.runId,
          } as never,
          clock: systemClock,
          ids,
          writerId: launch.agentId,
          initialDelayMs: 1,
          maxDelayMs: 4,
        }),
      };
    },
  } as Runtime;
};

// --- running an owner ---------------------------------------------------------------------

interface OwnerOptions {
  readonly hooks?: Parameters<typeof planeFor>[3];
  /** What the repair worker does; by default it resolves the conflict in shared.txt. */
  readonly worker?: RepairWorker;
  /** The empty-queue time after which the owner ends, in plane seconds. */
  readonly idleSeconds?: number;
}

/** Runs one owner generation as its machine's runner does, until the runner exits. */
const ownerFor = async (
  run: { readonly runId: string; readonly dispatch: Dispatch },
  options: OwnerOptions = {},
) => {
  const { generation } = run.dispatch;
  const linePlane = planeFor(plane, run, generation, options.hooks);
  const machine = lineMachine(plane, origin, run.runId, generation);
  const uploads = join(origin.root, "uploads");
  mkdirSync(uploads, { recursive: true });

  const programId = lineProgramId(plane.projectId, LINE);
  const scope = { projectId: plane.projectId, programId, runId: run.runId as never };
  const stored = await plane.stores.runs.get(scope, scope.runId);
  const cp = await startLocalControlPlane({
    stores: plane.stores,
    principal: { kind: "user", userId: nextUserId(plane.programs.a), activeOrg: plane.orgId },
    clock: plane.clock,
  });
  const token = encodeTestPrincipal({
    kind: "execution",
    ...scope,
    nodeId: stored?.rootNodeId,
    agentId: run.dispatch.engineAgentId,
    role: "engine",
    generation,
  } as never);
  const repairs = { objectives: [] as string[] };
  const runtime = engineRuntime(
    cp,
    token,
    join(origin.root, `state-${generation}`),
    options.worker ?? (async ({ worktree }) => (resolveShared(worktree), "done")),
    repairs,
  );

  // The runner's own log, as the runner binary keeps it: every said line is appended to a file.
  const logFile = join(origin.root, `runner-${generation}.log`);
  const runnerLog = createRunnerLog({ file: logFile, log: () => undefined });
  const code = await runRunner({
    machine,
    log: (line) => appendFileSync(logFile, `${line}\n`),
    workspace,
    device: "/dev/xvdf",
    engineUser: "engine",
    // The machine's PATH, as the runner binary passes it: steps find the toolchain where it is installed.
    ...(process.env.PATH === undefined ? {} : { inheritedPath: process.env.PATH }),
    // A line is a run: its dispatch, program and heartbeat come over the run plane.
    plane: () => ({
      dispatch: async () => linePlane.dispatch(),
      program: (scope) => plane.stores.programContracts.get(scope.projectId, scope.programId),
      planDocument: async () => {
        throw new Error("a line program has no plan document");
      },
      heartbeat: async (_scope, body) => linePlane.heartbeat(body),
      nodes: async () => [],
      jobs: async () => [],
    }),
    linePlane: () => linePlane,
    lineWork: (context) =>
      runLineOwner(context, {
        git: nodeGitRunner,
        ids: createCountingIdGenerator(5_000 + generation * 1_000),
        clock: systemClock,
        paths: { scratch: (checkout) => join(dirname(checkout), "scratch") },
        upload: async ({ url, file }) => {
          const key = new URL(url).pathname.slice(1);
          const stored = join(uploads, `${plane.bundles.size}-${generation}.pack`);
          copyFileSync(file, stored);
          plane.bundles.set(key, new Uint8Array(readFileSync(stored)));
        },
        idleSeconds: options.idleSeconds ?? IDLE_SECONDS,
        pollMs: 500,
        repairPollMs: 10,
        makeRuntime: async () => runtime,
        runnerLog,
      }),
  }).finally(async () => {
    await runnerLog.finish();
  });
  await cp.close();
  return { code, linePlane, machine, repairs };
};

/** Polls, in real time, until `check` holds. */
const until = async (what: string, check: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A promise and the means to settle it, for a worker the test holds back. */
const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

/** The Agent record of the line run's orchestrator seat: the composer. */
const composerOf = async (runId: string) => {
  const scope = {
    projectId: plane.projectId,
    programId: lineProgramId(plane.projectId, LINE),
    runId: runId as never,
  };
  const run = await plane.stores.runs.get(scope, scope.runId);
  const agents = (await plane.stores.agents.listByNode(scope, run?.rootNodeId as never)).filter(
    (agent) => agent.role === "orchestrator",
  );
  return { scope, agents };
};

describe("the project line, end to end", () => {
  it("repairs a conflict as an engine job while the line goes on, holds only the reserved paths, and pushes the repaired range", async () => {
    const { commits } = origin;
    await plane.land("a", commits.a1, commits.base);
    await plane.land("b", commits.b1, commits.base);
    const started = await plane.lineRun();
    expect(started.dispatch.status).toBe("provisioning");
    expect(plane.provisioned).toEqual([{ runId: started.runId, generation: 1 }]);

    // The repair worker is held back until the line has gone on without it.
    const reached = gate();
    const release = gate();
    const owner = ownerFor(started, {
      idleSeconds: 150,
      worker: async ({ worktree }) => {
        reached.open();
        await release.opened;
        resolveShared(worktree);
        return "done";
      },
    });

    // a1 and b1 are composed and pushed.
    await until(
      "the first push",
      async () => (await plane.lineRecord()).push?.status === "published",
    );
    const firstHead = origin.refOf(LINE_REF) as string;
    expect(origin.show(firstHead, "a.txt")).toBe("a");
    expect(origin.show(firstHead, "b.txt")).toBe("b");

    // a2 conflicts with b1 in shared.txt: a repair job starts, and its worker waits.
    await plane.land("a", commits.a2, commits.a1);
    await reached.opened;

    // While it runs, a range touching other files is composed and pushed ...
    await plane.land("b", commits.b2, commits.b1);
    await until("b2 to be pushed", async () => {
      const head = origin.refOf(LINE_REF);
      return head !== undefined && origin.isAncestor(commits.b2, head);
    });
    const midHead = origin.refOf(LINE_REF) as string;
    expect(origin.show(midHead, "c.txt")).toBe("c");
    expect(origin.isAncestor(commits.a2, midHead)).toBe(false);

    // ... and one touching the reserved path is held, not composed and not parked.
    await plane.land("b", commits.b3, commits.b2);
    await until("b3 to be held", async () => {
      const record = await plane.lineRecord();
      return record.held.some((entry) => entry.upTo === commits.b3);
    });
    expect((await plane.lineRecord()).parked).toEqual([]);
    expect(origin.refOf(LINE_REF)).toBe(midHead);

    release.open();
    const { code, repairs } = await owner;
    expect(code).toBe(0);

    // The pushed head holds the repaired range's whole content and the resolution ...
    const head = origin.refOf(LINE_REF) as string;
    expect(origin.show(head, "shared.txt")).toBe(
      ["from a and b", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "b3 line"].join("\n"),
    );
    expect(origin.show(head, "a2.txt")).toBe("a2");
    expect(origin.isAncestor(commits.a2, head)).toBe(true);
    // ... the earlier-landed content is still on the line after the repair's push ...
    for (const kept of [commits.base, commits.a1, commits.b1, commits.b2, commits.b3]) {
      expect(origin.isAncestor(kept, head)).toBe(true);
    }
    expect(origin.show(head, "a.txt")).toBe("a");
    expect(origin.show(head, "b.txt")).toBe("b");
    expect(origin.show(head, "c.txt")).toBe("c");
    expect(origin.isAncestor(midHead, head)).toBe(true);
    expect(origin.refOf("refs/heads/main")).toBe(commits.base);

    // ... and the held range was composed after the repaired one.
    const record = await plane.lineRecord();
    expect(record.queue).toEqual([]);
    expect(record.held).toEqual([]);
    expect(record.parked).toEqual([]);
    expect(record.batch).toBeUndefined();
    expect(record.push).toMatchObject({ head, status: "published" });
    const order = (upTo: string) =>
      record.compositions.findIndex((composition) =>
        composition.ranges.some((range) => range.upTo === upTo),
      );
    expect(order(commits.b2)).toBeGreaterThanOrEqual(0);
    expect(order(commits.a2)).toBeGreaterThan(order(commits.b2));
    // The held range is released with the repaired one and merged after it.
    expect(order(commits.b3)).toBeGreaterThanOrEqual(order(commits.a2));
    const final = record.compositions[order(commits.b3)];
    const upTos = final?.ranges.map((range) => range.upTo) ?? [];
    expect(upTos.indexOf(commits.b3)).toBeGreaterThan(upTos.indexOf(commits.a2));
    const repaired = record.compositions[order(commits.a2)];
    expect(repaired?.repair).toBeDefined();
    expect(origin.linePushes.at(-1)).toBe(head);
    expect(origin.linePushes).toHaveLength(record.compositions.length);

    // The repair was an ordinary job of the line's run, with a recorded decision.
    const { dispatch, runId } = await plane.lineRun();
    const { scope, agents } = await composerOf(runId);
    const jobs = (await plane.stores.jobContracts.listByRun(scope)).items;
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job?.repair).toMatchObject({ cause: "line_conflict", gates: ["shared.txt"] });
    expect(job?.risk).toBe("high");
    expect(repaired?.repair?.jobContractId).toBe(job?.jobContractId);
    expect(repairs.objectives).toHaveLength(1);
    expect(repairs.objectives[0]).toContain("conflict markers");
    expect(repairs.objectives[0]).toContain("shared.txt");
    const nodes = (await plane.stores.executionNodes.listByRun(scope)).items;
    const repairNode = nodes.find((node) => node.jobContractId === job?.jobContractId);
    expect(repairNode?.status).toBe("integrated");
    const examinations = await plane.stores.examinations.listByNode(
      scope,
      repairNode?.executionNodeId as never,
    );
    expect(examinations.length).toBeGreaterThan(0);

    // (d) The run's events and its decision are the composer's: one orchestrator Agent record.
    expect(agents).toHaveLength(1);
    const composer = agents[0];
    expect(composer).toMatchObject({ provider: "nightshift", model: "line-composer" });
    const decisions = (await plane.stores.decisions.listByRun(scope)).items;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.agentId).toBe(composer?.agentId);
    expect(decisions[0]?.decisionId).toBe(job?.repair?.decisionId);
    plane.stores.materializeSequences?.();
    const events = (await plane.stores.events.listByRun(scope, {})).items;
    for (const type of ["run.started", "decision.recorded"]) {
      const authored = events.filter((event) => event.type === type);
      expect(authored.length).toBeGreaterThan(0);
      expect(authored.every((event) => event.agentId === composer?.agentId)).toBe(true);
    }
    expect(events.some((event) => event.type === "run.completed")).toBe(true);
    // ... and its runner log is an artifact of the run.
    const artifacts = (await plane.stores.artifacts.listByRun(scope)).items;
    const logs = artifacts.filter((artifact) => artifact.kind === "runner-log");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.executionNodeId).toBe(
      (await plane.stores.runs.get(scope, runId as never))?.rootNodeId,
    );

    // The owner idled out: the dispatch ended stopped with no failure, and its run with it.
    expect(dispatch.status).toBe("stopped");
    expect(dispatch.failure).toBeUndefined();
    expect(await plane.lineRuns()).toEqual([{ runId, status: "succeeded" }]);
  });

  it("parks a range whose repair worker fails three times, with the cause and the agent's own words", async () => {
    const { commits } = origin;
    await plane.land("a", commits.a1, commits.base);
    await plane.land("b", commits.b1, commits.base);
    const started = await plane.lineRun();
    let landed = false;
    const WORDS = "I could not reconcile the two versions of shared.txt";

    const { code, repairs } = await ownerFor(started, {
      worker: async () => WORDS,
      hooks: {
        afterSettle: async ({ pushed }) => {
          if (pushed && !landed) {
            landed = true;
            await plane.land("a", commits.a2, commits.a1);
          }
        },
      },
    });
    expect(code).toBe(0);

    // Three repairs, each a job of the line's run with its own decision; then the range is parked.
    expect(repairs.objectives).toHaveLength(3);
    const { runId } = await plane.lineRun();
    const { scope } = await composerOf(runId);
    const jobs = (await plane.stores.jobContracts.listByRun(scope)).items;
    expect(jobs.map((job) => job.repair?.cause)).toEqual([
      "line_conflict",
      "line_conflict",
      "line_conflict",
    ]);
    expect((await plane.stores.decisions.listByRun(scope)).items).toHaveLength(3);

    const record = await plane.lineRecord();
    expect(record.parked).toHaveLength(1);
    expect(record.parked[0]?.ranges).toEqual([
      { program: plane.programs.a.scope.programId, upTo: commits.a2, from: commits.a1, repairs: 3 },
    ]);
    const reason = record.parked[0]?.reason ?? "";
    expect(reason).toMatch(/the merge conflicted in shared\.txt/);
    expect(reason).toContain(WORDS);
    expect(record.held).toEqual([]);
    expect(record.queue).toEqual([]);

    // Nothing of the parked range reached the line; what was composed before it did.
    const head = origin.refOf(LINE_REF) as string;
    expect(origin.isAncestor(commits.a2, head)).toBe(false);
    expect(origin.show(head, "shared.txt")).toMatch(/^from b\n/);
    expect(origin.linePushes).toEqual([head]);
    expect(await plane.lineRuns()).toEqual([{ runId, status: "succeeded" }]);
  });

  it("creates the line branch on the git server when the first composition finds it absent", async () => {
    const { commits } = origin;
    // The configured line branch was never pushed.
    git(origin.bare, "update-ref", "-d", LINE_REF);
    expect(origin.refOf(LINE_REF)).toBeUndefined();
    await plane.land("a", commits.a1, commits.base);
    const record0 = await plane.lineRecord();
    expect(record0.head).toBeUndefined();
    const requested = await plane.lineRun();

    const { code } = await ownerFor(requested);
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
    const first = await plane.lineRun();

    // Generation 1 takes the batch and its machine is lost before it settles.
    let lost = false;
    const gen1 = await ownerFor(first, {
      hooks: {
        bundleUploadUrl: () => {
          lost = true;
          throw new Error("the machine was lost");
        },
      },
    });
    expect(lost).toBe(true);
    expect(gen1.code).not.toBe(0);
    expect(gen1.linePlane.settles).toEqual([]);
    const held = (await plane.lineRecord()).batch;
    expect(held).toMatchObject({ generation: 1, runId: first.runId });
    expect((await plane.lineRecord()).queue).toEqual([]);
    expect(origin.linePushes).toEqual([]);
    expect((await plane.lineRun()).dispatch.status).toBe("running");

    // Its lease lapses; a replacement generation is admitted.
    const stale = (await plane.lineRun()).dispatch;
    plane.clock.at += 20 * 60_000;
    expect(leaseLost(stale, plane.clock.now())).toBe(true);
    await plane.stores.dispatches.put(
      beginReplacement(stale, "lease_lost", new Date(plane.clock.now()).toISOString()),
    );
    await plane.deps.dispatcher?.provision({
      projectId: plane.projectId,
      programId: lineProgramId(plane.projectId, LINE),
      runId: first.runId as never,
    });
    const replacement = await plane.lineRun();
    expect(replacement.dispatch.generation).toBe(2);
    expect(plane.provisioned.map((entry) => entry.generation)).toEqual([1, 2]);

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
    expect(origin.show(head, "shared.txt")).toMatch(/^from b\n/);
    expect(origin.isAncestor(commits.base, head)).toBe(true);
    expect(record.push).toMatchObject({ head, status: "published", generation: 2 });
    expect((await plane.lineRun()).dispatch.status).toBe("stopped");
  });
});
