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
  type Dispatch,
  type Project,
  type RunId,
  type WarmCache,
} from "@nightshift/contracts";
import {
  architectureOf,
  type Clock,
  type ComputeControl,
  type FirstTokenStore,
  firstTokenParameterName,
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
export const subnetFor = (runId: RunId, subnetIds: readonly string[]): string | undefined => {
  if (subnetIds.length === 0) return undefined;
  let hash = 0;
  for (const char of runId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return subnetIds[hash % subnetIds.length];
};

/**
 * The snapshot a new volume starts from. A snapshot made on another image
 * version still holds the stores and the clone; only the image changed, so it
 * is reused.
 */
const warmSnapshotOf = (cache: WarmCache | undefined): string | undefined =>
  cache?.current.snapshotId;

export const provisionDispatch = async (
  deps: ProvisionDeps,
  scope: RunScope,
): Promise<ProvisionOutcome> => {
  const { stores, compute } = deps;
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
    const failed = transitionDispatch(
      { ...dispatch, failure: { code: "provisioning_failed", message: reason } },
      "fail",
      nowIso(deps.clock),
    );
    await stores.dispatches.put(failed);
    return { kind: "failed", dispatch: failed, reason };
  };

  const architecture = architectureOf(dispatch.instanceType);
  const imageId = await compute.latestImage(deps.imageVersion, architecture);
  if (imageId === undefined) {
    return fail(`no available ${architecture} image for version ${deps.imageVersion}`);
  }
  // A replacement must land in its volume's zone (T6); a first machine goes where the hash says.
  const replacing = dispatch.volumeId !== undefined;
  const inZone =
    replacing && dispatch.availabilityZone !== undefined && deps.subnetZones !== undefined
      ? deps.subnetIds.find((id) => deps.subnetZones?.[id] === dispatch.availabilityZone)
      : undefined;
  const subnetId = inZone ?? subnetFor(scope.runId, deps.subnetIds);
  if (subnetId === undefined) return fail("the runner stack has no subnets");
  if (replacing && inZone === undefined && dispatch.availabilityZone !== undefined) {
    return fail(
      `no subnet in ${dispatch.availabilityZone} for the replacement to attach the volume in`,
    );
  }

  // The first token, parked before the machine exists so it is there when the
  // machine boots. Minted under this attempt's generation (D-P10-20).
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
    return fail(
      `could not mint the first token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parameter = firstTokenParameterName(deps.stage, scope.runId, dispatch.generation);
  await deps.tokens.put(parameter, token);

  const cache = await stores.warmCaches.get(scope.projectId, architecture);
  let fromSnapshotId = dispatch.volumeId === undefined ? warmSnapshotOf(cache) : undefined;
  if (fromSnapshotId !== undefined && cache !== undefined) {
    // The snapshot must still exist: one deleted behind the record's back (by
    // hand, 2026-10-06) failed every launch of the project until the record
    // was repaired. A missing one is a cold start, and the record goes.
    const described = await compute.describeSnapshot(fromSnapshotId).catch(() => undefined);
    if (described === undefined || described.state === "error") {
      console.warn(
        `dispatch ${scope.runId}: warm snapshot ${fromSnapshotId} is gone; starting cold and forgetting the cache`,
      );
      await stores.warmCaches.delete(scope.projectId, architecture);
      fromSnapshotId = undefined;
    }
  }
  const spec = COMPUTE_TIERS[dispatch.tier];
  let instanceId: string;
  try {
    ({ instanceId } = await compute.launch({
      imageId,
      instanceType: dispatch.instanceType,
      subnetId,
      tags: machineTags(dispatch, deps.stage, deps.apiEndpoint),
      ...(replacing
        ? {}
        : {
            volume: {
              device: WORKSPACE_DEVICE,
              sizeGiB: spec.volumeGiB,
              ...(fromSnapshotId === undefined ? {} : { fromSnapshotId }),
              ...(dispatch.workspace?.iops === undefined ? {} : { iops: dispatch.workspace.iops }),
              ...(dispatch.workspace?.throughputMiBps === undefined
                ? {}
                : { throughputMiBps: dispatch.workspace.throughputMiBps }),
            },
          }),
    }));
  } catch (error) {
    await deps.tokens.delete(parameter).catch(() => undefined);
    return fail(`launch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // EC2 reports the zone at once and the volume once the instance is past
  // pending; a few describes, then the record is written with what is known.
  let description = await compute.describe(instanceId);
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const describeAttempts = deps.describeAttempts ?? 12;
  if (replacing && dispatch.volumeId !== undefined) {
    // The run's volume onto the new machine (T6): once the machine runs, and
    // once the old machine has let the volume go, which the terminate may still
    // be doing; so the attach is tried for as long as the describes are.
    const volumeId = dispatch.volumeId;
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
