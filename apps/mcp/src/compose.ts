/**
 * The composition root (D-P3-12, A-31).
 *
 * **This is the only module in `apps/mcp` that may name an adapter.** The
 * architecture rule AR-2 permits `@nightshift/harness-claude` and
 * `@nightshift/persistence/http` here by path and nowhere else, and a negative
 * fixture proves any other file in this app is still refused.
 *
 * The rule as P1 wrote it had no composition root at all, which meant nothing
 * could legally instantiate an adapter — a rule that forbade the program from
 * working. D-P3-12 amends it in the narrowest way that fixes that: one named
 * module per app, and the ban stays absolute on `execution`, `routing`,
 * `verification`, `core` and `contracts`, which are the packages where a
 * harness-specific import would actually do damage.
 *
 * Everything below this file takes its dependencies as parameters. That is why
 * the slice suite can run the real server binary against a scripted harness
 * without the server knowing, and why P5 adds an adapter by changing one
 * `switch` rather than by threading a type through six packages.
 */

import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CommitShaSchema,
  HeartbeatResponseSchema,
  ProgramIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@nightshift/contracts";
import type {
  ArtifactBodyStore,
  ExecutionTokenMinter,
  LocalPaths,
  ProgramScope,
  ProjectStores,
  RunScope,
} from "@nightshift/core";
import { createUlidIdGenerator, systemClock } from "@nightshift/core";
import type {
  ExecutionEnvironment,
  GitRunner,
  PrerequisiteBook,
  PublishLanding,
  WorkerEnvironment,
  WorkerLaunchIdentity,
} from "@nightshift/execution";
import { createEventOutbox, createPublicationQueue, nodeGitRunner } from "@nightshift/execution";
import {
  type CliLauncher,
  type Harness,
  type HarnessHandle,
  type McpLaunch,
  type NodeCliDeps,
  nodeCliDeps,
  resolveNodeCli,
  type TranscriptSource,
} from "@nightshift/harness";
import { claudeTranscriptSource, createClaudeHarness } from "@nightshift/harness-claude";
import { codexTranscriptSource, createCodexHarness } from "@nightshift/harness-codex";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpExecutionTokenMinter,
  createHttpPlanning,
  createHttpStores,
  createLocalPaths,
  createTokenProvider,
  type PlanningClient,
  requireProfile,
  routes,
  send,
  staticTokenProvider,
  type Transport,
} from "@nightshift/persistence/http";
import { readProjectEnv } from "./project-env.js";
import {
  type Env,
  EXECUTION_TOKEN_ENV,
  EXECUTION_TOKEN_FILE_ENV,
  type Role,
  workerLaunchEnv,
} from "./role.js";
import { createReclaim, createWorkerUsers } from "./run-as.js";
import type { PlaneFactory } from "./runner/plane.js";
import { IMAGE_PATH } from "./runner/workspace.js";
import { createWorkerTokenFiles } from "./worker-token-files.js";

/**
 * The runner's view of the control plane (P10, T3), over the same HTTP adapter
 * the server uses. The engine token is renewed by the heartbeat, so the
 * provider is asked for it on every request rather than once.
 */
export const createRunnerPlane: PlaneFactory = (endpoint, tokens) => {
  const transport = createFetchTransport({ endpoint, tokens });
  const stores = createHttpStores({ transport });
  const planning = createHttpPlanning({ transport });
  return {
    dispatch: (scope) => stores.dispatches.get(scope),
    program: (scope) => stores.programContracts.get(scope.projectId, scope.programId),
    planDocument: (scope, sha256) => planning.planDocument(scope, sha256),
    heartbeat: (scope, body) =>
      send(transport, { method: "POST", path: routes.dispatchHeartbeat(scope), body }).then(
        (response) => HeartbeatResponseSchema.parse(response),
      ),
  };
};

/**
 * Where the slice suite points the server at its own control plane and its own
 * harness. Both are read only here.
 *
 * `NIGHTSHIFT_HARNESS_MODULE` is a module specifier whose `createHarness` export
 * builds a `Harness`. It exists so T9 can run **the real server binary** against
 * its scripted, out-of-process harness — a suite that tested a different server
 * would prove nothing about this one. It is not something a real deployment
 * sets, and it is no more powerful than the ability to spawn this process with
 * an environment already is: whoever sets it could simply have spawned something
 * else.
 */
export const HARNESS_MODULE_ENV = "NIGHTSHIFT_HARNESS_MODULE";
/** An API endpoint and a token, for a session that has not run `nightshift login`. */
export const API_ENDPOINT_ENV = "NIGHTSHIFT_API_ENDPOINT";
export const API_TOKEN_ENV = "NIGHTSHIFT_API_TOKEN";
/**
 * P10 (D-P10-20): a file holding the current token, read on every request,
 * rewritten by whoever renews it. On a machine the runner keeps the engine's
 * token here, on tmpfs, readable by `engine` alone, and the orchestrator-role
 * server it launches follows every renewal without a restart.
 */
export const API_TOKEN_FILE_ENV = "NIGHTSHIFT_API_TOKEN_FILE";
/**
 * P10 (D-P10-22): set by the runner on the orchestrator-role server it launches
 * and nowhere else. Its value is the program branch's head at GitHub when the
 * run was dispatched: the first publication intent's predecessor. Present, the
 * engine raises an intent after every landing; absent, it publishes nothing.
 */
export const PUBLISH_BASE_ENV = "NIGHTSHIFT_PUBLISH_BASE";
/** Where the packs are written before upload; the run's directory on the volume. */
export const PUBLISH_PACK_DIR_ENV = "NIGHTSHIFT_PUBLISH_PACK_DIR";
/**
 * P10 (D-P10-25): how many `worker-N` users the machine has; set by the runner
 * on the orchestrator-role server it launches. Present, every job's agent runs
 * as one of them; absent, as this process.
 */
export const WORKER_USERS_ENV = "NIGHTSHIFT_WORKER_USERS";
/** Where a worker's own credential directories are, `<root>/<user>/<VAR>`. */
export const WORKER_CREDENTIAL_DIR_ENV = "NIGHTSHIFT_WORKER_CREDENTIAL_DIR";

export interface Runtime {
  readonly stores: ProjectStores;
  readonly bodies: ArtifactBodyStore;
  /** Mints a worker's execution token. The orchestrator's session may; a worker's cannot. */
  readonly tokens: ExecutionTokenMinter;
  readonly harness: Harness;
  readonly paths: LocalPaths;
  readonly git: GitRunner;
  readonly transport: Transport;
  readonly ids: ReturnType<typeof createUlidIdGenerator>;
  readonly clock: typeof systemClock;
  /** The control plane this runtime talks to, for a diagnostic line. */
  readonly endpoint: string;
  /**
   * The ratified plan document, by its hash, **from the control plane** (P7,
   * D-P7-02): a run reads the plan it was ratified with, never whatever is on
   * disk by now. `undefined` when the control plane holds none. Optional so a
   * suite that runs no planned program need not supply one.
   */
  readonly planText?: (scope: ProgramScope, sha256: string) => Promise<string | undefined>;
  /**
   * The program's prerequisites as they stand now, for deferring a check that
   * needs one (D-P7-10); and, on a run's machine, where its own checks are
   * recorded before its gate audit (P16, D-08).
   */
  readonly prerequisites?: PrerequisiteBook & Pick<PlanningClient, "recordMachineCheck">;
  /**
   * P10 (D-P10-22): the publication hook for a run, when this process is a
   * machine's engine. The session installs it on the run's environment.
   */
  readonly publication?: (scope: RunScope) => PublishLanding;
  /** P10 (D-P10-25): who an agent runs as on a machine; absent on a laptop. */
  readonly runAs?: ExecutionEnvironment["runAs"];
  /** P10 (D-P10-25): takes a granted path back for the engine; with `runAs`. */
  readonly reclaim?: ExecutionEnvironment["reclaim"];
  /** P10 (T4): where a worker's token file lives on a machine; absent on a laptop. */
  readonly workerTokens?: ExecutionEnvironment["workerTokens"];
  /**
   * P16 (D-10): the project environment the runner wrote, given to every
   * project step the engine runs; absent on a laptop. Never this process's own.
   */
  readonly projectEnv?: ExecutionEnvironment["projectEnv"];
  /** How to launch a worker's own MCP server, given the identity it must carry. */
  workerLaunch(identity: WorkerLaunchIdentity): McpLaunch;
  /**
   * The same worker, reached without a process (A-37): stores and an outbox over
   * a transport that holds that worker's execution token and nothing else.
   */
  workerEnvironment(identity: WorkerLaunchIdentity): WorkerEnvironment;
}

/** A worker-role server started without the one credential it is allowed to have. */
export class MissingExecutionTokenError extends Error {
  override readonly name = "MissingExecutionTokenError";

  constructor(readonly missing: readonly string[]) {
    super(
      "a worker-role Nightshift MCP server reaches the control plane with its execution " +
        `token and nothing else, and these are missing or empty: ${missing.join(", ")}. ` +
        "The execution layer sets both when it launches a worker; a worker never reads the " +
        "operator's credentials (D-P4-06).",
    );
  }
}

/**
 * How a **worker** reaches the control plane (P4, T4, D-P4-06).
 *
 * Its execution token, and nothing else. No profile, no credentials file, no
 * refresh token, no fallback — a worker that cannot prove it is its own agent
 * does not start, rather than quietly starting as whoever launched it. That is
 * the whole of what P4 changes for a worker, and it is why this branch has no
 * `??` in it.
 */
const createWorkerTransport = (env: Env): { transport: Transport; endpoint: string } => {
  const endpoint = env[API_ENDPOINT_ENV];
  const token = env[EXECUTION_TOKEN_ENV];
  const tokenFile = env[EXECUTION_TOKEN_FILE_ENV];
  // P10 (T4): on a machine the token is a file the engine keeps fresh, read on
  // every request so a renewal needs no restart.
  if (endpoint !== undefined && endpoint !== "" && tokenFile !== undefined && tokenFile !== "") {
    return {
      endpoint,
      transport: createFetchTransport({
        endpoint,
        tokens: { idToken: async () => (await readFile(tokenFile, "utf8")).trim() },
      }),
    };
  }
  const missing = [
    ...(endpoint === undefined || endpoint === "" ? [API_ENDPOINT_ENV] : []),
    ...(token === undefined || token === "" ? [EXECUTION_TOKEN_ENV] : []),
  ];
  if (missing.length > 0 || endpoint === undefined || token === undefined) {
    throw new MissingExecutionTokenError(missing);
  }
  return {
    endpoint,
    transport: createFetchTransport({ endpoint, tokens: staticTokenProvider(token) }),
  };
};

/**
 * How an **orchestrator** reaches the control plane.
 *
 * The operator's session, from `nightshift login` — a profile that says where
 * the control plane is and a refresh token that mints ID tokens. The server
 * holds no AWS credentials and never will (A-28). The orchestrator keeps the
 * human's session in P4 by decision (D-P4-06): it is the human's proxy, and a
 * remote orchestrator's own token is P10's change.
 *
 * The environment pair is for a caller that already holds a token: the deployed
 * slice suite, which uses the machine client's credentials grant rather than an
 * operator's session.
 */
const createOrchestratorTransport = async (
  env: Env,
): Promise<{ transport: Transport; endpoint: string }> => {
  const endpoint = env[API_ENDPOINT_ENV];
  const token = env[API_TOKEN_ENV];
  const tokenFile = env[API_TOKEN_FILE_ENV];
  if (endpoint !== undefined && endpoint !== "" && tokenFile !== undefined && tokenFile !== "") {
    return {
      endpoint,
      transport: createFetchTransport({
        endpoint,
        tokens: { idToken: async () => (await readFile(tokenFile, "utf8")).trim() },
      }),
    };
  }
  if (endpoint !== undefined && endpoint !== "" && token !== undefined && token !== "") {
    return {
      endpoint,
      transport: createFetchTransport({ endpoint, tokens: staticTokenProvider(token) }),
    };
  }

  const profile = await requireProfile({ env });
  return {
    endpoint: profile.apiEndpoint,
    transport: createFetchTransport({
      endpoint: profile.apiEndpoint,
      tokens: createTokenProvider({ profile, paths: { env } }),
    }),
  };
};

const createTransport = async (
  env: Env,
  role: Role,
): Promise<{ transport: Transport; endpoint: string }> =>
  // Only the human's orchestrator reads the operator's session. Every role that
  // Nightshift launched holds an execution token and nothing else (D-P4-06).
  role === "orchestrator" ? createOrchestratorTransport(env) : createWorkerTransport(env);

/**
 * What `await import()` is actually given for {@link HARNESS_MODULE_ENV}.
 *
 * A filesystem path becomes a `file://` URL, because on Windows a bare
 * `C:\Users\…\scripted.js` is not an importable specifier at all: the ESM
 * resolver reads `C:` as a URL scheme and refuses it with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`. A bare package name is left exactly as
 * written, so both forms of specifier work and a POSIX absolute path keeps
 * behaving as it always did.
 *
 * Exported only so a test can state the rule for a Windows path without being
 * on Windows.
 */
export const harnessModuleSpecifier = (specifier: string): string => {
  const isPath = /^[./\\]/.test(specifier) || /^[A-Za-z]:[\\/]/.test(specifier);
  return isPath ? pathToFileURL(specifier).href : specifier;
};

/**
 * The adapters, named here and only here (AR-2, D-P3-12).
 *
 * One `switch` over the harnesses the compatibility table can route to today.
 * **Only the adapter a route chose is ever constructed**, and only when the
 * first job is routed to it: a machine without Codex runs a Claude job without
 * anything Codex-shaped being built, looked up or complained about.
 */
const constructAdapter = (harness: string, env: Env, onMachine: boolean): Harness => {
  const launcher = onMachine ? agentLauncher(harness) : undefined;
  switch (harness) {
    case "claude":
      return createClaudeHarness({ env, ...(launcher === undefined ? {} : { launcher }) });
    case "codex":
      return createCodexHarness({ env, ...(launcher === undefined ? {} : { launcher }) });
    default:
      // `ruleRoute` refuses a harness the compatibility table does not know before anything is
      // persisted, so this is a bug in the table rather than a user's mistake.
      throw new Error(`no adapter is wired for the "${harness}" harness`);
  }
};

/**
 * How an agent CLI is launched on a machine (P16 S-01): `claude` and `codex`
 * found on the image's PATH and run through the image's Node by absolute path
 * (`process.execPath`, which the runner's unit sets to `/usr/local/bin/node`),
 * so a project's pinned Node first on PATH cannot run them. `undefined` when
 * the bin is not on the image's PATH: it is then started by name, as on a laptop.
 */
export const agentLauncher = (
  bin: string,
  deps: NodeCliDeps = nodeCliDeps(IMAGE_PATH),
  nodePath: string = process.execPath,
): CliLauncher | undefined => resolveNodeCli(bin, nodePath, deps);

/**
 * A `Harness` that hands each worker to the adapter its route named.
 *
 * The execution layer holds one `Harness` and never learns there are several
 * (SC-P5-12): `start` reads `input.model.harness`, which routing wrote, and
 * `cancel` and `status` go back to whichever adapter made the handle.
 */
export const createRoutedHarness = (construct: (harness: string) => Harness): Harness => {
  const adapters = new Map<string, Harness>();
  const owners = new WeakMap<HarnessHandle, Harness>();
  const adapterFor = (harness: string): Harness => {
    const existing = adapters.get(harness);
    if (existing !== undefined) return existing;
    const made = construct(harness);
    adapters.set(harness, made);
    return made;
  };

  return {
    id: "routed",
    // True of the whole: an adapter that reports none simply attaches none.
    capabilities: { usage: true },
    start: async (input) => {
      const adapter = adapterFor(input.model.harness);
      const handle = await adapter.start(input);
      owners.set(handle, adapter);
      return handle;
    },
    cancel: async (handle, grace) => {
      await owners.get(handle)?.cancel(handle, grace);
    },
    status: async (handle) => (await owners.get(handle)?.status(handle)) ?? "created",
  };
};

const createHarness = async (env: Env, onMachine: boolean): Promise<Harness> => {
  const specifier = env[HARNESS_MODULE_ENV];
  if (specifier === undefined || specifier === "") {
    return createRoutedHarness((harness) => constructAdapter(harness, env, onMachine));
  }

  const module: unknown = await import(harnessModuleSpecifier(specifier));
  const factory = (module as { createHarness?: unknown }).createHarness;
  if (typeof factory !== "function") {
    throw new Error(`${HARNESS_MODULE_ENV}=${specifier} does not export a createHarness function`);
  }
  return (factory as () => Harness)();
};

/**
 * The worker's MCP server: this same binary, spawned with `worker` in its
 * environment and its execution identity beside it (§4.2).
 *
 * Resolved from this module's own location rather than from `PATH`, so the
 * worker runs the build the orchestrator is running — a half-upgraded install
 * where the two disagree is a very confusing afternoon.
 *
 * What is passed through, and nothing else: the identity, its token, and where
 * the control plane is (P4, T4, §4.5).
 *
 * **`NIGHTSHIFT_CONFIG_DIR` is deliberately absent**, and so is
 * `NIGHTSHIFT_API_TOKEN`. Before P4 a worker inherited the config directory and
 * found the operator's refresh token in it, because it runs as the same
 * operating-system user — the non-guarantee D-P3-01 stated plainly. It now
 * carries a credential that can do exactly its four operations on its own node
 * and nothing that could yield a human's.
 *
 * The endpoint is written explicitly rather than passed through, because the
 * orchestrator may have learned it from a profile the worker will never read.
 */
export const createWorkerLaunch =
  (env: Env, endpoint: string) =>
  (identity: WorkerLaunchIdentity): McpLaunch => {
    const binary = fileURLToPath(new URL("./bin/nightshift-mcp.js", import.meta.url));
    const passThrough: Record<string, string> = { [API_ENDPOINT_ENV]: endpoint };
    // The state directory only: worktrees, spool and transcripts. Nothing here
    // names a credential.
    const stateDir = env.NIGHTSHIFT_STATE_DIR;
    if (stateDir !== undefined && stateDir !== "") passThrough.NIGHTSHIFT_STATE_DIR = stateDir;
    return {
      name: "nightshift",
      command: process.execPath,
      args: [binary],
      env: { ...passThrough, ...workerLaunchEnv(identity) },
    };
  };

/**
 * The worker launch builder, exported so its **absences** can be asserted
 * directly (T4 deliverable 3). What a worker is not given is the security
 * property, and it is cheaper to check here than by inspecting a live process.
 */
export const createWorkerLaunchForTest = createWorkerLaunch;

/**
 * The environment a worker's operations run in when an adapter calls them as
 * functions rather than through a spawned MCP server (A-37, D-P5-01).
 *
 * Built exactly as `createWorkerTransport` builds a worker process's: the
 * execution token, statically, and nothing else. The orchestrator's own
 * transport is deliberately not reused, because a write made on a worker's
 * behalf with a human's token would be recorded as the human's (A-35), and would
 * be allowed things a worker is not.
 */
export const createWorkerEnvironment =
  (endpoint: string) =>
  (identity: WorkerLaunchIdentity): WorkerEnvironment => {
    const file = identity.executionTokenFile;
    const transport = createFetchTransport({
      endpoint,
      tokens:
        file === undefined
          ? staticTokenProvider(identity.executionToken)
          : { idToken: async () => (await readFile(file, "utf8")).trim() },
    });
    const stores = createHttpStores({ transport });
    return {
      stores,
      clock: systemClock,
      git: nodeGitRunner,
      outbox: createEventOutbox({
        events: stores.events,
        scope: {
          projectId: ProjectIdSchema.parse(identity.projectId),
          programId: ProgramIdSchema.parse(identity.programId),
          runId: RunIdSchema.parse(identity.runId),
        },
        clock: systemClock,
        ids: createUlidIdGenerator(),
        // A worker's events are its own writer's (A-30), keyed by its agent id.
        writerId: identity.agentId,
      }),
    };
  };

/**
 * The publication hook for a machine's engine (D-P10-22): a pack per landing,
 * uploaded as a `bundle` artifact through the plane's signed upload, then the
 * intent. Built only when the runner set the base; a local run has none.
 */
const createPublication = (
  env: Env,
  transport: Transport,
  bodies: ArtifactBodyStore,
  ids: ReturnType<typeof createUlidIdGenerator>,
): ((scope: RunScope) => PublishLanding) | undefined => {
  const base = env[PUBLISH_BASE_ENV];
  if (base === undefined || base === "") return undefined;
  const packDir = env[PUBLISH_PACK_DIR_ENV];
  return (scope) =>
    createPublicationQueue({
      baseSha: CommitShaSchema.parse(base),
      packDir:
        packDir === undefined || packDir === "" ? `/tmp/nightshift-packs/${scope.runId}` : packDir,
      upload: async (pack, head) => {
        // The pack is a body under the run's prefix; the intent's `bundleKey`
        // is its only reference, and the publisher is its only reader.
        const stored = await bodies.put(scope, ids.next("art"), pack, "application/x-git-pack");
        void head;
        return { key: stored.key };
      },
      request: async (body) => {
        await send(transport, { method: "POST", path: routes.publication(scope), body });
      },
      log: (line) => process.stderr.write(`[nightshift-mcp] ${line}\n`),
    });
};

export const createRuntime = async (env: Env, role: Role = "orchestrator"): Promise<Runtime> => {
  const { transport, endpoint } = await createTransport(env, role);
  const ids = createUlidIdGenerator();
  const bodies = createHttpArtifactBodyStore({ transport });
  const publication = createPublication(env, transport, bodies, ids);
  const workerUsers = Number.parseInt(env[WORKER_USERS_ENV] ?? "", 10);
  const credentialRoot = env[WORKER_CREDENTIAL_DIR_ENV];
  // The project environment the runner wrote (P16 S-01): only on a machine.
  // Threaded to the steps and the worker users, never adopted (D-10).
  const projectEnv = await readProjectEnv(env);
  const runAs =
    Number.isFinite(workerUsers) && workerUsers > 0
      ? createWorkerUsers({
          count: workerUsers,
          ...(credentialRoot === undefined || credentialRoot === "" ? {} : { credentialRoot }),
          ...(projectEnv === undefined ? {} : { projectEnv }),
        })
      : undefined;
  return {
    transport,
    endpoint,
    ...(publication === undefined ? {} : { publication }),
    ...(runAs === undefined ? {} : { runAs }),
    ...(runAs === undefined ? {} : { reclaim: createReclaim(userInfo().username) }),
    ...(runAs === undefined ? {} : { workerTokens: createWorkerTokenFiles(runAs) }),
    ...(projectEnv === undefined ? {} : { projectEnv }),
    planText: async (scope, sha256) =>
      (await createHttpPlanning({ transport }).planDocument(scope, sha256))?.text,
    prerequisites: createHttpPlanning({ transport }),
    stores: createHttpStores({ transport }),
    bodies,
    tokens: createHttpExecutionTokenMinter({ transport }),
    harness: await createHarness(env, projectEnv !== undefined),
    paths: createLocalPaths({ env }),
    git: nodeGitRunner,
    ids,
    clock: systemClock,
    workerLaunch: createWorkerLaunch(env, endpoint),
    workerEnvironment: createWorkerEnvironment(endpoint),
  };
};

/**
 * Every harness's reader of a planning session's transcript (P14, D-P14-07),
 * for `nightshift-transcript`. Named here because it is a harness's code.
 */
export const transcriptSources = (): readonly TranscriptSource[] => [
  claudeTranscriptSource,
  codexTranscriptSource,
];
