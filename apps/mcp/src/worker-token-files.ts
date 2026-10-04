/**
 * Where a worker's token file lives on a machine (P10, T4).
 *
 * `/dev/shm/nightshift/<runId>/agents/<agentId>/token`, beside the engine's own
 * token file (D-P10-20): tmpfs, never the volume or the local disk, gone with
 * the machine. The engine writes it, then hands the directory to the worker
 * user through the same `chown` that hands over its worktree, so the worker's
 * server can read it and nobody else can.
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunScope } from "@nightshift/core";
import type { ExecutionEnvironment, WorkerTokenFiles } from "@nightshift/execution";
import { tokenDirectory } from "./runner/root.js";

export const workerTokenDirectory = (runId: string, agentId: string): string =>
  join(tokenDirectory(runId), "agents", agentId);

export const workerTokenFile = (runId: string, agentId: string): string =>
  join(workerTokenDirectory(runId, agentId), "token");

export const createWorkerTokenFiles = (
  runAs: NonNullable<ExecutionEnvironment["runAs"]>,
): WorkerTokenFiles => ({
  place: async (scope: RunScope, agentId, token) => {
    const dir = workerTokenDirectory(scope.runId, agentId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Every directory on the way is traversable by the worker; only its own is
    // its own. The run's directory may predate this, made 0700 by an older
    // engine, so it is set here too. (The first live kill proof on T4 found a
    // worker unable to read its token for 45 minutes: this.)
    for (const parent of [
      tokenDirectory(scope.runId),
      join(tokenDirectory(scope.runId), "agents"),
    ]) {
      await chmod(parent, 0o711).catch(() => undefined);
    }
    const path = workerTokenFile(scope.runId, agentId);
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    // The worker's, and only the worker's: the pool gives the same user back
    // for the same agent, so a renewal lands in a directory it already owns.
    await runAs({ agentId, role: "worker" })?.grant(dir);
    return path;
  },
  remove: async (scope: RunScope, agentId) => {
    await rm(workerTokenDirectory(scope.runId, agentId), { recursive: true, force: true }).catch(
      () => undefined,
    );
  },
});
