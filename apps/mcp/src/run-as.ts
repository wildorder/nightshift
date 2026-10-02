/**
 * The worker users on a machine (P10, D-P10-25).
 *
 * `engine` runs the engine; each job's agent runs as one of `worker-1` …
 * `worker-N`, which the image created, in the `nightshift` group with
 * `engine`. The users are handed out round-robin: N is at least the program's
 * concurrency ceiling, so two live jobs never share one, and a user is reused
 * only after its job is long gone. Granting a path means `chown` to the user,
 * which `engine` may do as root (the image's sudoers rule); signalling means
 * `kill` as the user, since `engine` may not signal another user's processes.
 * A credential a worker needs as a file (Codex's login) is a copy under
 * `<credentialRoot>/<user>/`, placed by the runner and named here by variable.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunAs } from "@nightshift/harness";

export const WORKER_GROUP = "nightshift";

export interface WorkerUsersOptions {
  readonly count: number;
  /** Where per-user credential directories live, by variable name: `<root>/<user>/<VAR>`. */
  readonly credentialRoot?: string;
  /** Injected by the tests; the real one runs `sudo`. */
  readonly exec?: (file: string, args: readonly string[]) => Promise<void>;
}

const sudo = (file: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("sudo", ["-n", file, ...args], (error, _stdout, stderr) => {
      if (error) reject(new Error(`sudo ${file} failed: ${stderr || error.message}`));
      else resolve();
    });
  });

/** The variables a worker's credential directory may name. */
const CREDENTIAL_DIRECTORY_VARIABLES = ["CODEX_HOME"] as const;

export const workerUserName = (index: number): string => `worker-${index + 1}`;

/** Which users exist, from the image's count: the environment says `NIGHTSHIFT_WORKER_USERS=16`. */
export const createWorkerUsers = (
  options: WorkerUsersOptions,
): ((agent: { readonly agentId: string; readonly role: string }) => RunAs | undefined) => {
  const run = options.exec ?? sudo;
  let next = 0;
  return () => {
    if (options.count <= 0) return undefined;
    const user = workerUserName(next % options.count);
    next += 1;
    const env: Record<string, string> = {};
    if (options.credentialRoot !== undefined) {
      for (const variable of CREDENTIAL_DIRECTORY_VARIABLES) {
        const directory = join(options.credentialRoot, user, variable);
        if (existsSync(directory)) env[variable] = directory;
      }
    }
    return {
      user,
      ...(Object.keys(env).length === 0 ? {} : { env }),
      grant: (path) => run("chown", ["-R", `${user}:${WORKER_GROUP}`, path]),
      kill: (pid, signal) => {
        // The process group as the user; errors here are a dead tree already.
        run("sudo", ["-u", user, "kill", `-${signal}`, "--", `-${pid}`]).catch(() => undefined);
      },
    };
  };
};
