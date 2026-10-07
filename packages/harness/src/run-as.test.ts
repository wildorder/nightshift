import { describe, expect, it } from "vitest";
import { commandAs, RUN_AS_SHELL_LINE, type RunAs, withTmpDir } from "./run-as.js";

const runAs: RunAs = {
  user: "worker-3",
  grant: async () => undefined,
  env: { CODEX_HOME: "/dev/shm/x" },
};

describe("commandAs (D-P10-25)", () => {
  it("leaves the command alone with no user to run as", () => {
    expect(
      commandAs(undefined, "claude", ["-p"], { PATH: "/usr/bin", HOME: "/home/engine" }),
    ).toEqual({
      file: "claude",
      args: ["-p"],
      env: { PATH: "/usr/bin", HOME: "/home/engine" },
    });
  });

  it("wraps the command in sudo as the user, passes the environment explicitly, and drops the engine's account", () => {
    const command = commandAs(runAs, "claude", ["-p", "--model", "x"], {
      PATH: "/usr/bin",
      HOME: "/home/engine",
      USER: "engine",
      ANTHROPIC_API_KEY: "k",
    });
    expect(command.file).toBe("sudo");
    expect(command.args.slice(0, 4)).toEqual(["-n", "-u", "worker-3", "-H"]);
    expect(command.args).toContain("env");
    expect(command.args).toContain("ANTHROPIC_API_KEY=k");
    expect(command.args).toContain("PATH=/usr/bin");
    expect(command.args).toContain("CODEX_HOME=/dev/shm/x");
    expect(command.args.some((arg) => arg.startsWith("HOME="))).toBe(false);
    expect(command.args.some((arg) => arg.startsWith("USER="))).toBe(false);
    const shell = command.args.indexOf("sh");
    expect(command.args.slice(shell)).toEqual([
      "sh",
      "-c",
      RUN_AS_SHELL_LINE,
      "claude",
      "-p",
      "--model",
      "x",
    ]);
    // The spawned sudo itself gets only a PATH.
    expect(Object.keys(command.env)).toEqual(["PATH"]);
  });
});

describe("withTmpDir (P15)", () => {
  it("points every temp variable at the directory, replacing any spelling already there", () => {
    const env = withTmpDir(
      { PATH: "/bin", Temp: "C:\\Users\\x\\AppData", tmpdir: "/tmp" },
      "/w/node.tmp",
    );
    expect(env).toEqual({
      PATH: "/bin",
      TMPDIR: "/w/node.tmp",
      TEMP: "/w/node.tmp",
      TMP: "/w/node.tmp",
    });
  });

  it("leaves the environment as it is when there is no directory", () => {
    const env = { PATH: "/bin", TMPDIR: "/tmp" };
    expect(withTmpDir(env, undefined)).toBe(env);
  });
});
