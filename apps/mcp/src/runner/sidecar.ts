/**
 * The durability sidecar (P10, D-P10-27).
 *
 * Work happens on the instance's local NVMe, which is fast and dies with the
 * instance. The EBS volume D-P10-15 attaches is still the recovery point: the
 * runner copies the workspace onto it every so often and once more when it
 * stops, and a replacement instance (D-P10-18) or a warm start finds the copy
 * there and restores it onto its own NVMe before anything else runs. The copy
 * carries a marker so an empty or foreign volume is never mistaken for one.
 *
 * `rsync` runs through `sudo` so owners survive the copy: a worker's worktree
 * comes back as the worker's (D-P10-25), not as `engine`'s.
 */
import type { Machine } from "./machine.js";

export const SIDECAR_MARKER = ".nightshift-sidecar";

export class SidecarError extends Error {
  override readonly name = "SidecarError";
}

const rsync = async (machine: Machine, from: string, to: string): Promise<void> => {
  const copied = await machine.exec("sudo", [
    "rsync",
    "-aHAX",
    "--delete",
    "--numeric-ids",
    `--exclude=/${SIDECAR_MARKER}`,
    `${from}/`,
    `${to}/`,
  ]);
  // 24: files vanished while copying, which a live workspace does; the copy is whole otherwise.
  if (copied.exitCode !== 0 && copied.exitCode !== 24) {
    throw new SidecarError(`rsync ${from} -> ${to} failed (${copied.exitCode}): ${copied.stderr}`);
  }
};

/** True when the sidecar holds a copy to restore. */
export const sidecarHoldsCopy = async (machine: Machine, sidecar: string): Promise<boolean> =>
  (await machine.exec("test", ["-f", `${sidecar}/${SIDECAR_MARKER}`])).exitCode === 0;

/** The sidecar's copy onto the workspace, before the workspace is prepared. */
export const restoreFromSidecar = async (
  machine: Machine,
  sidecar: string,
  workspace: string,
): Promise<void> => rsync(machine, sidecar, workspace);

/** The workspace onto the sidecar, and the marker that says a copy is there. */
export const syncToSidecar = async (
  machine: Machine,
  workspace: string,
  sidecar: string,
): Promise<void> => {
  await rsync(machine, workspace, sidecar);
  const marked = await machine.exec("touch", [`${sidecar}/${SIDECAR_MARKER}`]);
  if (marked.exitCode !== 0) throw new SidecarError(`could not mark the sidecar: ${marked.stderr}`);
};

export interface SidecarSync {
  /** Stops the periodic copies and makes one last one. */
  stop(): Promise<void>;
}

/**
 * Copies every `intervalMs` until stopped, then once more. A failed copy is
 * logged and the next interval tries again; the final copy's failure is
 * logged too, since there is nothing left to do about it.
 */
export const startSidecarSync = (
  machine: Machine,
  options: {
    readonly workspace: string;
    readonly sidecar: string;
    readonly intervalMs: number;
    readonly log: (line: string) => void;
  },
): SidecarSync => {
  let stopping = false;
  let wake: (() => void) | undefined;
  const copy = async (what: string) => {
    try {
      await syncToSidecar(machine, options.workspace, options.sidecar);
    } catch (error) {
      options.log(
        `sidecar: the ${what} copy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const loop = (async () => {
    while (!stopping) {
      await Promise.race([
        machine.sleep(options.intervalMs),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
      if (stopping) break;
      await copy("periodic");
    }
  })();
  return {
    stop: async () => {
      stopping = true;
      wake?.();
      await loop;
      await copy("final");
    },
  };
};
