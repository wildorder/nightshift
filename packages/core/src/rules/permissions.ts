/**
 * The worker permission vocabulary (D-P3-15).
 *
 * `Scope.permissions` is an open list of strings in `contracts`, because a scope
 * may one day carry an assumable role (A-25) or something else nobody has
 * written yet. These three constants are the subset Nightshift itself
 * understands in v1, and a harness adapter maps them to its own tool policy.
 *
 * Two properties are deliberate:
 *
 * - **An unknown permission is not an error here.** The contract allows any
 *   string, and `core` refuses to narrow what the contract permits. It is the
 *   adapter's job to treat anything it does not recognise as *not granted*,
 *   which is the safe direction: an unrecognised permission grants nothing.
 * - **Git write access is not in the vocabulary at all.** Nightshift owns every
 *   commit (A-29), so there is no permission a worker could hold that would let
 *   it write a ref. Absence is the enforcement.
 */
import type { Scope } from "@nightshift/contracts";

/** Read files inside the effective scope. */
export const PERMISSION_FS_READ = "fs.read";

/** Create, edit and delete files inside the effective scope. */
export const PERMISSION_FS_WRITE = "fs.write";

/** Run shell commands. Never a filesystem sandbox: see the P3 contract §3. */
export const PERMISSION_SHELL_EXEC = "shell.exec";

/** Every permission Nightshift v1 understands, in a stable order. */
export const WORKER_PERMISSIONS = [
  PERMISSION_FS_READ,
  PERMISSION_FS_WRITE,
  PERMISSION_SHELL_EXEC,
] as const;

export type WorkerPermission = (typeof WORKER_PERMISSIONS)[number];

/** Whether `value` is one of the permissions Nightshift understands. */
export const isWorkerPermission = (value: string): value is WorkerPermission =>
  (WORKER_PERMISSIONS as readonly string[]).includes(value);

/**
 * Which of the known permissions `scope` grants, in {@link WORKER_PERMISSIONS}
 * order. Permissions the vocabulary does not name are reported by
 * {@link unknownPermissions} rather than silently dropped.
 */
export const grantedPermissions = (scope: Scope): readonly WorkerPermission[] =>
  WORKER_PERMISSIONS.filter((permission) => scope.permissions.includes(permission));

/** Permissions on `scope` that this vocabulary does not name. An adapter grants none of them. */
export const unknownPermissions = (scope: Scope): readonly string[] =>
  scope.permissions.filter((permission) => !isWorkerPermission(permission));

/** Whether `scope` grants exactly `permission`. */
export const grantsPermission = (scope: Scope, permission: WorkerPermission): boolean =>
  scope.permissions.includes(permission);
