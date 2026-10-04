/**
 * The workspace volume (P10, D-P10-15): attached by the dispatch Lambda as a
 * block device, formatted on a project's first run, mounted at `/workspace`
 * and owned by `engine`. T3 fills it; T2 makes sure it is there.
 *
 * Every command runs through `sudo`, under the exact rule the image lays down
 * for `engine` (mkfs, blkid, mount, chown, mkdir), and nothing else.
 */
import type { Machine } from "./machine.js";

export interface VolumeOptions {
  readonly device: string;
  readonly mountPoint: string;
  readonly owner: string;
  /** The group the workspace is shared with: the workers' (D-P10-25). */
  readonly group?: string;
  /** `local`: the instance's own NVMe instead of the volume at `device`. */
  readonly disk?: "volume" | "local";
}

/** The model string EC2 gives an instance-store NVMe controller. */
const INSTANCE_STORE_MODEL = "Instance Storage";

/** The instance's local NVMe disk if it has one: unmounted, named by EC2 as instance storage. */
export const findLocalDisk = async (machine: Machine): Promise<string | undefined> => {
  const listed = await machine.exec("lsblk", ["-dnpo", "NAME,TYPE,MOUNTPOINT,MODEL"]);
  if (listed.exitCode !== 0) throw new VolumeError(`lsblk failed: ${listed.stderr}`);
  const candidates = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name, type, ...rest] = line.split(/\s+/);
      return { name, type, rest: rest.join(" ") };
    })
    .filter(
      (disk) =>
        disk.type === "disk" &&
        disk.rest.includes(INSTANCE_STORE_MODEL) &&
        !disk.rest.startsWith("/"),
    )
    .map((disk) => disk.name)
    .filter((name): name is string => name !== undefined);
  return candidates[0];
};

/** The local disk, or the error that says the instance type has none. */
export const resolveLocalDisk = async (machine: Machine): Promise<string> => {
  const found = await findLocalDisk(machine);
  if (found === undefined) {
    throw new VolumeError("this instance type has no local NVMe disk to put the workspace on");
  }
  return found;
};

export class VolumeError extends Error {
  override readonly name = "VolumeError";
}

/** The device as the kernel names it: NVMe instances expose `/dev/xvdf` under another name. */
export const resolveDevice = async (machine: Machine, device: string): Promise<string> => {
  const direct = await machine.exec("test", ["-b", device]);
  if (direct.exitCode === 0) return device;
  // On Nitro, the attachment's device name is in the NVMe controller's vendor
  // data; `lsblk` lists the block devices, and the one with no filesystem and
  // no mount that is not the root disk is the workspace.
  // NAME and TYPE first, so an unmounted disk's blank MOUNTPOINT is simply absent.
  const listed = await machine.exec("lsblk", ["-dnpo", "NAME,TYPE,MOUNTPOINT"]);
  if (listed.exitCode !== 0) throw new VolumeError(`lsblk failed: ${listed.stderr}`);
  const candidates = listed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === "disk" && fields[2] === undefined)
    .map((fields) => fields[0])
    .filter((name): name is string => name !== undefined && !name.includes("nvme0"));
  const [candidate] = candidates;
  if (candidate === undefined || candidates.length !== 1) {
    throw new VolumeError(
      `could not find the workspace volume: ${device} is absent and lsblk shows ${candidates.length} unmounted disk(s)`,
    );
  }
  return candidate;
};

/** How long to wait for a volume still being attached: a replacement's arrives after the machine (T6). */
export const VOLUME_WAIT_MS = 3 * 60_000;

/** The volume's device, waiting for an attach still in flight. */
export const awaitDevice = async (machine: Machine, device: string): Promise<string> => {
  const deadline = machine.now() + VOLUME_WAIT_MS;
  for (;;) {
    try {
      return await resolveDevice(machine, device);
    } catch (error) {
      if (machine.now() >= deadline) throw error;
      await machine.sleep(5_000);
    }
  }
};

/** Mounts the workspace, formatting a fresh volume. Idempotent: a mounted workspace is left as it is. */
export const mountWorkspace = async (machine: Machine, options: VolumeOptions): Promise<void> => {
  const mounted = await machine.exec("findmnt", ["-rn", "-o", "SOURCE", options.mountPoint]);
  if (mounted.exitCode === 0 && mounted.stdout.trim().length > 0) return;
  const device =
    options.disk === "local"
      ? await resolveLocalDisk(machine)
      : await awaitDevice(machine, options.device);
  const probed = await machine.exec("sudo", ["blkid", "-o", "value", "-s", "TYPE", device]);
  if (probed.exitCode !== 0 || probed.stdout.trim() === "") {
    const formatted = await machine.exec("sudo", ["mkfs.ext4", "-q", "-L", "nightshift", device]);
    if (formatted.exitCode !== 0) {
      throw new VolumeError(`mkfs.ext4 ${device} failed: ${formatted.stderr}`);
    }
  }
  await machine.exec("sudo", ["mkdir", "-p", options.mountPoint]);
  const mount = await machine.exec("sudo", ["mount", "-o", "noatime", device, options.mountPoint]);
  if (mount.exitCode !== 0) throw new VolumeError(`mount ${device} failed: ${mount.stderr}`);
  // The engine's, in the workers' group, set-group-id so everything made under
  // it is the group's too (D-P10-25).
  const owned = await machine.exec("sudo", [
    "chown",
    `${options.owner}:${options.group ?? options.owner}`,
    options.mountPoint,
  ]);
  if (owned.exitCode !== 0)
    throw new VolumeError(`chown ${options.mountPoint} failed: ${owned.stderr}`);
  await machine.exec("chmod", ["2775", options.mountPoint]);
};
