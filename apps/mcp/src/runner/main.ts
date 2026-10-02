/**
 * The runner on a run's machine (P10, T2, T3): boot, bootstrap, heartbeat,
 * workspace, and then the work.
 *
 * Order: who am I (tags), my first token (SSM), the volume mounted, the
 * heartbeat started so the plane knows the machine is up and hands back the
 * clone's credential, the workspace prepared on the volume (mirror, checkout
 * at the authorised SHA, plan hashed, setup run), `ready` reported, and then
 * whatever work T4 supplies (the headless root) until it ends or the plane
 * says stop.
 */
import type { Dispatch, ProgramContract } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { type RunnerIdentity, readIdentity, takeFirstToken } from "./bootstrap.js";
import { createHeartbeat, type Heartbeat } from "./heartbeat.js";
import type { Machine } from "./machine.js";
import type { EngineTokens, PlaneFactory, RunnerPlane } from "./plane.js";
import { createSampler } from "./sampler.js";
import { mountWorkspace } from "./volume.js";
import { layoutOf, prepareWorkspace, type WorkspaceLayout } from "./workspace.js";

export interface RunnerOptions {
  readonly machine: Machine;
  readonly log: (line: string) => void;
  /** Where the workspace volume is attached and mounted, from the unit's environment. */
  readonly workspace: string;
  readonly device: string;
  readonly engineUser: string;
  /** The plane, from the composition root (AR-2) or a test's fake. */
  readonly plane: PlaneFactory;
  /** What runs between `ready` and the stop: the headless root (T4). Absent, the runner waits. */
  readonly work?: (context: RunnerContext) => Promise<void>;
  /**
   * Told every engine token, the first and each renewal (D-P10-20), so the
   * composition can place it where the root's processes read it.
   */
  readonly onToken?: (token: string, scope: RunScope) => Promise<void>;
  /** How long to wait for the plane to hand over the clone's credential. */
  readonly credentialTimeoutMs?: number;
}

export interface RunnerContext {
  readonly identity: RunnerIdentity;
  readonly scope: RunScope;
  readonly plane: RunnerPlane;
  readonly heartbeat: Heartbeat;
  readonly machine: Machine;
  readonly layout: WorkspaceLayout;
  readonly dispatch: Dispatch;
  readonly program: ProgramContract;
}

/** A token the heartbeat replaces (D-P10-20); never on the volume. */
const renewableToken = (
  initial: string,
  onToken: ((token: string) => Promise<void>) | undefined,
) => {
  let current = initial;
  const provider: EngineTokens = { idToken: async () => current };
  return {
    provider,
    install: (token: string) => {
      current = token;
      void onToken?.(token).catch(() => undefined);
    },
  };
};

/** Waits for the heartbeat to bring the clone's credential, or gives up. */
const awaitGithubToken = async (
  heartbeat: Heartbeat,
  machine: Machine,
  timeoutMs: number,
): Promise<string> => {
  const deadline = machine.now() + timeoutMs;
  for (;;) {
    const token = heartbeat.last?.credentials?.github;
    if (token !== undefined) return token;
    if (heartbeat.last?.stop === true) {
      throw new Error("told to stop before the workspace was made");
    }
    if (machine.now() >= deadline) {
      throw new Error("the plane sent no GitHub credential; is the org's installation recorded?");
    }
    await machine.sleep(1000);
  }
};

export const runRunner = async (options: RunnerOptions): Promise<number> => {
  const { machine, log } = options;
  const identity = await readIdentity(machine);
  log(`run ${identity.scope.runId}, generation ${identity.generation}, on ${identity.instanceId}`);
  const onToken = options.onToken;
  const token = renewableToken(
    await takeFirstToken(machine, identity),
    onToken === undefined ? undefined : (renewed) => onToken(renewed, identity.scope),
  );
  await onToken?.(await token.provider.idToken(), identity.scope);
  const plane = options.plane(identity.apiEndpoint, token.provider);

  await mountWorkspace(machine, {
    device: options.device,
    mountPoint: options.workspace,
    owner: options.engineUser,
  });
  log(`workspace mounted at ${options.workspace}`);

  const heartbeat = createHeartbeat({
    generation: identity.generation,
    post: (body) => plane.heartbeat(identity.scope, body),
    installToken: token.install,
    sample: createSampler(machine, options.workspace).sample,
    sleep: machine.sleep,
    now: machine.now,
    log,
  });
  const beating = heartbeat.run();

  // The workspace (T3): what the run is, from the plane; the clone's
  // credential, from the heartbeat; then the volume filled and setup run.
  const layout = layoutOf(options.workspace, identity.scope.runId);
  let context: RunnerContext;
  try {
    const [dispatch, program] = await Promise.all([
      plane.dispatch(identity.scope),
      plane.program(identity.scope),
    ]);
    if (dispatch === undefined || program === undefined) {
      throw new Error("the plane has no dispatch or program for this run");
    }
    const planDocument =
      program.planDocument === undefined
        ? undefined
        : await plane.planDocument(identity.scope, program.planDocument.sha256);
    if (planDocument === undefined) {
      throw new Error("the ratified plan's document is not on the plane");
    }
    const githubToken = await awaitGithubToken(
      heartbeat,
      machine,
      options.credentialTimeoutMs ?? 2 * 60_000,
    );
    const prepared = await prepareWorkspace(machine, {
      layout,
      dispatch,
      program,
      planText: planDocument.text,
      githubToken,
      log,
    });
    log(
      `workspace ${prepared.warm ? "warm" : "cold"}: setup took ${prepared.setupSeconds.toFixed(1)}s`,
    );
    heartbeat.describeSetup(prepared.setupSeconds, prepared.lockfileHashes);
    heartbeat.report("ready");
    context = {
      identity,
      scope: identity.scope,
      plane,
      heartbeat,
      machine,
      layout,
      dispatch,
      program,
    };
  } catch (error) {
    log(
      `the workspace could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    );
    heartbeat.end();
    await beating;
    await heartbeat.farewell("stopped");
    return 1;
  }

  // With no work yet (T3), the runner's job is to stay: it heartbeats until
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
  // Told to stop (cancelled, a ceiling, or superseded): the work is abandoned
  // where it stands, and the plane hears `stopped` from the runner itself so
  // the dispatch settles without waiting for the reconciler's lost lease.
  log(`stopping as told: the dispatch is ${heartbeat.last?.status ?? "unknown"}`);
  await heartbeat.farewell("stopped");
  return 0;
};
