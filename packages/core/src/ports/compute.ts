/**
 * Ports for the remote runner's machines and secrets (P10, D-P10-18, D-P10-23).
 *
 * `core` says what the control plane needs from EC2 and from a key, and nothing
 * about either: `apps/api` implements them over the AWS SDK, the local instance
 * over a key file, and the fault battery over fakes.
 */
import type { ComputeTier, OrgId, Provider } from "@nightshift/contracts";

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

export interface LaunchRequest {
  readonly tier: ComputeTier;
  readonly instanceType: string;
  readonly availabilityZone: string;
  readonly volumeId: string;
  readonly amiVersion: string;
  /** Tags every resource carries, `nightshift:managed=true` among them. */
  readonly tags: Readonly<Record<string, string>>;
  /** What the machine reads at boot: the dispatch's chain and where its first token is. */
  readonly userData: Readonly<Record<string, string>>;
}

export interface InstanceDescription {
  readonly instanceId: string;
  readonly state: "pending" | "running" | "stopping" | "stopped" | "terminated" | "unknown";
}

/**
 * What the dispatch Lambda and the reconciler do to machines and volumes
 * (D-P10-18, D-P10-15). Every call is idempotent on its identifier where the
 * provider allows, and the fake in the fault battery is held to the same shape.
 */
export interface ComputeControl {
  createVolume(input: {
    readonly sizeGiB: number;
    readonly availabilityZone: string;
    readonly fromSnapshotId?: string;
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<{ readonly volumeId: string }>;
  launch(request: LaunchRequest): Promise<{ readonly instanceId: string }>;
  describe(instanceId: string): Promise<InstanceDescription>;
  terminate(instanceId: string): Promise<void>;
  snapshot(input: {
    readonly volumeId: string;
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<{ readonly snapshotId: string }>;
  deleteVolume(volumeId: string): Promise<void>;
  deleteSnapshot(snapshotId: string): Promise<void>;
}
