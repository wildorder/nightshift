/**
 * Provisioning a dispatch (P10, D-P10-15, D-P10-18, D-P10-20): what the
 * dispatch Lambda does, as a function over ports so the offline suite drives
 * it with fakes and the Lambda with EC2.
 *
 * In order: refuse anything not `requested` or not a fresh `provisioning`
 * attempt; mint the engine's first token and park it in the parameter the
 * runner reads; find the image; pick a zone; launch the machine with its
 * workspace volume made from the project's warm snapshot, or empty; record what
 * was made. A failure after something was created terminates it and records
 * `failed` with the reason, so nothing runs that the record does not name.
 */
import {
  COMPUTE_TIERS,
  type ComputeArchitecture,
  type ComputeTier,
  type Dispatch,
  type Project,
  type ProjectId,
  type WarmCache,
} from "@nightshift/contracts";
import {
  architectureOf,
  type Clock,
  type ComputeControl,
  type FirstTokenStore,
  firstTokenParameterName,
  type InstanceDescription,
  type NightshiftStores,
  nowIso,
  type RunScope,
  transitionDispatch,
} from "@nightshift/core";
import { type ExecutionTokenSigner, mintEngineToken } from "../tokens/mint.js";

/** The tags a machine carries, as the runner reads them from its metadata (`RUNNER_TAGS`). */
export const machineTags = (
  dispatch: Dispatch,
  stage: string,
  apiEndpoint: string,
): Record<string, string> => ({
  "nightshift:managed": "true",
  "nightshift-project": dispatch.projectId,
  "nightshift-program": dispatch.programId,
  "nightshift-run": dispatch.runId,
  "nightshift-generation": String(dispatch.generation),
  "nightshift-stage": stage,
  "nightshift-api": apiEndpoint,
  Name: `nightshift-${stage}-${dispatch.runId}`,
});

/** The device the launch template and the runner agree on. */
export const WORKSPACE_DEVICE = "/dev/xvdf";

export interface ProvisionDeps {
  readonly stores: NightshiftStores;
  readonly compute: ComputeControl;
  readonly tokens: FirstTokenStore;
  readonly signer: ExecutionTokenSigner;
  readonly clock: Clock;
  readonly stage: string;
  readonly apiEndpoint: string;
  readonly issuer: string;
  readonly imageVersion: string;
  /** The runner VPC's public subnets, one per zone. */
  readonly subnetIds: readonly string[];
  /** Each subnet's zone (T6); absent, a replacement takes the hashed subnet and hopes. */
  readonly subnetZones?: Readonly<Record<string, string>>;
  /** How long to wait for EC2 to report the instance and its volume. */
  readonly describeAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type ProvisionOutcome =
  | { readonly kind: "provisioned"; readonly dispatch: Dispatch }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly dispatch: Dispatch; readonly reason: string };

/** A zone for the run: stable per run id, spread across the subnets. */
export const subnetFor = (runId: string, subnetIds: readonly string[]): string | undefined =>
  subnetsFor(runId, subnetIds)[0];

/**
 * Every subnet, in the order a first machine tries them: the run's hashed one
 * first, then the rest in turn. A first machine may go in any zone (its volume
 * is new, and a warm snapshot is regional), so a zone with no capacity for the
 * instance type is not the end of the launch.
 */
export const subnetsFor = (runId: string, subnetIds: readonly string[]): readonly string[] => {
  if (subnetIds.length === 0) return [];
  let hash = 0;
  for (const char of runId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const first = hash % subnetIds.length;
  return [...subnetIds.slice(first), ...subnetIds.slice(0, first)];
};

/** EC2's answer when a zone has no room for the instance type: another zone may. */
export const isCapacityRefusal = (error: unknown): boolean =>
  /InsufficientInstanceCapacity|do not have sufficient .* capacity/i.test(
    `${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`,
  );

/**
 * The snapshot a new volume starts from. A snapshot made on another image
 * version still holds the stores and the clone; only the image changed, so it
 * is reused.
 */
/**
 * How fast EBS pulls a warm snapshot down onto a new volume, in MiB/s: the
 * most it offers. Left lazy, a snapshot-backed volume fetches each block from
 * S3 on first read, and the runner's restore of the cache (hundreds of
 * thousands of small files) ran at 3–4 MB/s: a 7 GB cache took half an hour
 * (keki-backend, 2026-10-13). Charged per GB initialised.
 */
export const WARM_RESTORE_RATE_MIBPS = 300;

const warmSnapshotOf = (cache: WarmCache | undefined): string | undefined =>
  cache?.current.snapshotId;

/** What launching a machine needs of the deps: the ports and the runner stack's settings. */
export type LaunchCoreDeps = Pick<
  ProvisionDeps,
  "stores" | "compute" | "imageVersion" | "subnetIds" | "subnetZones" | "describeAttempts" | "sleep"
>;

export interface LaunchMachineInput {
  /** Names the dispatch in the log. */
  readonly label: string;
  readonly projectId: ProjectId;
  /** Chooses the first subnet: stable per run, or per line owner. */
  readonly hashKey: string;
  readonly architecture: ComputeArchitecture;
  readonly instanceType: string;
  readonly tier: ComputeTier;
  readonly tags: Readonly<Record<string, string>>;
  readonly workspace?:
    | { readonly iops?: number | undefined; readonly throughputMiBps?: number | undefined }
    | undefined;
  /** EC2's idempotency token: a retried launch under it returns the same instance. */
  readonly clientToken?: string;
  /** A replacement: the volume to attach, in its zone, instead of a new one. */
  readonly replacing?:
    | {
        readonly volumeId: string;
        readonly availabilityZone?: string | undefined;
      }
    | undefined;
  /** A resume's own snapshot, which a missing one makes a refusal rather than a cold start. */
  readonly retainedSnapshotId?: string | undefined;
  /** Runs once the image and subnet are settled and before launching: parks the first token. A string is a refusal. */
  readonly park: () => Promise<string | undefined>;
  /** Takes back what `park` made, when the launch does not happen. */
  readonly unpark: () => Promise<void>;
}

export type LaunchMachineResult =
  | {
      readonly ok: true;
      readonly instanceId: string;
      readonly description: InstanceDescription | undefined;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The launch core a run and the line share: the image, the subnet, the first
 * token (`park`), the warm snapshot, the launch itself, and the describes. A
 * failure after something was made terminates it (the instance) or takes it
 * back (`unpark`) and answers the reason.
 */
export const launchMachine = async (
  deps: LaunchCoreDeps,
  input: LaunchMachineInput,
): Promise<LaunchMachineResult> => {
  const { stores, compute } = deps;
  const { replacing, retainedSnapshotId: retained } = input;
  const fail = (reason: string): LaunchMachineResult => ({ ok: false, reason });
  const imageId = await compute.latestImage(deps.imageVersion, input.architecture);
  if (imageId === undefined) {
    return fail(`no available ${input.architecture} image for version ${deps.imageVersion}`);
  }
  // A replacement must land in its volume's zone (T6); a first machine goes
  // where the hash says.
  const inZone =
    replacing?.availabilityZone !== undefined && deps.subnetZones !== undefined
      ? deps.subnetIds.find((id) => deps.subnetZones?.[id] === replacing.availabilityZone)
      : undefined;
  // A replacement must use its volume's zone; a first machine may try them all.
  const subnets = inZone !== undefined ? [inZone] : subnetsFor(input.hashKey, deps.subnetIds);
  if (subnets.length === 0) return fail("the runner stack has no subnets");
  if (replacing !== undefined && inZone === undefined && replacing.availabilityZone !== undefined) {
    return fail(
      `no subnet in ${replacing.availabilityZone} for the replacement to attach the volume in`,
    );
  }

  const refused = await input.park();
  if (refused !== undefined) return fail(refused);

  const cache = await stores.warmCaches.get(input.projectId, input.architecture);
  if (retained !== undefined) {
    // The run's own snapshot is what a resume promises to continue from; one
    // that is gone is a refusal, not a cold start.
    const described = await compute.describeSnapshot(retained).catch(() => undefined);
    if (described === undefined || described.state === "error") {
      await input.unpark();
      return fail(`the run's retained snapshot ${retained} is gone; nothing to resume from`);
    }
  }
  let fromSnapshotId = replacing !== undefined ? undefined : (retained ?? warmSnapshotOf(cache));
  if (fromSnapshotId !== undefined && retained === undefined && cache !== undefined) {
    // The snapshot must still exist: one deleted behind the record's back (by
    // hand, 2026-10-06) failed every launch of the project until the record
    // was repaired. A missing one is a cold start, and the record goes.
    const described = await compute.describeSnapshot(fromSnapshotId).catch(() => undefined);
    if (described === undefined || described.state === "error") {
      console.warn(
        `${input.label}: warm snapshot ${fromSnapshotId} is gone; starting cold and forgetting the cache`,
      );
      await stores.warmCaches.delete(input.projectId, input.architecture);
      fromSnapshotId = undefined;
    }
  }
  const spec = COMPUTE_TIERS[input.tier];
  const launchIn = (subnetId: string) =>
    compute.launch({
      imageId,
      instanceType: input.instanceType,
      subnetId,
      tags: input.tags,
      ...(input.clientToken === undefined ? {} : { clientToken: input.clientToken }),
      ...(replacing !== undefined
        ? {}
        : {
            volume: {
              device: WORKSPACE_DEVICE,
              sizeGiB: spec.volumeGiB,
              ...(fromSnapshotId === undefined
                ? {}
                : { fromSnapshotId, initializationRateMiBps: WARM_RESTORE_RATE_MIBPS }),
              ...(input.workspace?.iops === undefined ? {} : { iops: input.workspace.iops }),
              ...(input.workspace?.throughputMiBps === undefined
                ? {}
                : { throughputMiBps: input.workspace.throughputMiBps }),
            },
          }),
    });
  let instanceId: string | undefined;
  const refusals: string[] = [];
  for (const subnetId of subnets) {
    try {
      ({ instanceId } = await launchIn(subnetId));
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isCapacityRefusal(error)) {
        await input.unpark();
        return fail(`launch failed: ${message}`);
      }
      refusals.push(`${deps.subnetZones?.[subnetId] ?? subnetId}: ${message}`);
    }
  }
  if (instanceId === undefined) {
    await input.unpark();
    return fail(`launch failed: no zone had capacity. ${refusals.join(" | ")}`);
  }

  // EC2 reports the zone at once and the volume once the instance is past
  // pending; a few describes, then the record is written with what is known.
  let description = await compute.describe(instanceId);
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const describeAttempts = deps.describeAttempts ?? 12;
  if (replacing !== undefined) {
    // The run's volume onto the new machine (T6): once the machine runs, and
    // once the old machine has let the volume go, which the terminate may still
    // be doing; so the attach is tried for as long as the describes are.
    const volumeId = replacing.volumeId;
    let attached = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < Math.max(describeAttempts, 24) && !attached; attempt += 1) {
      if (description?.state === "running") {
        try {
          await compute.attachVolume({ volumeId, instanceId, device: WORKSPACE_DEVICE });
          attached = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      await sleep(5_000);
      description = await compute.describe(instanceId);
    }
    if (!attached) {
      await compute.terminate(instanceId).catch(() => undefined);
      return fail(
        `could not attach ${volumeId} to the replacement ${instanceId}: ${lastError instanceof Error ? lastError.message : String(lastError ?? "the machine never ran")}`,
      );
    }
  }
  for (
    let attempt = 0;
    attempt < describeAttempts && description?.workspaceVolumeId === undefined;
    attempt += 1
  ) {
    await sleep(5_000);
    description = await compute.describe(instanceId);
  }
  return { ok: true, instanceId, description };
};

export const provisionDispatch = async (
  deps: ProvisionDeps,
  scope: RunScope,
): Promise<ProvisionOutcome> => {
  const { stores } = deps;
  const dispatch = await stores.dispatches.get(scope);
  if (dispatch === undefined) return { kind: "skipped", reason: "no dispatch for this run" };
  // A fresh attempt is `requested` (the first) or `provisioning` with no
  // machine yet (a replacement or a resume); anything else is already done.
  if (
    !(
      dispatch.status === "requested" ||
      (dispatch.status === "provisioning" && dispatch.instanceId === undefined)
    )
  ) {
    return { kind: "skipped", reason: `dispatch is ${dispatch.status} with a machine` };
  }
  const run = await stores.runs.get(scope, scope.runId);
  const program = await stores.programContracts.get(scope.projectId, scope.programId);
  const project: Project | undefined = await stores.projects.get(scope.projectId);
  if (run === undefined || program === undefined || project === undefined) {
    return { kind: "skipped", reason: "the run, program or project is missing" };
  }
  const at = nowIso(deps.clock);
  const fail = async (reason: string): Promise<ProvisionOutcome> => {
    const failed = transitionDispatch<Dispatch>(
      { ...dispatch, failure: { code: "provisioning_failed", message: reason } },
      "fail",
      nowIso(deps.clock),
    );
    await stores.dispatches.put(failed);
    return { kind: "failed", dispatch: failed, reason };
  };

  const architecture = architectureOf(dispatch.instanceType);
  // A resume after cleanup deleted the volume (D-P10-18) has no volume to land
  // beside: it gets a new one from the run's retained snapshot, in any zone,
  // like a first machine from the warm cache — not an attach of a volume that
  // is gone (2026-10-21).
  const retained =
    dispatch.cleanup.volumeDeleted && dispatch.volumeId !== undefined
      ? dispatch.cleanup.snapshotId
      : undefined;
  const replacing = dispatch.volumeId !== undefined && !dispatch.cleanup.volumeDeleted;
  const parameter = firstTokenParameterName(deps.stage, scope.runId, dispatch.generation);
  const launched = await launchMachine(deps, {
    label: `dispatch ${scope.runId}`,
    projectId: scope.projectId,
    hashKey: scope.runId,
    architecture,
    instanceType: dispatch.instanceType,
    tier: dispatch.tier,
    tags: machineTags(dispatch, deps.stage, deps.apiEndpoint),
    workspace: dispatch.workspace,
    replacing:
      replacing && dispatch.volumeId !== undefined
        ? { volumeId: dispatch.volumeId, availabilityZone: dispatch.availabilityZone }
        : undefined,
    retainedSnapshotId: retained,
    // The first token, parked before the machine exists so it is there when the
    // machine boots. Minted under this attempt's generation (D-P10-20).
    park: async () => {
      let token: string;
      try {
        token = (
          await mintEngineToken(deps.signer, {
            dispatch,
            run,
            program,
            issuer: deps.issuer,
            now: deps.clock.now(),
          })
        ).token;
      } catch (error) {
        return `could not mint the first token: ${error instanceof Error ? error.message : String(error)}`;
      }
      await deps.tokens.put(parameter, token);
      return undefined;
    },
    unpark: () => deps.tokens.delete(parameter).catch(() => undefined),
  });
  if (!launched.ok) return fail(launched.reason);
  const { instanceId, description } = launched;

  const attempts = dispatch.attempts.map((attempt) =>
    attempt.generation === dispatch.generation ? { ...attempt, instanceId } : attempt,
  );
  const withMachine: Dispatch = {
    ...dispatch,
    instanceId,
    ...(description?.availabilityZone === undefined
      ? {}
      : { availabilityZone: description.availabilityZone }),
    ...(description?.workspaceVolumeId === undefined
      ? {}
      : { volumeId: description.workspaceVolumeId }),
    amiVersion: deps.imageVersion,
    attempts,
    cleanup: { ...dispatch.cleanup, volumeDeleted: false },
  };
  // A first machine moves the record to `provisioning`; a replacement is
  // already there (T6) and only gains its machine.
  const provisioned =
    dispatch.status === "requested"
      ? transitionDispatch(withMachine, "provision", at)
      : { ...withMachine, updatedAt: at };
  await stores.dispatches.put(provisioned);
  return { kind: "provisioned", dispatch: provisioned };
};
