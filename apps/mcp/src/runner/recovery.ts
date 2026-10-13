/** Same-machine NVMe survives a process restart; its older sidecar must not win. */
import type { RunnerIdentity } from "./bootstrap.js";
import type { Machine } from "./machine.js";
import { restoreFromSidecar, SIDECAR_MARKER, sidecarHoldsCopy } from "./sidecar.js";

export class WorkspaceRecoveryError extends Error {
  override readonly name = "WorkspaceRecoveryError";
}

const readRestoreState = (
  marked: string | undefined,
  owner: Readonly<Record<string, unknown>>,
  workspace: string,
): boolean => {
  if (marked === undefined) return false;
  try {
    const parsed = JSON.parse(marked) as Record<string, unknown>;
    if (
      parsed === null ||
      Object.entries(owner).some(([key, value]) => parsed[key] !== value) ||
      (parsed.state !== "ready" && parsed.state !== "restoring")
    ) {
      throw new Error("different owner");
    }
    return parsed.state === "restoring";
  } catch {
    throw new WorkspaceRecoveryError(
      `the local workspace at ${workspace} has an unreadable or different run/machine identity; ` +
        "preserving its data rather than overwriting it from the sidecar",
    );
  }
};

/**
 * On the local disk the already rsync-excluded marker records this machine's
 * ownership and a restore in progress. On the sidecar it retains its existing
 * meaning: a completed copy exists. Neither marker is ever copied to the other
 * disk. Keeping the in-progress marker through rsync makes a crashed restore
 * retryable without treating its partial output as newer surviving work.
 */
export const recoverLocalWorkspace = async (
  machine: Machine,
  options: {
    readonly workspace: string;
    readonly sidecar: string;
    readonly identity: RunnerIdentity;
  },
): Promise<"restored" | "preserved" | "empty"> => {
  const { workspace, sidecar, identity } = options;
  const marker = `${workspace}/${SIDECAR_MARKER}`;
  const owner = {
    schemaVersion: 1,
    ...identity.scope,
    instanceId: identity.instanceId,
    generation: identity.generation,
  };
  const mark = async (state: "ready" | "restoring"): Promise<void> => {
    const temporary = `${marker}.next`;
    await machine.writeFile(temporary, JSON.stringify({ ...owner, state }));
    const moved = await machine.exec("mv", ["-f", temporary, marker]);
    if (moved.exitCode !== 0) {
      throw new WorkspaceRecoveryError(`could not record local workspace recovery at ${workspace}`);
    }
  };
  const marked = await machine.readFile(marker);
  const restoring = readRestoreState(marked, owner, workspace);
  const listing = await machine.exec("find", [
    workspace,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "!",
    "-name",
    "lost+found",
    "!",
    "-name",
    SIDECAR_MARKER,
    "!",
    "-name",
    `${SIDECAR_MARKER}.next`,
    "-print",
    "-quit",
  ]);
  if (listing.exitCode !== 0) {
    throw new WorkspaceRecoveryError(`could not inspect the local workspace at ${workspace}`);
  }
  const populated = listing.stdout.trim() !== "";
  if (populated && !restoring) {
    if (
      marked === undefined &&
      (await machine.exec("test", ["-d", `${workspace}/runs/${identity.scope.runId}`])).exitCode !==
        0
    ) {
      throw new WorkspaceRecoveryError(
        `the nonempty local workspace at ${workspace} does not identify this run; preserving it`,
      );
    }
    await mark("ready");
    return "preserved";
  }
  if (!(await sidecarHoldsCopy(machine, sidecar))) {
    if (restoring) {
      throw new WorkspaceRecoveryError("the interrupted restore has no complete sidecar copy");
    }
    await mark("ready");
    return "empty";
  }
  await mark("restoring");
  await restoreFromSidecar(machine, sidecar, workspace, identity.scope.runId);
  await mark("ready");
  return "restored";
};
