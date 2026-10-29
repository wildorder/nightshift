/**
 * What the runner does to the machine it runs on (P10, T2).
 *
 * Every effect on the host is behind this one interface: running a command,
 * reading and writing a file, and an HTTP call to the instance metadata
 * endpoint. The real one is Node's; the offline suites hand the runner a fake
 * and watch what it asks for. The runner's logic never reaches for `fs` or
 * `child_process` itself.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when `timeoutMs` passed and the command was killed. */
  readonly timedOut?: boolean;
}

export interface ExecOptions {
  /**
   * How long the command may run before it is killed (SIGTERM, which `sudo`
   * relays to what it runs). A killed command answers with `timedOut` and a
   * non-zero exit. Absent, the command runs until it ends.
   */
  readonly timeoutMs?: number;
}

export interface Machine {
  exec(file: string, args: readonly string[], options?: ExecOptions): Promise<CommandResult>;
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  /** A small HTTP exchange with the instance metadata endpoint. */
  http(
    method: "GET" | "PUT",
    url: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ readonly status: number; readonly text: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const nodeMachine: Machine = {
  exec: (file, args, options) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        {
          maxBuffer: 16 * 1024 * 1024,
          ...(options?.timeoutMs === undefined
            ? {}
            : { timeout: options.timeoutMs, killSignal: "SIGTERM" as const }),
        },
        (error, stdout, stderr) => {
          const timedOut = error !== null && (error as { killed?: boolean }).killed === true;
          const exitCode =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
                ? ((error as { code: number }).code as number)
                : 1;
          resolve({
            exitCode,
            stdout: String(stdout),
            stderr: String(stderr),
            ...(timedOut ? { timedOut: true } : {}),
          });
        },
      );
    }),
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writeFile: (path, text) => writeFile(path, text, "utf8"),
  http: async (method, url, headers) => {
    const response = await fetch(url, { method, headers: { ...headers } });
    return { status: response.status, text: await response.text() };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};
