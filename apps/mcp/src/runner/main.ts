/**
 * The runner on a run's machine (P10, T2, T3): boot, bootstrap, heartbeat,
 * workspace, and then the work.
 *
 * Order: who am I (tags), my first token (SSM), the heartbeat started so the
 * plane knows the machine is up and hands back the clone's credential, the
 * volume mounted, the checkout prepared or recovered, `ready` reported, and then
 * whatever work T4 supplies (the headless root) until it ends or the plane
 * says stop.
 *
 * A machine that cannot establish its identity, mount or checkout says
 * so: its last heartbeat is `stopped` with `setup_failed` and the cause, and
 * the dispatch ends `failed` instead of waiting for the reconciler
 * to give up on the lease. Project setup failures are handled by the live
 * orchestrator instead. The work can end the dispatch with a
 * failure of its own (`environment_fault`, D-07).
 */
import type {
  Dispatch,
  HeartbeatBody,
  ProgramContract,
  RunnerFailure,
} from "@nightshift/contracts";
import { orchestratingDetail, type RunScope } from "@nightshift/core";
import { WORKER_GROUP } from "../run-as.js";
import {
  bootstrapEngineToken,
  isLineIdentity,
  type LineIdentity,
  machineKeyOf,
  type RunnerIdentity,
  readIdentity,
} from "./bootstrap.js";
import { createHeartbeat, type Heartbeat } from "./heartbeat.js";
import type { Machine } from "./machine.js";
import type {
  EngineTokens,
  LinePlaneFactory,
  LineRunnerPlane,
  PlaneFactory,
  RunnerPlane,
} from "./plane.js";
import { ProjectSetupStatusSchema } from "./project-setup.js";
import { recoverLocalWorkspace } from "./recovery.js";
import { createSampler } from "./sampler.js";
import { type SidecarSync, startSidecarSync } from "./sidecar.js";
import { findLocalDisk, mountWorkspace } from "./volume.js";
import { layoutOf, prepareCheckout, type WorkspaceLayout } from "./workspace.js";

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
  /** How often, while the root runs, the run's record is read to say where the work stands; the default is a minute. */
  readonly progressIntervalMs?: number;
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
  readonly readCachedToken?: (scope: RunScope) => Promise<string | undefined>;
  /** How long to wait for the plane to hand over the clone's credential. */
  readonly credentialTimeoutMs?: number;
  /** The runner's own PATH, kept in the project environment after the runtimes and the image's. */
  readonly inheritedPath?: string;
  /** The user project code runs as (D-P10-30); absent, the setup runs as this process. */
  readonly projectUser?: string;
  /** The line owner's plane, for a machine tagged as a line's (Pipkin M1b, S-04). */
  readonly linePlane?: LinePlaneFactory;
  /** What a line owner does between `ready` and the stop: `runLineOwner`. Absent, it waits. */
  readonly lineWork?: (context: LineRunnerContext) => Promise<RunnerWorkEnd | undefined>;
  /** Told the line owner's every engine token, first and renewed. */
  readonly onLineToken?: (token: string, identity: LineIdentity) => Promise<void>;
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

/** What a line owner's work is given (Pipkin M1b, S-04): the run context's counterpart, with the line's plane. */
export interface LineRunnerContext {
  readonly identity: LineIdentity;
  readonly plane: LineRunnerPlane;
  readonly heartbeat: Heartbeat;
  readonly machine: Machine;
  readonly layout: WorkspaceLayout;
  readonly log: (line: string) => void;
  /** Where the workspace is mounted. */
  readonly workspace: string;
  /** The user project code runs as (D-P10-30); absent, as this process. */
  readonly projectUser?: string;
  /** The runner's own PATH, kept in the project environment after the runtimes and the image's. */
  readonly inheritedPath?: string;
  /** How long to wait for the plane to hand over the credentials. */
  readonly credentialTimeoutMs?: number;
}

/**
 * What differs between a run's machine and a line owner's, and nothing else:
 * boot, the heartbeat, token renewal, the volume and the sidecar, and the
 * report of a setup that failed are shared (`runRunner`).
 */
interface Mode {
  readonly key: string;
  readonly identity: RunnerIdentity | LineIdentity;
  readonly onToken: ((token: string) => Promise<void>) | undefined;
  readonly readCachedToken: (() => Promise<string | undefined>) | undefined;
  /** Binds the mode's plane to the machine's token. */
  connect(tokens: EngineTokens): ModePlane;
}

interface ModePlane {
  postHeartbeat(body: HeartbeatBody): Promise<unknown>;
  /** The epoch milliseconds this generation's attempt started, when the record says. */
  startedAt(): Promise<number | undefined>;
  /** The disk the record asks for. */
  askedDisk(): Promise<string | undefined>;
  /** The file the project setup writes its status to, when this mode has setup. */
  readonly setupStatusFile?: string;
  /** After the mount: makes the checkout usable and answers how to start the work. */
  prepare(shared: {
    readonly heartbeat: Heartbeat;
    readonly layout: WorkspaceLayout;
  }): Promise<Started>;
}

interface Started {
  start(): {
    readonly working: Promise<RunnerWorkEnd | undefined>;
    readonly stopWatching: () => void;
  };
}

/** A token the heartbeat replaces (D-P10-20); never on the volume. */
const renewableToken = (
  initial: string,
  onToken: ((token: string) => Promise<void>) | undefined,
) => {
  let current = initial;
  let saving = Promise.resolve();
  const provider: EngineTokens = { idToken: async () => current };
  return {
    provider,
    install: (token: string) => {
      current = token;
      saving = saving.then(() => onToken?.(token)).catch(() => undefined);
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
export const awaitGithubToken = async (
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

/** A run's machine: its dispatch, program and plan, the headless root as the work. */
const runMode = (options: RunnerOptions, identity: RunnerIdentity): Mode => {
  const { machine, log } = options;
  return {
    key: identity.scope.runId,
    identity,
    onToken:
      options.onToken === undefined
        ? undefined
        : (renewed) =>
            (options.onToken as NonNullable<typeof options.onToken>)(renewed, identity.scope),
    readCachedToken:
      options.readCachedToken === undefined
        ? undefined
        : () =>
            (options.readCachedToken as NonNullable<typeof options.readCachedToken>)(
              identity.scope,
            ),
    connect: (tokens) => {
      const plane = options.plane(identity.apiEndpoint, tokens);
      return {
        postHeartbeat: (body) => plane.heartbeat(identity.scope, body),
        startedAt: async () => {
          const attempt = (await plane.dispatch(identity.scope))?.attempts.find(
            (entry) => entry.generation === identity.generation,
          );
          return attempt === undefined ? undefined : Date.parse(attempt.startedAt);
        },
        askedDisk: async () => (await plane.dispatch(identity.scope))?.workspace?.disk,
        setupStatusFile: `${options.workspace}/runs/${identity.scope.runId}/project-setup.json`,
        prepare: async ({ heartbeat, layout }) => {
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
          const prepared = await prepareCheckout(machine, {
            layout,
            dispatch,
            program,
            planText: planDocument.text,
            githubToken: () =>
              awaitGithubToken(heartbeat, machine, options.credentialTimeoutMs ?? 2 * 60_000),
            log,
            onProgress: (progress) => heartbeat.progress(progress),
            ...(options.inheritedPath === undefined
              ? {}
              : { inheritedPath: options.inheritedPath }),
            ...(options.projectUser === undefined ? {} : { projectUser: options.projectUser }),
          });
          log(
            `workspace ${prepared.warm ? "warm" : "cold"}: checkout ready; project setup belongs to the orchestrator`,
          );
          const context: RunnerContext = {
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
          return {
            start: () => {
              // With no work yet (T3), the runner's job is to stay: it heartbeats until
              // the plane says stop, and a promise that never settles is what "no work"
              // means to the race in `runRunner`.
              // A stage of its own once the work (the root) starts, so the record stops
              // showing the last boot step for the whole run (2026-10-13).
              if (options.work !== undefined) {
                heartbeat.progress({
                  stage: "orchestrating",
                  detail: "the root orchestrator is starting",
                });
              }
              // And then, for as long as the root runs, where the work stands by the
              // record (2026-10-21): the engine writes the nodes, the runner reads them.
              const watching =
                options.work === undefined
                  ? undefined
                  : watchOrchestration(context, {
                      intervalMs: options.progressIntervalMs ?? 60_000,
                      log,
                    });
              const working = (
                options.work === undefined
                  ? new Promise<RunnerWorkEnd | undefined>(() => undefined)
                  : options.work(context)
              )
                // The work's last word is the last word: nothing is read of the record once it has ended.
                .finally(() => watching?.stop());
              return { working, stopWatching: () => watching?.stop() };
            },
          };
        },
      };
    },
  };
};

/** A line owner's machine: the line's view, and `lineWork` (`runLineOwner`) as the work. */
const lineMode = (options: RunnerOptions, identity: LineIdentity): Mode => {
  const { machine, log } = options;
  const linePlane = options.linePlane;
  if (linePlane === undefined) {
    throw new Error("this machine is a line owner's, and the runner was given no line plane");
  }
  const onLineToken = options.onLineToken;
  return {
    key: machineKeyOf(identity),
    identity,
    onToken: onLineToken === undefined ? undefined : (renewed) => onLineToken(renewed, identity),
    readCachedToken: undefined,
    connect: (tokens) => {
      const plane = linePlane(identity.apiEndpoint, tokens, {
        projectId: identity.projectId,
        branch: identity.branch,
        scope: identity.scope,
        generation: identity.generation,
      });
      return {
        postHeartbeat: (body) => plane.heartbeat(body),
        startedAt: async () => {
          const attempt = (await plane.dispatch())?.attempts.find(
            (entry) => entry.generation === identity.generation,
          );
          return attempt === undefined ? undefined : Date.parse(attempt.startedAt);
        },
        askedDisk: async () => (await plane.dispatch())?.workspace?.disk,
        prepare: async ({ heartbeat, layout }) => {
          // The mirror and the checkout are the owner's to keep (`runLineOwner`),
          // once the read token has come; the machine's directory is made now.
          await machine.exec("mkdir", ["-p", layout.stores, layout.run, `${layout.run}/worktrees`]);
          const context: LineRunnerContext = {
            identity,
            plane,
            heartbeat,
            machine,
            layout,
            log,
            workspace: options.workspace,
            ...(options.projectUser === undefined ? {} : { projectUser: options.projectUser }),
            ...(options.inheritedPath === undefined
              ? {}
              : { inheritedPath: options.inheritedPath }),
            ...(options.credentialTimeoutMs === undefined
              ? {}
              : { credentialTimeoutMs: options.credentialTimeoutMs }),
          };
          return {
            start: () => {
              heartbeat.progress({ stage: "orchestrating", detail: "the line owner is starting" });
              const working =
                options.lineWork === undefined
                  ? new Promise<RunnerWorkEnd | undefined>(() => undefined)
                  : options.lineWork(context);
              return { working, stopWatching: () => undefined };
            },
          };
        },
      };
    },
  };
};

export const runRunner = async (options: RunnerOptions): Promise<number> => {
  const { machine, log } = options;
  const identity = await readIdentity(machine);
  const mode = isLineIdentity(identity) ? lineMode(options, identity) : runMode(options, identity);
  log(
    isLineIdentity(identity)
      ? `line ${identity.branch} of ${identity.projectId}, generation ${identity.generation}, on ${identity.instanceId}`
      : `run ${identity.scope.runId}, generation ${identity.generation}, on ${identity.instanceId}`,
  );
  const onToken = mode.onToken;
  const readCachedToken = mode.readCachedToken;
  const token = renewableToken(
    await bootstrapEngineToken(machine, identity, {
      ...(readCachedToken === undefined ? {} : { readCachedToken }),
      ...(onToken === undefined ? {} : { installToken: onToken }),
    }),
    onToken,
  );
  await onToken?.(await token.provider.idToken());
  const plane = mode.connect(token.provider);
  const startedAt = await plane.startedAt();
  const sample = createSampler(machine, options.workspace).sample;
  let setupAttempt = 0;

  // Beating before the volume is mounted, so a mount that fails can still be
  // reported; the disk samples read the root's until the mount is there.
  const heartbeat = createHeartbeat({
    generation: identity.generation,
    post: (body) => plane.postHeartbeat(body),
    installToken: token.install,
    sample: async () => {
      const saved =
        plane.setupStatusFile === undefined
          ? undefined
          : await machine.readFile(plane.setupStatusFile);
      if (saved !== undefined) {
        try {
          const status = ProjectSetupStatusSchema.parse(JSON.parse(saved));
          if (
            status.state === "ready" &&
            status.prepared !== undefined &&
            status.attempt > setupAttempt
          ) {
            heartbeat.describeSetup(status.prepared.setupSeconds, status.prepared.lockfileHashes);
            setupAttempt = status.attempt;
          }
        } catch {
          /* A status write in progress is retried on the next sample. */
        }
      }
      return sample();
    },
    ...(startedAt === undefined ? {} : { startedAt }),
    sleep: machine.sleep,
    now: machine.now,
    log,
  });
  // The first beat says the machine is up (P16 S-03).
  heartbeat.progress({ stage: "up", detail: `on ${identity.instanceId}` });
  const beating = heartbeat.run();
  const first = await Promise.race([heartbeat.first(), beating]);
  if (typeof first === "string" || first.stop) {
    heartbeat.end();
    await beating;
    return first === "lost" ? 3 : 0;
  }

  let sync: SidecarSync | undefined;
  const settle = async () => {
    if (sync === undefined) return;
    const started = machine.now();
    await sync.stop();
    sync = undefined;
    log(`sidecar: final copy took ${((machine.now() - started) / 1000).toFixed(1)}s`);
  };

  // The workspace (T3): the volume mounted; what the run is, from the plane;
  // the clone's credential, from the heartbeat; then a usable checkout.
  // Runtime installation and project setup happen after the root starts.
  const layout = layoutOf(options.workspace, mode.key);
  let started: Started;
  try {
    // The workspace goes on the instance's local disk when it has one (D-P10-27),
    // with the volume mounted beside it as the sidecar; on the volume itself when
    // the record says so or the instance type has no local disk.
    heartbeat.progress({ stage: "workspace", detail: "mounting the volume" });
    const asked = await plane.askedDisk();
    const localDisk =
      asked === "volume" ? undefined : await findLocalDisk(machine, options.workspace);
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
      const recovered = await recoverLocalWorkspace(machine, {
        workspace: options.workspace,
        sidecar,
        identity,
      });
      log(`local workspace ${recovered}`);
      log(`workspace mounted at ${options.workspace} (local NVMe; sidecar at ${sidecar})`);
    } else {
      log(
        `workspace mounted at ${options.workspace} (volume${asked === "volume" ? ", as the record asks" : "; no local disk"})`,
      );
    }
    started = await plane.prepare({ heartbeat, layout });
    if (sidecar !== undefined) {
      sync = startSidecarSync(machine, {
        workspace: options.workspace,
        sidecar,
        intervalMs: options.sidecarIntervalMs ?? 60_000,
        log,
      });
    }
    heartbeat.report("ready");
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

  const { working: work, stopWatching } = started.start();
  const working = work
    .then((ended) => (ended ? ended.failure : ("worked" as const)))
    .catch((error: unknown) => {
      const cause = causeOf(error);
      log(`the work failed: ${cause}`);
      return { failed: cause };
    });

  const outcome = await Promise.race([beating, working]);
  stopWatching();
  if (typeof outcome === "object" && "failed" in outcome) {
    // A process crash is not a request to finish the dispatch: its durable run
    // stays alive for systemd's restart (or a lease-based replacement). But a
    // work that fails every time it starts is not a crash, it is a machine
    // that cannot run this work (2026-10-21): the cause goes to the plane as
    // the stage's detail, so `remote status` says it, and the third failure in
    // a row ends the dispatch `failed` with it — rather than a restart every
    // five seconds, each one heartbeating `running`, for as long as the wall
    // clock allows. P20's first run spent thirteen hours that way.
    const failures = await countWorkFailure(machine, layout, outcome.failed);
    const detail = `the work failed (${failures} of ${MAX_WORK_FAILURES} in a row): ${outcome.failed}`;
    heartbeat.progress({ stage: "orchestrating", detail: detail.slice(0, 500) });
    await settle();
    if (failures >= MAX_WORK_FAILURES) {
      heartbeat.end();
      await beating;
      await heartbeat.farewell("stopped", {
        code: "setup_failed",
        message:
          `the work failed ${failures} times in a row on this machine: ${outcome.failed}`.slice(
            0,
            500,
          ),
      });
      return 1;
    }
    heartbeat.end();
    await beating;
    return 1;
  }
  // The work ended some other way: a run of failed starts is over.
  await clearWorkFailures(machine, layout);
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

/**
 * Says where the work stands while the root runs (2026-10-21): every
 * `intervalMs`, the run's nodes and jobs are read from the plane and summed up
 * as the `orchestrating` stage's detail, given to the heartbeat only when it
 * changed. A read that fails is logged and tried again next time; the work is
 * never the worse for it. `stop` ends the watch; a read under way finishes.
 */
export const watchOrchestration = (
  context: Pick<RunnerContext, "scope" | "plane" | "heartbeat" | "machine">,
  options: { readonly intervalMs: number; readonly log: (line: string) => void },
): { readonly stop: () => void } => {
  let stopped = false;
  let said: string | undefined;
  void (async () => {
    while (!stopped) {
      await context.machine.sleep(options.intervalMs);
      if (stopped) return;
      try {
        const [nodes, jobs] = await Promise.all([
          context.plane.nodes(context.scope),
          context.plane.jobs(context.scope),
        ]);
        if (stopped) return;
        const detail = orchestratingDetail(nodes, jobs);
        if (detail === said) continue;
        said = detail;
        context.heartbeat.progress({ stage: "orchestrating", detail });
      } catch (error) {
        options.log(`could not read where the work stands: ${causeOf(error)}`);
      }
    }
  })();
  return {
    stop: () => {
      stopped = true;
    },
  };
};

/** How many times in a row the work may fail on one machine before the dispatch ends `failed`. */
export const MAX_WORK_FAILURES = 3;

/** Where the machine keeps the count: the run's directory on the volume, so it outlives the process and not the machine. */
export const workFailuresFile = (layout: Pick<WorkspaceLayout, "run">): string =>
  `${layout.run}/work-failures.json`;

/** One more failure of the work on this machine; answers how many in a row. */
const countWorkFailure = async (
  machine: Pick<Machine, "readFile" | "writeFile">,
  layout: Pick<WorkspaceLayout, "run">,
  cause: string,
): Promise<number> => {
  let count = 0;
  try {
    const text = await machine.readFile(workFailuresFile(layout));
    const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "count" in parsed) {
      const value = (parsed as { count: unknown }).count;
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) count = value;
    }
  } catch {
    // An unreadable count is no count.
  }
  count += 1;
  try {
    await machine.writeFile(
      workFailuresFile(layout),
      JSON.stringify({ count, cause: cause.slice(0, 500) }),
    );
  } catch {
    // Not writable: the next start counts from what it can read.
  }
  return count;
};

const clearWorkFailures = async (
  machine: Pick<Machine, "readFile" | "writeFile">,
  layout: Pick<WorkspaceLayout, "run">,
): Promise<void> => {
  try {
    if ((await machine.readFile(workFailuresFile(layout))) !== undefined)
      await machine.writeFile(workFailuresFile(layout), JSON.stringify({ count: 0 }));
  } catch {
    // Nothing to clear, or nowhere to write it.
  }
};
