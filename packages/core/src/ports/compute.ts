/**
 * Ports for the remote runner's machines and secrets (P10, D-P10-15, D-P10-18,
 * D-P10-23).
 *
 * `core` says what the control plane needs from EC2, from a parameter store
 * and from a key, and nothing about any of them: `apps/api` implements them
 * over the AWS SDK, the local instance over a key file, and the fault battery
 * over fakes.
 */
import type { OrgId, Provider } from "@nightshift/contracts";

/** The ciphertext of one secret and the data key, wrapped, that encrypts it. */
export interface Sealed {
  readonly ciphertext: string;
  readonly wrappedKey: string;
}

/**
 * Envelope encryption under one key with the org and the provider as its
 * context (D-P10-23). A ciphertext moved to another org's row does not `open`.
 */
export interface Envelope {
  seal(orgId: OrgId, provider: Provider, plaintext: string): Promise<Sealed>;
  open(orgId: OrgId, provider: Provider, sealed: Sealed): Promise<string>;
}

/**
 * A machine and its workspace volume, launched together (D-P10-15, D-P10-18).
 * The volume is created at launch, from the project's warm snapshot or empty,
 * and is **not** deleted with the instance: it is the recovery point and the
 * next snapshot.
 */
export interface LaunchRequest {
  readonly imageId: string;
  readonly instanceType: string;
  readonly subnetId: string;
  /** Tags every resource carries, `nightshift:managed=true` among them. */
  readonly tags: Readonly<Record<string, string>>;
  readonly volume: {
    readonly device: string;
    readonly sizeGiB: number;
    readonly fromSnapshotId?: string;
  };
}

export interface InstanceDescription {
  readonly instanceId: string;
  readonly state: "pending" | "running" | "shutting-down" | "stopping" | "stopped" | "terminated";
  readonly availabilityZone?: string;
  /** The volume attached at the workspace device, once EC2 reports it. */
  readonly workspaceVolumeId?: string;
}

export interface SnapshotDescription {
  readonly snapshotId: string;
  readonly state: "pending" | "completed" | "error";
}

/**
 * What the dispatch Lambda and the reconciler do to machines, volumes and
 * snapshots (D-P10-18, D-P10-15). Every call is idempotent on its identifier
 * where the provider allows, and the fake in the fault battery is held to the
 * same shape.
 */
export interface ComputeControl {
  /** The newest available image carrying the version tag. */
  latestImage(imageVersion: string): Promise<string | undefined>;
  launch(request: LaunchRequest): Promise<{ readonly instanceId: string }>;
  describe(instanceId: string): Promise<InstanceDescription | undefined>;
  terminate(instanceId: string): Promise<void>;
  snapshot(input: {
    readonly volumeId: string;
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<{ readonly snapshotId: string }>;
  describeSnapshot(snapshotId: string): Promise<SnapshotDescription | undefined>;
  deleteVolume(volumeId: string): Promise<void>;
  deleteSnapshot(snapshotId: string): Promise<void>;
}

/**
 * Where a machine's first engine token waits for it (D-P10-20): a parameter
 * the runner reads once and deletes. The dispatch Lambda writes it before the
 * machine exists.
 */
export interface FirstTokenStore {
  put(name: string, token: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The SSM parameter a machine's first token waits in, as the runner stack and the runner spell it. */
export const firstTokenParameterName = (stage: string, runId: string, generation: number): string =>
  `/nightshift/${stage}/dispatch/${runId}/${generation}`;
