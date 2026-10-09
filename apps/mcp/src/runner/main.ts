/**
 * The runner on a run's machine (P10, T2, T3): boot, bootstrap, heartbeat,
 * workspace, and then the work.
 *
 * Order: who am I (tags), my first token (SSM), the heartbeat started so the
 * plane knows the machine is up and hands back the clone's credential, the
 * volume mounted, the workspace prepared on the volume (mirror, checkout at
 * the authorised SHA, plan hashed, setup run), `ready` reported, and then
 * whatever work T4 supplies (the headless root) until it ends or the plane
 * says stop.
 *
 * A machine that cannot prepare its workspace, from the mount to setup, says
 * so: its last heartbeat is `stopped` with `setup_failed` and the cause, and
 * the dispatch ends `failed` (P16 SC-07) instead of waiting for the reconciler
 * to give up on the lease. The work can end the dispatch the same way, with a
 * failure of its own (`environment_fault`, D-07).
 */
import type { Dispatch, ProgramContract, RunnerFailure } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { WORKER_GROUP } from "../run-as.js";
import { type RunnerIdentity, readIdentity, takeFirstToken } from "./bootstrap.js";
import { createHeartbeat, type Heartbeat } from "./heartbeat.js";
import type { Machine } from "./machine.js";
import type { EngineTokens, PlaneFactory, RunnerPlane } from "./plane.js";
import { createSampler } from "./sampler.js";
import {
  restoreFromSidecar,
  type SidecarSync,
  sidecarHoldsCopy,
  startSidecarSync,
} from "./sidecar.js";
import { findLocalDisk, mountWorkspace } from "./volume.js";
import { layoutOf, prepareWorkspace, type WorkspaceLayout } from "./workspace.js";

export interface RunnerOptions {
  readonly machine: Machine;
  readonly log: (line: string) => void;
  /** Where the workspace volume is attached and mounted, from the unit's environment. */
  readonly workspace: string;
  readonly device: string;
  readonly engineUser: string;
  /** Where the volume is mounted when the workspace is on the local disk (D-P10-27). */
  readonly sidecar?: string;
  /** How often the workspace is copied to the sidecar; the default is a minute. */
  readonly sidecarIntervalMs?: number;
  /** The plane, from the composition root (AR-2) or a test's fake. */
  readonly plane: PlaneFactory;
  /**
   * What runs between `ready` and the stop: the headless root (T4). Absent, the
   * runner waits. Resolving with a failure ends the dispatch `failed` with it.
   */
  readonly work?: (context: RunnerContext) => Promise<RunnerWorkEnd | undefined>;
  /**
   * Told every engine token, the first and each renewal (D-P10-20), so the
   * composition can place it where the root's processes read it.
   */
  readonly onToken?: (token: string, scope: RunScope) => Promise<void>;
  /** How long to wait for the plane to hand over the clone's credential. */
  readonly credentialTimeoutMs?: number;
  /** The runner's own PATH, kept in the project environment after the runtimes and the image's. */
  readonly inheritedPath?: string;
}

/** How the work ends the dispatch when it cannot go on: the failure the plane records. */
export interface RunnerWorkEnd {
  readonly failure: RunnerFailure;
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
  /**
   * The one project environment (P16 S-01): the pinned runtimes first on PATH
   * and the stores. Handed explicitly to every project step (P16, D-10): the
   * gate audit's here, the engine's through `ExecutionEnvironment.projectEnv`,
   * each worker user's through `RunAs.env`. Never the runner's own.
   */
  readonly projectEnv: Readonly<Record<string, string>>;
  /** Where it was written, for the processes the runner launches: `<run>/project.env`. */
  readonly projectEnvFile: string;
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

/** The most of a cause the dispatch's record keeps: setup's output can run long. */
const MAX_CAUSE_LENGTH = 2000;

/** An error as one line of cause, never empty and never past `MAX_CAUSE_LENGTH`. */
const causeOf = (error: unknown): string => {
  const said = (error instanceof Error ? error.message : String(error)).trim();
  const cause = said === "" ? "an error with no message" : said;
  return cause.length <= MAX_CAUSE_LENGTH ? cause : `${cause.slice(0, MAX_CAUSE_LENGTH - 1)}…`;
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

  // Beating before the volume is mounted, so a mount that fails can still be
  // reported; the disk samples read the root's until the mount is there.
  const heartbeat = createHeartbeat({
    generation: identity.generation,
    post: (body) => plane.heartbeat(identity.scope, body),
    installToken: token.install,
    sample: createSampler(machine, options.workspace).sample,
    sleep: machine.sleep,
    now: machine.now,
    log,
  });
  // The first beat says the machine is up (P16 S-03).
  heartbeat.progress({ stage: "up", detail: `on ${identity.instanceId}` });
  const beating = heartbeat.run();

  let sync: SidecarSync | undefined;
  const settle = async () => {
    if (sync === undefined) return;
    const started = machine.now();
    await sync.stop();
    sync = undefined;
    log(`sidecar: final copy took ${((machine.now() - started) / 1000).toFixed(1)}s`);
  };

  // The workspace (T3): the volume mounted; what the run is, from the plane;
  // the clone's credential, from the heartbeat; then the volume filled and
  // setup run. Any of it failing ends the dispatch `failed` (P16 SC-07).
  const layout = layoutOf(options.workspace, identity.scope.runId);
  let context: RunnerContext;
  try {
    // The workspace goes on the instance's local disk when it has one (D-P10-27),
    // with the volume mounted beside it as the sidecar; on the volume itself when
    // the record says so or the instance type has no local disk.
    heartbeat.progress({ stage: "workspace", detail: "mounting the volume" });
    const asked = (await plane.dispatch(identity.scope))?.workspace?.disk;
    const localDisk = asked === "volume" ? undefined : await findLocalDisk(machine);
    const sidecar =
      localDisk === undefined ? undefined : (options.sidecar ?? `${options.workspace}-sidecar`);
    await mountWorkspace(machine, {
      device: options.device,
      mountPoint: sidecar ?? options.workspace,
      owner: options.engineUser,
      group: WORKER_GROUP,
    });
    if (localDisk !== undefined && sidecar !== undefined) {
      await mountWorkspace(machine, {
        device: options.device,
        mountPoint: options.workspace,
        owner: options.engineUser,
        group: WORKER_GROUP,
        disk: "local",
      });
      if (await sidecarHoldsCopy(machine, sidecar)) {
        const started = machine.now();
        await restoreFromSidecar(machine, sidecar, options.workspace);
        log(
          `workspace restored from the sidecar in ${((machine.now() - started) / 1000).toFixed(1)}s`,
        );
      }
      log(`workspace mounted at ${options.workspace} (local NVMe; sidecar at ${sidecar})`);
    } else {
      log(
        `workspace mounted at ${options.workspace} (volume${asked === "volume" ? ", as the record asks" : "; no local disk"})`,
      );
    }
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
      onProgress: (progress) => heartbeat.progress(progress),
      ...(options.inheritedPath === undefined ? {} : { inheritedPath: options.inheritedPath }),
    });
    log(
      `workspace ${prepared.warm ? "warm" : "cold"}: setup took ${prepared.setupSeconds.toFixed(1)}s`,
    );
    heartbeat.describeSetup(prepared.setupSeconds, prepared.lockfileHashes);
    if (sidecar !== undefined) {
      sync = startSidecarSync(machine, {
        workspace: options.workspace,
        sidecar,
        intervalMs: options.sidecarIntervalMs ?? 60_000,
        log,
      });
    }
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
      projectEnv: prepared.environment,
      projectEnvFile: prepared.environmentFile,
    };
  } catch (error) {
    const cause = causeOf(error);
    log(`the workspace could not be prepared: ${cause}`);
    await settle();
    heartbeat.end();
    await beating;
    await heartbeat.farewell("stopped", {
      code: "setup_failed",
      message: `the workspace could not be prepared: ${cause}`,
    });
    return 1;
  }

  // With no work yet (T3), the runner's job is to stay: it heartbeats until
  // the plane says stop, and a promise that never settles is what "no work"
  // means to the race below.
  const working = (
    options.work === undefined
      ? new Promise<RunnerWorkEnd | undefined>(() => undefined)
      : options.work(context)
  )
    .then((ended) => (ended ? ended.failure : ("worked" as const)))
    .catch((error: unknown) => {
      log(`the work failed: ${causeOf(error)}`);
      return "failed" as const;
    });

  const outcome = await Promise.race([beating, working]);
  if (outcome !== "stop" && outcome !== "lost") {
    // The work ended; the sidecar gets its last copy, then the plane is told
    // and the last beat goes out, with the work's failure when it gave one.
    const failure = typeof outcome === "object" ? outcome : undefined;
    if (failure !== undefined)
      log(`the work ended the dispatch: ${failure.code}: ${failure.message}`);
    await settle();
    heartbeat.report("stopped", failure);
    heartbeat.end();
    await beating;
    return outcome === "worked" ? 0 : 1;
  }
  if (outcome === "lost") {
    log("the control plane is lost; the lease will lapse and a replacement will come");
    await settle();
    return 3;
  }
  // Told to stop (cancelled, a ceiling, or superseded): the work is abandoned
  // where it stands, and the plane hears `stopped` from the runner itself so
  // the dispatch settles without waiting for the reconciler's lost lease.
  log(`stopping as told: the dispatch is ${heartbeat.last?.status ?? "unknown"}`);
  await settle();
  await heartbeat.farewell("stopped");
  return 0;
};
