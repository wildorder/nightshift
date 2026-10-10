/**
 * The project user on a machine (P10, D-P10-30, amending D-P10-25).
 *
 * `engine` runs the engine and holds its token and the placed credentials;
 * all project code runs as the one `project` user the image created, in the
 * `nightshift` group with `engine`: the setup at boot, every checkout's
 * setup, the gates, and every job's agent. Jobs are collaborators, not
 * tenants: they already share the checkout, and as one user they share the
 * package stores the way a developer's machine does. (Sixteen `worker-N`
 * users could not: pnpm hard-links store files and then chmods them, and only
 * a file's owner may, so keki-backend's install failed on the machine with
 * EPERM, 2026-10-10.) Granting a path means `chown` to the project user,
 * which `engine` may do as root (the image's sudoers rule); signalling means
 * `kill` as the user, since `engine` may not signal another user's processes.
 * A credential the project user needs as a file (Codex's login) is a copy
 * under `<credentialRoot>/<VAR>`, placed by the runner and named here.
 *
 * Its environment is also the project's (P16 S-01): the pinned runtimes first
 * on PATH and the stores, from the runner's `project.env`. Its `DOCKER_HOST`
 * is the run-as wrapper's default, the user's own rootless socket under
 * `/run/user/<uid>` (`commandAs`).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunAs } from "@nightshift/harness";

export const WORKER_GROUP = "nightshift";

/** The one user project code runs as on a machine (D-P10-30). */
export const PROJECT_USER = "project";

export interface ProjectUserOptions {
  /** The user's name; the image's is {@link PROJECT_USER}. */
  readonly user: string;
  /** Where the user's credential directories live, by variable name: `<root>/<VAR>`. */
  readonly credentialRoot?: string;
  /** The project environment its processes run in (P16 S-01); absent on a laptop. */
  readonly projectEnv?: Readonly<Record<string, string>>;
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

/** The variables the project user's credential directory may name. */
const CREDENTIAL_DIRECTORY_VARIABLES = ["CODEX_HOME"] as const;

/** Every agent and every step runs as the same project user: one `RunAs`, whoever asks. */
export const createProjectUser = (
  options: ProjectUserOptions,
): ((agent: { readonly agentId: string; readonly role: string }) => RunAs) => {
  const run = options.exec ?? sudo;
  const { user } = options;
  const env: Record<string, string> = { ...(options.projectEnv ?? {}) };
  if (options.credentialRoot !== undefined) {
    for (const variable of CREDENTIAL_DIRECTORY_VARIABLES) {
      const directory = join(options.credentialRoot, variable);
      if (existsSync(directory)) env[variable] = directory;
    }
  }
  const runAs: RunAs = {
    user,
    ...(Object.keys(env).length === 0 ? {} : { env }),
    grant: (path) => run("chown", ["-R", `${user}:${WORKER_GROUP}`, path]),
    kill: (pid, signal) => {
      // The process group as the user; errors here are a dead tree already.
      run("sudo", ["-u", user, "kill", `-${signal}`, "--", `-${pid}`]).catch(() => undefined);
    },
  };
  return () => runAs;
};

/**
 * Takes a path back for the engine (D-P10-25): `chown -R` to the engine's own
 * user and the shared group, as root, which the image's sudoers rule allows.
 * The engine then removes what it granted whatever modes the agent left.
 */
export const createReclaim = (
  engineUser: string,
  exec: (file: string, args: readonly string[]) => Promise<void> = sudo,
): ((path: string) => Promise<void>) => {
  return async (path) => {
    if (!existsSync(path)) return;
    await exec("chown", ["-R", `${engineUser}:${WORKER_GROUP}`, path]);
  };
};
