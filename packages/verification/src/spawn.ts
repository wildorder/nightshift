/**
 * The process surface this package uses, and the two platform-specific things
 * it has to know: how to reach a shell, and how to kill a process tree.
 *
 * `SpawnLike` is deliberately the narrowest interface over `node:child_process`
 * `spawn` that the runner needs. Narrow, because a test fake has to be a few
 * lines: anything wider and tests start fabricating a `ChildProcess`, which is
 * how a runner ends up tested against a mock of Node rather than against its
 * own logic.
 */
import { spawn as spawnChildProcess } from "node:child_process";

/** One of a child's output pipes, as this package reads it. */
export interface ChildOutputStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
}

/** A spawned child, as this package observes it. */
export interface SpawnedChild {
  /** Absent when the spawn failed before the OS assigned a pid. */
  readonly pid?: number | undefined;
  readonly stdout: ChildOutputStream | null;
  readonly stderr: ChildOutputStream | null;
  /**
   * `close` rather than `exit`, because it fires once the pipes are drained.
   * Waiting for it is what makes captured output complete.
   */
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  /** The child never ran, or could not be signalled. */
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnLikeOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * POSIX only: makes the child a process-group leader so the group can be
   * signalled as a unit on timeout. See `killProcessTree`.
   */
  readonly detached: boolean;
  readonly windowsHide: boolean;
  /**
   * Always `false`. This package picks the shell itself, so that the command
   * line a step runs is stated in one readable place rather than assembled by
   * the runtime, and so a test can assert it.
   */
  readonly shell: false;
  /**
   * Windows only: `cmd.exe` does its own quoting, and Node's default argument
   * escaping would corrupt a command containing quotes before `cmd` ever saw
   * it.
   */
  readonly windowsVerbatimArguments: boolean;
}

export type SpawnLike = (
  file: string,
  args: readonly string[],
  options: SpawnLikeOptions,
) => SpawnedChild;

/** The real thing. Injected by default; a test passes its own. */
export const nodeSpawn: SpawnLike = (file, args, options) => spawnChildProcess(file, args, options);

export interface ShellInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * How a command string reaches the platform shell.
 *
 * POSIX: `sh -c <command>`, passed as a single argument, so the shell — not
 * Node — does the word splitting and quote handling the contract's author
 * expected.
 *
 * Windows: `cmd.exe /d /s /c "<command>"`, with verbatim arguments. `/d` skips
 * AutoRun registry commands, which would otherwise inject whatever a machine's
 * registry says into every verification step; `/s` fixes how `cmd` strips the
 * outer quotes, which is what lets an inner quote survive.
 */
export const shellInvocation = (platform: NodeJS.Platform, command: string): ShellInvocation =>
  platform === "win32"
    ? { file: "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`] }
    : { file: "sh", args: ["-c", command] };

export interface KillProcessTreeInput {
  readonly pid: number | undefined;
  readonly platform: NodeJS.Platform;
  /** The direct child, killed as the fallback when the tree kill cannot run. */
  readonly child: Pick<SpawnedChild, "kill">;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly spawn: SpawnLike;
  /** Injected so the POSIX leg is testable without signalling a real group. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Kill the whole tree a step started, not just the process the runner spawned.
 *
 * It matters because the direct child is a shell: `sh -c 'npm test'` leaves a
 * node process whose parent is that shell, and a `make` or a test runner leaves
 * more. Killing only the shell orphans them, they keep the captured pipes open,
 * and the step that was supposed to time out hangs instead.
 *
 * POSIX: the child was spawned detached, so it leads its own process group
 * whose id equals its pid, and a negative pid signals the entire group.
 *
 * Windows: there are no process groups to signal, so `taskkill /T /F` walks the
 * child tree by pid and terminates it.
 *
 * Every failure path falls back to killing the direct child, because a tree
 * kill that cannot run must not become a hang.
 */
export const killProcessTree = (input: KillProcessTreeInput): void => {
  const { pid } = input;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    // No pid means the child never reached the OS; there is no tree to walk.
    input.child.kill("SIGKILL");
    return;
  }
  try {
    if (input.platform === "win32") {
      const killer = input.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        cwd: input.cwd,
        env: input.env,
        detached: false,
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: false,
      });
      // taskkill's own output is of no interest, but an unheard `error` event
      // on a child process is an unhandled exception, and draining the pipes
      // keeps a full buffer from leaving a zombie behind.
      killer.on("error", () => input.child.kill());
      killer.stdout?.on("data", () => {});
      killer.stderr?.on("data", () => {});
      return;
    }
    input.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH (already gone) and EPERM both land here. Either way, try the child
    // directly and let the caller's grace timer decide when to give up.
    input.child.kill("SIGKILL");
  }
};
