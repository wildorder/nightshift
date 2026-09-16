/**
 * The two platform-specific decisions, tested on both legs from either
 * platform. CI runs ubuntu and windows, but a Windows tree-kill bug should be
 * a failing test on a developer's Mac too, which is why `platform` is a
 * parameter rather than read from `process`.
 */
import { describe, expect, it } from "vitest";
import type { SpawnedChild, SpawnLike, SpawnLikeOptions } from "./spawn.js";
import { killProcessTree, shellInvocation } from "./spawn.js";

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnLikeOptions;
}

const stubChild = (): SpawnedChild => ({
  pid: 1,
  stdout: { on: () => {} },
  stderr: { on: () => {} },
  on: () => {},
  kill: () => true,
});

const recordingSpawn = (): { calls: SpawnCall[]; spawn: SpawnLike } => {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return stubChild();
    },
  };
};

const killRecorder = (): {
  killed: (NodeJS.Signals | number | undefined)[];
  child: SpawnedChild;
} => {
  const killed: (NodeJS.Signals | number | undefined)[] = [];
  const child: SpawnedChild = {
    ...stubChild(),
    kill: (signal?: NodeJS.Signals | number) => {
      killed.push(signal);
      return true;
    },
  };
  return { killed, child };
};

const ENV = Object.freeze({ PATH: "/usr/bin" });

describe("shellInvocation", () => {
  it("runs the command through sh -c on POSIX, as one argument", () => {
    expect(shellInvocation("linux", "npm test -- --reporter='dot'")).toEqual({
      file: "sh",
      args: ["-c", "npm test -- --reporter='dot'"],
    });
  });

  it("runs the command through cmd.exe /d /s /c on Windows, quoted as a whole", () => {
    // `/s` is what makes cmd strip only the outer pair of quotes, so the inner
    // ones survive to the command; `/d` keeps a machine's AutoRun registry
    // entry out of every verification step.
    expect(shellInvocation("win32", 'echo say "hi"')).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '"echo say "hi""'],
    });
  });
});

describe("killProcessTree", () => {
  it("signals the whole process group on POSIX, not just the child", () => {
    const signalled: [number, NodeJS.Signals][] = [];
    const { calls, spawn } = recordingSpawn();
    const { killed, child } = killRecorder();

    killProcessTree({
      pid: 4242,
      platform: "linux",
      child,
      cwd: "/repo",
      env: ENV,
      spawn,
      kill: (pid, signal) => {
        signalled.push([pid, signal]);
      },
    });

    // The negative pid is the point: the shell's children die with it.
    expect(signalled).toEqual([[-4242, "SIGKILL"]]);
    expect(calls).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("falls back to the direct child when the group signal fails", () => {
    const { spawn } = recordingSpawn();
    const { killed, child } = killRecorder();

    killProcessTree({
      pid: 4242,
      platform: "darwin",
      child,
      cwd: "/repo",
      env: ENV,
      spawn,
      kill: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    });

    expect(killed).toEqual(["SIGKILL"]);
  });

  it("walks the tree with taskkill on Windows", () => {
    const signalled: number[] = [];
    const { calls, spawn } = recordingSpawn();
    const { killed, child } = killRecorder();

    killProcessTree({
      pid: 900,
      platform: "win32",
      child,
      cwd: "C:\\repo",
      env: ENV,
      spawn,
      kill: (pid) => {
        signalled.push(pid);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("taskkill");
    expect(calls[0]?.args).toEqual(["/pid", "900", "/T", "/F"]);
    expect(calls[0]?.options.windowsHide).toBe(true);
    // Windows has no process groups to signal, and no shell to re-enter.
    expect(signalled).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("falls back to the direct child when taskkill cannot be spawned", () => {
    const { killed, child } = killRecorder();

    killProcessTree({
      pid: 900,
      platform: "win32",
      child,
      cwd: "C:\\repo",
      env: ENV,
      spawn: () => {
        throw new Error("EMFILE");
      },
      kill: () => {},
    });

    expect(killed).toEqual(["SIGKILL"]);
  });

  it("kills the direct child when there is no pid to walk from", () => {
    const { calls, spawn } = recordingSpawn();
    const { killed, child } = killRecorder();

    for (const pid of [undefined, 0, -1]) {
      killProcessTree({
        pid,
        platform: "linux",
        child,
        cwd: "/repo",
        env: ENV,
        spawn,
        kill: () => {},
      });
    }

    // A pid of 0 or -1 would signal this process or every process we own.
    expect(killed).toEqual(["SIGKILL", "SIGKILL", "SIGKILL"]);
    expect(calls).toEqual([]);
  });
});
