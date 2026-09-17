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
import type { ArtifactBodyStore, LocalPaths, ProjectStores } from "@nightshift/core";
import { createUlidIdGenerator, systemClock } from "@nightshift/core";
import type { GitRunner, WorkerLaunchIdentity } from "@nightshift/execution";
import { nodeGitRunner } from "@nightshift/execution";
import type { Harness, McpLaunch } from "@nightshift/harness";
import { createClaudeHarness } from "@nightshift/harness-claude";
import {
  createFetchTransport,
  createHttpArtifactBodyStore,
  createHttpStores,
  createLocalPaths,
  createTokenProvider,
  requireProfile,
  staticTokenProvider,
  type Transport,
} from "@nightshift/persistence/http";
import { type Env, workerLaunchEnv } from "./role.js";

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
  readonly harness: Harness;
  readonly paths: LocalPaths;
  readonly git: GitRunner;
  readonly transport: Transport;
  readonly ids: ReturnType<typeof createUlidIdGenerator>;
  readonly clock: typeof systemClock;
  /** The control plane this runtime talks to, for a diagnostic line. */
  readonly endpoint: string;
  /** How to launch a worker's own MCP server, given the identity it must carry. */
  workerLaunch(identity: WorkerLaunchIdentity): McpLaunch;
}

/**
 * How the server reaches the control plane.
 *
 * Normally: the operator's session, from `nightshift login` — a profile that
 * says where the control plane is and a refresh token that mints ID tokens. The
 * server holds no AWS credentials and never will (A-28).
 *
 * The environment pair is for a caller that already holds a token: the deployed
 * slice suite, which uses the machine client's credentials grant rather than an
 * operator's session.
 */
const createTransport = async (env: Env): Promise<{ transport: Transport; endpoint: string }> => {
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

/** The adapter, named here and only here. */
const createHarness = async (env: Env): Promise<Harness> => {
  const specifier = env[HARNESS_MODULE_ENV];
  if (specifier === undefined || specifier === "") return createClaudeHarness({ env });

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
 * What is passed through, and nothing else: the identity, and how to reach the
 * control plane. The worker finds its own credentials the same way this process
 * did, because it runs as the same operating-system user — which is the
 * non-guarantee D-P3-01 states plainly rather than pretending otherwise.
 */
const createWorkerLaunch =
  (env: Env) =>
  (identity: WorkerLaunchIdentity): McpLaunch => {
    const binary = fileURLToPath(new URL("./bin/nightshift-mcp.js", import.meta.url));
    const passThrough: Record<string, string> = {};
    for (const name of [
      API_ENDPOINT_ENV,
      API_TOKEN_ENV,
      "NIGHTSHIFT_CONFIG_DIR",
      "NIGHTSHIFT_STATE_DIR",
    ]) {
      const value = env[name];
      if (value !== undefined && value !== "") passThrough[name] = value;
    }
    return {
      name: "nightshift",
      command: process.execPath,
      args: [binary],
      env: { ...passThrough, ...workerLaunchEnv(identity) },
    };
  };

export const createRuntime = async (env: Env): Promise<Runtime> => {
  const { transport, endpoint } = await createTransport(env);
  return {
    transport,
    endpoint,
    stores: createHttpStores({ transport }),
    bodies: createHttpArtifactBodyStore({ transport }),
    harness: await createHarness(env),
    paths: createLocalPaths({ env }),
    git: nodeGitRunner,
    ids: createUlidIdGenerator(),
    clock: systemClock,
    workerLaunch: createWorkerLaunch(env),
  };
};
