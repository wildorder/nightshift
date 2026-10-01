/**
 * The runner on a run's machine (P10, T2): boot, bootstrap, heartbeat.
 *
 * In T2 the runner learns who it is, takes its first token, mounts the
 * workspace, and heartbeats `ready` to the plane until told to stop. T3 adds
 * the workspace's contents and T4 the headless root between `ready` and
 * `running`; this module is the skeleton they hang on.
 */
import type { RunScope } from "@nightshift/core";
import {
  createFetchTransport,
  type TokenProvider,
  type Transport,
} from "@nightshift/persistence/http";
import { type RunnerIdentity, readIdentity, takeFirstToken } from "./bootstrap.js";
import { createHeartbeat, type Heartbeat } from "./heartbeat.js";
import type { Machine } from "./machine.js";
import { createSampler } from "./sampler.js";
import { mountWorkspace } from "./volume.js";

export interface RunnerOptions {
  readonly machine: Machine;
  readonly log: (line: string) => void;
  /** Where the workspace volume is attached and mounted, from the unit's environment. */
  readonly workspace: string;
  readonly device: string;
  readonly engineUser: string;
  /** Injected by the tests; the real one is `createFetchTransport`. */
  readonly transportFor?: (endpoint: string, tokens: TokenProvider) => Transport;
  /** What runs between `ready` and the stop: T3 and T4 supply it; T2 waits. */
  readonly work?: (context: RunnerContext) => Promise<void>;
}

export interface RunnerContext {
  readonly identity: RunnerIdentity;
  readonly scope: RunScope;
  readonly transport: Transport;
  readonly heartbeat: Heartbeat;
  readonly machine: Machine;
}

/** A token the heartbeat replaces (D-P10-20); never on disk. */
const renewableToken = (initial: string) => {
  let current = initial;
  const provider: TokenProvider = { idToken: async () => current };
  return {
    provider,
    install: (token: string) => {
      current = token;
    },
  };
};

export const runRunner = async (options: RunnerOptions): Promise<number> => {
  const { machine, log } = options;
  const identity = await readIdentity(machine);
  log(`run ${identity.scope.runId}, generation ${identity.generation}, on ${identity.instanceId}`);
  const token = renewableToken(await takeFirstToken(machine, identity));
  const transport = (
    options.transportFor ?? ((endpoint, tokens) => createFetchTransport({ endpoint, tokens }))
  )(identity.apiEndpoint, token.provider);

  await mountWorkspace(machine, {
    device: options.device,
    mountPoint: options.workspace,
    owner: options.engineUser,
  });
  log(`workspace mounted at ${options.workspace}`);

  const heartbeat = createHeartbeat({
    scope: identity.scope,
    generation: identity.generation,
    transport,
    installToken: token.install,
    sample: createSampler(machine, options.workspace).sample,
    sleep: machine.sleep,
    now: machine.now,
    log,
  });
  heartbeat.report("ready");

  const beating = heartbeat.run();
  const context: RunnerContext = {
    identity,
    scope: identity.scope,
    transport,
    heartbeat,
    machine,
  };
  // With no work to do (T2), the runner's job is to stay: it heartbeats until
  // the plane says stop, and a promise that never settles is what "no work"
  // means to the race below.
  const working = (
    options.work === undefined ? new Promise<void>(() => undefined) : options.work(context)
  )
    .then(() => "worked" as const)
    .catch((error: unknown) => {
      log(`the work failed: ${error instanceof Error ? error.message : String(error)}`);
      return "failed" as const;
    });

  const outcome = await Promise.race([beating, working]);
  if (outcome === "worked" || outcome === "failed") {
    // The work ended; tell the plane, let the last beat go out, and stop.
    heartbeat.report("stopped");
    heartbeat.end();
    await beating;
    return outcome === "worked" ? 0 : 1;
  }
  if (outcome === "lost") {
    log("the control plane is lost; the lease will lapse and a replacement will come");
    return 3;
  }
  log("stopping as told");
  return 0;
};
