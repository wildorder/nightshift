/**
 * Where a worker's token file lives on a machine (P10, T4).
 *
 * `/dev/shm/nightshift/<runId>/agents/<agentId>/token`, beside the engine's own
 * token file (D-P10-20): tmpfs, never the volume or the local disk, gone with
 * the machine. The file is the engine's, since the engine writes it first and
 * rewrites it at every renewal (worker-tokens.ts); the worker's server reads
 * it through the group the two share (D-P10-25), and nobody else can. It used
 * to be handed to the worker by `chown`, which left the engine unable to enter
 * its own directory: every renewal then failed with EACCES, a minute apart,
 * until the first token expired under a long job.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunScope } from "@nightshift/core";
import type { WorkerTokenFiles } from "@nightshift/execution";
import { WORKER_GROUP } from "./run-as.js";
import { tokenDirectory } from "./runner/root.js";

export const workerTokenDirectory = (
  runId: string,
  agentId: string,
  directory: (runId: string) => string = tokenDirectory,
): string => join(directory(runId), "agents", agentId);

export const workerTokenFile = (
  runId: string,
  agentId: string,
  directory: (runId: string) => string = tokenDirectory,
): string => join(workerTokenDirectory(runId, agentId, directory), "token");

export interface WorkerTokenFileOptions {
  /** The group the worker reads through; the image's is {@link WORKER_GROUP}. */
  readonly group?: string;
  /** `chgrp <group> <path>`, as this process; injected by the tests. */
  readonly chgrp?: (group: string, path: string) => Promise<void>;
  /** The run's token directory; the machine's is `/dev/shm`'s (root.ts). Injected by the tests. */
  readonly tokenDirectory?: (runId: string) => string;
}

const chgrp = (group: string, path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("chgrp", [group, path], (error, _stdout, stderr) => {
      if (error) reject(new Error(`chgrp ${group} ${path} failed: ${stderr || error.message}`));
      else resolve();
    });
  });

export const createWorkerTokenFiles = (options: WorkerTokenFileOptions = {}): WorkerTokenFiles => {
  const group = options.group ?? WORKER_GROUP;
  const setGroup = options.chgrp ?? chgrp;
  const directory = options.tokenDirectory ?? tokenDirectory;
  return {
    place: async (scope: RunScope, agentId, token) => {
      const agents = join(directory(scope.runId), "agents");
      const dir = workerTokenDirectory(scope.runId, agentId, directory);
      // The run's directory is traversable by everyone on the way down, and
      // not listable (root.ts). The agents' directory and the worker's own are
      // the group's, and set-group-id so the token file made in the worker's
      // takes the group too, whatever this process's own group is: the worker
      // may enter its directory and read its file, and only the engine may
      // write. Each is given the group itself, not left to inherit it: a
      // directory made before its parent became the group's keeps the
      // engine's own group, and then nobody but the engine can enter it
      // (2026-10-17, admin-redesign: every agent's token read failed EACCES).
      await mkdir(agents, { recursive: true });
      await chmod(directory(scope.runId), 0o711).catch(() => undefined);
      await setGroup(group, agents);
      await chmod(agents, 0o2711);
      await mkdir(dir, { recursive: true });
      await setGroup(group, dir);
      await chmod(dir, 0o2710);
      // Whole or absent, never half-written under a reader: the renewal lands
      // beside the old token and takes its place in one step.
      const path = workerTokenFile(scope.runId, agentId, directory);
      const next = `${path}.next`;
      await writeFile(next, `${token}\n`, { mode: 0o640 });
      await chmod(next, 0o640);
      await rename(next, path);
      return path;
    },
    remove: async (scope: RunScope, agentId) => {
      await rm(workerTokenDirectory(scope.runId, agentId, directory), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    },
  };
};
