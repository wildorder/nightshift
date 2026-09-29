/**
 * The local instance (P12, D-P12-01): one control plane on loopback over a
 * SQLite file, its bytes as files, a persisted signing key, the operator's
 * bearer token, and the Studio at `/`.
 *
 *   nightshift-local [--port 47820] [--state <dir>] [--studio <dir>]
 *
 * Started by `nightshift local`, in the foreground; `Ctrl-C` stops it. Prints
 * one line a caller can read, `NIGHTSHIFT_LOCAL_READY <api url> <studio url>`,
 * then the human line.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createUlidIdGenerator, nowIso, systemClock } from "@nightshift/core";
import { stateDir } from "@nightshift/persistence/http";
import { createLocalStores } from "@nightshift/persistence/local";
import { keyPath, loadOrCreateKeys, loadOrCreateSecret, tokenPath } from "./credentials.js";
import { ensureOperator } from "./identity.js";
import { createFileObjectStore, objectsDir } from "./objects.js";
import { bearerOf, executionTokenPrincipal, startLocalServer } from "./server.js";

export const DEFAULT_LOCAL_PORT = 47820;
export const PORT_ENV = "NIGHTSHIFT_LOCAL_PORT";
export const API_PREFIX = "/api";
export const READY_LINE = "NIGHTSHIFT_LOCAL_READY";

/** Where a local instance keeps everything: `<state>/local` by default. */
export const localStateDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(stateDir({ env }), "local");

export interface LocalInstance {
  readonly apiUrl: string;
  readonly studioUrl: string;
  readonly tokenFile: string;
  close(): Promise<void>;
}

export const startLocalInstance = async (options: {
  readonly port: number;
  readonly state: string;
  readonly studio?: string;
}): Promise<LocalInstance> => {
  const stores = createLocalStores({ file: join(options.state, "nightshift.sqlite") });
  const secret = loadOrCreateSecret(tokenPath(options.state));
  const keys = loadOrCreateKeys(keyPath(options.state));
  const operator = await ensureOperator(stores, createUlidIdGenerator(), nowIso(systemClock));

  // Exactly the operator's secret, or an execution token this plane signed.
  // Nothing else: no default principal, no `test-principal.` (D-P12-03).
  const server = await startLocalServer({
    stores,
    objects: createFileObjectStore(objectsDir(options.state)),
    keys,
    port: options.port,
    apiPrefix: API_PREFIX,
    authenticate: (authorization, now) => {
      const token = bearerOf(authorization);
      if (token === undefined) return undefined;
      if (token === secret) return operator.principal;
      return executionTokenPrincipal(token, keys, now);
    },
    ...(options.studio === undefined
      ? {}
      : {
          studio: {
            dir: options.studio,
            config: (origin: string) => ({
              stage: "local",
              apiEndpoint: `${origin}${API_PREFIX}`,
              auth: { kind: "token" },
            }),
          },
        }),
  });

  return {
    apiUrl: server.url,
    studioUrl: `${server.origin}/#token=${secret}`,
    tokenFile: tokenPath(options.state),
    close: async () => {
      await server.close();
      stores.close();
    },
  };
};

export const main = async (argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: "string" },
      state: { type: "string" },
      studio: { type: "string" },
    },
  });
  const port = Number(values.port ?? env[PORT_ENV] ?? DEFAULT_LOCAL_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`not a port: ${String(values.port ?? env[PORT_ENV])}`);
  }
  const instance = await startLocalInstance({
    port,
    state: values.state ?? localStateDir(env),
    ...(values.studio === undefined ? {} : { studio: values.studio }),
  });
  process.stdout.write(`${READY_LINE} ${instance.apiUrl} ${instance.studioUrl}\n`);
  process.stdout.write(`Nightshift is running locally. Studio: ${instance.studioUrl}\n`);
  const stop = (): void => {
    instance.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};
