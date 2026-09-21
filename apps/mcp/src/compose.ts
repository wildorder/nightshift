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

import { fileURLToPath, pathToFileURL } from "node:url";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import type {
  ArtifactBodyStore,
  ExecutionTokenMinter,
  LocalPaths,
  ProgramScope,
  ProjectStores,
} from "@nightshift/core";
import { createUlidIdGenerator, systemClock } from "@nightshift/core";
import type { GitRunner, WorkerEnvironment, WorkerLaunchIdentity } from "@nightshift/execution";
import { createEventOutbox, nodeGitRunner } from "@nightshift/execution";
import type { Harness, HarnessHandle, McpLaunch } from "@nightshift/harness";
import { createClaudeHarness } from "@nightshift/harness-claude";
import { createCodexHarness } from "@nightshift/harness-codex";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpExecutionTokenMinter,
  createHttpPlanning,
  createHttpStores,
  createLocalPaths,
  createTokenProvider,
  requireProfile,
  staticTokenProvider,
  type Transport,
} from "@nightshift/persistence/http";
import { type Env, EXECUTION_TOKEN_ENV, type Role, workerLaunchEnv } from "./role.js";

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
const constructAdapter = (harness: string, env: Env): Harness => {
  switch (harness) {
    case "claude":
      return createClaudeHarness({ env });
    case "codex":
      return createCodexHarness({ env });
    default:
      // `configuredRoute` refuses a harness with no adapter before anything is
      // persisted, so this is a bug in the table rather than a user's mistake.
      throw new Error(`no adapter is wired for the "${harness}" harness`);
  }
};

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

const createHarness = async (env: Env): Promise<Harness> => {
  const specifier = env[HARNESS_MODULE_ENV];
  if (specifier === undefined || specifier === "") {
    return createRoutedHarness((harness) => constructAdapter(harness, env));
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
    const transport = createFetchTransport({
      endpoint,
      tokens: staticTokenProvider(identity.executionToken),
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

export const createRuntime = async (env: Env, role: Role = "orchestrator"): Promise<Runtime> => {
  const { transport, endpoint } = await createTransport(env, role);
  return {
    transport,
    endpoint,
    planText: async (scope, sha256) =>
      (await createHttpPlanning({ transport }).planDocument(scope, sha256))?.text,
    stores: createHttpStores({ transport }),
    bodies: createHttpArtifactBodyStore({ transport }),
    tokens: createHttpExecutionTokenMinter({ transport }),
    harness: await createHarness(env),
    paths: createLocalPaths({ env }),
    git: nodeGitRunner,
    ids: createUlidIdGenerator(),
    clock: systemClock,
    workerLaunch: createWorkerLaunch(env, endpoint),
    workerEnvironment: createWorkerEnvironment(endpoint),
  };
};
