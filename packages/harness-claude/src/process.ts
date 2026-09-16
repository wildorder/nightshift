/**
 * The process and filesystem surface this adapter uses, and nothing wider.
 *
 * Deliberately the narrowest interface over `node:child_process` and `node:fs`
 * that the adapter needs, for the reason `packages/verification/src/spawn.ts`
 * gives: a test fake has to be a few lines, because anything wider and tests
 * start fabricating a `ChildProcess` — which is how an adapter ends up tested
 * against a mock of Node rather than against its own logic.
 *
 * Process-tree killing is the same problem T4 solved and the same solution.
 * `claude` is not a leaf: it runs the worker's MCP server as a child, and a
 * worker granted `shell.exec` leaves shells and build tools below that. Killing
 * only the process Nightshift spawned orphans the rest, they keep the captured
 * pipes open, and a cancel that was supposed to be bounded hangs instead.
 */
import { spawn as spawnChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** One of the child's output pipes, as this adapter reads it. */
export interface ChildOutputStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
}

/** A spawned Claude Code process, as this adapter observes it. */
export interface SpawnedChild {
  /** Absent when the spawn failed before the OS assigned a pid. */
  readonly pid?: number | undefined;
  readonly stdout: ChildOutputStream | null;
  readonly stderr: ChildOutputStream | null;
  /**
   * `close` rather than `exit`, because it fires once the pipes are drained.
   * Waiting for it is what makes the transcript and the parsed stream complete.
   */
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  /** The child never ran, or could not be signalled. */
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * POSIX only: makes the child a process-group leader so the group can be
   * signalled as a unit on cancel. See {@link killProcessTree}.
   */
  readonly detached: boolean;
  readonly windowsHide: boolean;
  /**
   * `ignore` for stdin, pipes for the rest.
   *
   * Not cosmetic: with an inherited stdin, `claude -p` waits for input it will
   * never get and prints "no stdin data received in 3s, proceeding without it"
   * — three seconds added to every job, observed on 2.1.273.
   */
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export type SpawnLike = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedChild;

/** The real thing. Injected by default; a test passes its own. */
export const nodeSpawn: SpawnLike = (file, args, options) =>
  spawnChildProcess(file, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: options.detached,
    windowsHide: options.windowsHide,
    stdio: [...options.stdio],
  });

/** Where the raw provider stream is written as it arrives. */
export interface TranscriptSink {
  write(chunk: Uint8Array): void;
  close(): void;
}

/**
 * The filesystem operations the adapter performs, as one injectable surface.
 *
 * Three of them, and each has a reason to be here rather than inline: the
 * `--mcp-config` and `--settings` files have to exist on disk before the child
 * starts, they carry the worker's execution identity and so are written 0600,
 * and the transcript has to be appended to as bytes arrive rather than buffered
 * (a long job's stream is megabytes, and the point of streaming it is that a
 * crashed run still leaves evidence).
 */
export interface AdapterFileSystem {
  /** A private directory for this run's configuration files. */
  makeTempDir(prefix: string): string;
  /** Writes `contents` at `path`, owner-only. Creates parent directories. */
  writeConfigFile(path: string, contents: string): void;
  /** Opens the transcript for append. Creates parent directories. */
  openTranscript(path: string): TranscriptSink;
  /** Removes a directory and everything under it. Never throws. */
  removeDir(path: string): void;
}

export const nodeFileSystem: AdapterFileSystem = {
  makeTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  writeConfigFile: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    // 0600: the MCP configuration carries the worker's execution identity, and
    // the machine is shared with whatever else the operator runs.
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  },
  openTranscript: (path) => {
    mkdirSync(dirname(path), { recursive: true });
    const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    // An unheard `error` on a write stream is an unhandled exception, and the
    // transcript is evidence, not the run: a disk that fills must not take the
    // job down with it.
    stream.on("error", () => {});
    return {
      write: (chunk) => void stream.write(chunk),
      close: () => stream.end(),
    };
  },
  removeDir: (path) => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is untidy; failing a job over it is worse.
    }
  },
};

export interface KillProcessTreeInput {
  readonly pid: number | undefined;
  readonly platform: NodeJS.Platform;
  readonly signal: NodeJS.Signals;
  /** The direct child, signalled as the fallback when the tree kill cannot run. */
  readonly child: Pick<SpawnedChild, "kill">;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly spawn: SpawnLike;
  /** Injected so the POSIX leg is testable without signalling a real group. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Signal the whole tree the worker started, not just the process we spawned.
 *
 * POSIX: the child was spawned detached, so it leads its own process group whose
 * id equals its pid, and a negative pid signals the entire group.
 *
 * Windows: there are no process groups to signal. `taskkill /T /F` walks the
 * child tree by pid and terminates it — unconditionally, which is why Windows
 * has no cooperative stop and why a cancelled worker there reports an exit code
 * rather than a signal (see `adapter.ts`).
 *
 * Every failure path falls back to signalling the direct child, because a tree
 * kill that cannot run must not become a hang.
 */
export const killProcessTree = (input: KillProcessTreeInput): void => {
  const { pid } = input;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    // No pid means the child never reached the OS; there is no tree to walk.
    input.child.kill(input.signal);
    return;
  }
  try {
    if (input.platform === "win32") {
      const killer = input.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        cwd: input.cwd,
        env: input.env,
        detached: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      killer.on("error", () => input.child.kill(input.signal));
      killer.stdout?.on("data", () => {});
      killer.stderr?.on("data", () => {});
      return;
    }
    input.kill(-pid, input.signal);
  } catch {
    // ESRCH (already gone) and EPERM both land here. Either way, signal the
    // child directly and let the escalation timer decide when to give up.
    try {
      input.child.kill(input.signal);
    } catch {
      // Already reaped. Nothing left to stop.
    }
  }
};
