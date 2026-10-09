/**
 * The environment allowlist is a security boundary, so these tests are written
 * as denials first: what must never reach a verification step.
 */
import { describe, expect, it } from "vitest";
import {
  POSIX_ENV_ALLOWLIST,
  PROJECT_ENV_ALLOWLIST,
  sanitizeEnvironment,
  WINDOWS_ENV_ALLOWLIST,
} from "./environment.js";

/** The shapes of secret that actually live in the Nightshift parent process. */
const SECRETS: Readonly<Record<string, string>> = {
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_SESSION_TOKEN: "session",
  NIGHTSHIFT_RUN_ID: "run_01",
  NIGHTSHIFT_ID_TOKEN: "id-token",
  NIGHTSHIFT_REFRESH_TOKEN: "refresh-token",
  GITHUB_TOKEN: "ghp_example",
  OPENAI_API_KEY: "sk-example",
  ANTHROPIC_API_KEY: "sk-ant-example",
};

describe("sanitizeEnvironment", () => {
  it("passes through only the platform allowlist", () => {
    const env = sanitizeEnvironment({
      platform: "linux",
      parentEnv: { PATH: "/usr/bin", HOME: "/home/tim", TZ: "UTC", ...SECRETS },
      extra: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/tim", TZ: "UTC" });
  });

  it("drops every credential-shaped variable on both platforms", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const env = sanitizeEnvironment({
        platform,
        parentEnv: { PATH: "/usr/bin", ...SECRETS },
        extra: undefined,
      });
      for (const name of Object.keys(SECRETS)) {
        expect(Object.keys(env), `${platform} leaked ${name}`).not.toContain(name);
      }
      // Without this the assertion above would pass on an empty environment.
      expect(env.PATH).toBe("/usr/bin");
    }
  });

  it("passes a machine's project environment through on POSIX: Docker, the stores, the pinned runtimes (P16 S-01)", () => {
    const project = {
      DOCKER_HOST: "unix:///run/user/1001/docker.sock",
      npm_config_cache: "/workspace/stores/npm",
      PNPM_HOME: "/workspace/stores/pnpm",
      npm_config_store_dir: "/workspace/stores/pnpm-store",
      CARGO_HOME: "/workspace/stores/cargo",
      RUSTUP_HOME: "/workspace/stores/runtimes/rustup",
      RUSTUP_TOOLCHAIN: "1.79.0",
      PIP_CACHE_DIR: "/workspace/stores/pip",
      UV_CACHE_DIR: "/workspace/stores/uv",
      PLAYWRIGHT_BROWSERS_PATH: "/workspace/stores/playwright",
      JAVA_HOME: "/workspace/stores/runtimes/installs/java/21.0.2",
    };
    const env = sanitizeEnvironment({
      platform: "linux",
      parentEnv: { PATH: "/usr/bin", ...project, ...SECRETS },
      extra: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", ...project });
    expect(Object.keys(project).sort()).toEqual([...PROJECT_ENV_ALLOWLIST].sort());
    for (const name of PROJECT_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
    }
  });

  it("never passes a variable through merely because its value looks harmless", () => {
    const env = sanitizeEnvironment({
      platform: "linux",
      parentEnv: { SOMETHING_NEW: "plain", PATH: "/usr/bin" },
      extra: undefined,
    });
    // An allowlist means a variable nobody has thought about is absent by
    // default. A denylist would have leaked this one.
    expect(env.SOMETHING_NEW).toBeUndefined();
  });

  it("omits an allowlisted name the parent does not set", () => {
    const env = sanitizeEnvironment({
      platform: "linux",
      parentEnv: { PATH: "/usr/bin" },
      extra: undefined,
    });
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  it("adds the caller's variables on top of the base", () => {
    const env = sanitizeEnvironment({
      platform: "linux",
      parentEnv: { PATH: "/usr/bin", HOME: "/home/tim" },
      extra: { CI: "1", PATH: "/opt/bin:/usr/bin" },
    });
    expect(env).toEqual({ PATH: "/opt/bin:/usr/bin", HOME: "/home/tim", CI: "1" });
  });

  it("matches case-insensitively on Windows and keeps the parent's spelling", () => {
    const env = sanitizeEnvironment({
      platform: "win32",
      parentEnv: { Path: "C:\\bin", SystemRoot: "C:\\Windows", aws_session_token: "session" },
      extra: undefined,
    });
    expect(env).toEqual({ Path: "C:\\bin", SystemRoot: "C:\\Windows" });
  });

  it("matches case-sensitively on POSIX, where names are case-sensitive", () => {
    const env = sanitizeEnvironment({
      platform: "linux",
      parentEnv: { Path: "/usr/bin", PATH: "/usr/bin" },
      extra: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("names PATH and HOME on every platform, and the shell's own needs on Windows", () => {
    for (const list of [POSIX_ENV_ALLOWLIST, WINDOWS_ENV_ALLOWLIST]) {
      expect(list).toContain("PATH");
      expect(list).toContain("HOME");
    }
    for (const name of ["SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "USERPROFILE", "windir"]) {
      expect(WINDOWS_ENV_ALLOWLIST).toContain(name);
    }
    for (const name of ["LANG", "TZ", "TMPDIR"]) {
      expect(POSIX_ENV_ALLOWLIST).toContain(name);
    }
  });

  it("allows nothing whose name looks like a credential", () => {
    // A guard on the lists themselves: adding `AWS_PROFILE` here one day should
    // fail this test rather than quietly widen the boundary.
    const suspicious = /token|secret|key|password|credential|^aws_|^nightshift_/i;
    for (const name of [...POSIX_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]) {
      expect(suspicious.test(name), `${name} is allowlisted`).toBe(false);
    }
  });
});
