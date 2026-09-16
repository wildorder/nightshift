import type { Scope } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  grantedPermissions,
  grantsPermission,
  isWorkerPermission,
  PERMISSION_FS_READ,
  PERMISSION_FS_WRITE,
  PERMISSION_SHELL_EXEC,
  unknownPermissions,
  WORKER_PERMISSIONS,
} from "./permissions.js";

const scopeWith = (permissions: readonly string[]): Scope => ({
  includes: ["src/**"],
  excludes: [],
  permissions: [...permissions],
  forbiddenActions: [],
});

describe("the worker permission vocabulary (D-P3-15)", () => {
  it("names exactly the three permissions v1 understands", () => {
    expect(WORKER_PERMISSIONS).toEqual([
      PERMISSION_FS_READ,
      PERMISSION_FS_WRITE,
      PERMISSION_SHELL_EXEC,
    ]);
  });

  it("carries no git write permission, because Nightshift owns every commit", () => {
    expect(WORKER_PERMISSIONS.some((permission) => permission.startsWith("git."))).toBe(false);
  });

  it("reports granted permissions in vocabulary order, not scope order", () => {
    const scope = scopeWith([PERMISSION_SHELL_EXEC, PERMISSION_FS_READ]);
    expect(grantedPermissions(scope)).toEqual([PERMISSION_FS_READ, PERMISSION_SHELL_EXEC]);
  });

  it("grants nothing from an empty permission list", () => {
    expect(grantedPermissions(scopeWith([]))).toEqual([]);
  });

  it("does not treat an unknown permission as an error, but never grants it", () => {
    const scope = scopeWith([PERMISSION_FS_READ, "aws.assume-role"]);
    expect(isWorkerPermission("aws.assume-role")).toBe(false);
    expect(grantedPermissions(scope)).toEqual([PERMISSION_FS_READ]);
    expect(unknownPermissions(scope)).toEqual(["aws.assume-role"]);
  });

  it("answers a single-permission question directly", () => {
    const scope = scopeWith([PERMISSION_FS_WRITE]);
    expect(grantsPermission(scope, PERMISSION_FS_WRITE)).toBe(true);
    expect(grantsPermission(scope, PERMISSION_SHELL_EXEC)).toBe(false);
  });
});
