/**
 * Everything a command touches that is not pure computation, in one record.
 *
 * The CLI is a thin client (A-16), and the only interesting thing about it is
 * what it talks to: a browser, a token endpoint, the control plane, a git
 * repository, a config directory, and a terminal. All six arrive here as
 * parameters, so every command in this package is drivable **with no network,
 * no browser and no real home directory** — which is what makes the offline
 * suite possible and what keeps `npm test` runnable with no AWS credentials and
 * no Cognito session.
 *
 * `createCliEnvironment` is the only place in this package that reaches for an
 * ambient anything. It is called by the binary and by nothing else.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Clock, IdGenerator } from "@nightshift/core";
import { createUlidIdGenerator, systemClock } from "@nightshift/core";
import type { GitRunner } from "@nightshift/execution";
import { nodeGitRunner } from "@nightshift/execution";
import type { FetchLike, PathEnvironment } from "@nightshift/persistence/http";
import { openBrowser } from "./browser.js";
import { type Loopback, type LoopbackOptions, startLoopback } from "./loopback.js";

/** Where a line of output goes. Injected, so nothing here calls `console`. */
export type Write = (line: string) => void;

/**
 * Opens a URL in the operator's browser.
 *
 * Answers whether it managed to. `false` is not a failure — `nightshift login`
 * prints the URL and waits, which is the same flow a headless machine or an SSH
 * session gets — so this never throws for a browser that is simply absent.
 */
export type BrowserOpener = (url: string) => Promise<boolean>;

/**
 * One line of terminal input, for the paste path of `nightshift login`.
 *
 * `line` resolves with what the human typed, or `undefined` when there is no
 * terminal to read from (a pipe, a service), in which case the loopback callback
 * is the only way in. `cancel` releases stdin so a login that finished through
 * the callback does not leave the process waiting on a keyboard.
 */
export type PasteSource = () => {
  readonly line: Promise<string | undefined>;
  cancel(): void;
};

/** What {@link pasteSourceFor} needs from stdin: a readable that may be a TTY. */
export type PasteInput = NodeJS.ReadableStream & {
  readonly isTTY?: boolean;
  pause?(): unknown;
};

/**
 * A paste source over `input`.
 *
 * Only a terminal is read: on a pipe or a service `line` resolves `undefined`
 * at once and the loopback callback is the only way in. Order matters inside
 * the `line` handler and is the bug this comment exists to prevent: `close`
 * fires synchronously from `reader.close()`, so resolving *after* closing would
 * let the `close` handler resolve `undefined` first and the paste would be read
 * and silently thrown away. Resolve first, then close.
 */
export const pasteSourceFor =
  (input: PasteInput, isTTY: boolean = input.isTTY === true): PasteSource =>
  () => {
    if (!isTTY) return { line: Promise.resolve(undefined), cancel: () => undefined };
    const reader = createInterface({ input, terminal: false });
    let settled = false;
    const line = new Promise<string | undefined>((resolve) => {
      reader.once("line", (text) => {
        settled = true;
        resolve(text);
        reader.close();
      });
      reader.once("close", () => {
        if (!settled) resolve(undefined);
      });
    });
    return {
      line,
      cancel: () => {
        reader.close();
        input.pause?.();
      },
    };
  };

/** Reads one line from the process's terminal, if there is one. */
export const terminalPaste: PasteSource = () => pasteSourceFor(process.stdin)();

/** Runs one program and waits for it. `init` registers the MCP server with Claude Code through it. */
export type Exec = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;

/** What this build of the CLI carries besides itself, for `nightshift init` to hand over. */
export interface CliAssets {
  /** A directory of skills, one subdirectory each. */
  readonly skillsDir: string;
  /** The Nightshift MCP server's entry point. */
  readonly mcpServerPath: string;
  /**
   * The headless root orchestrator's entry point (P7, D-P7-09). The CLI starts
   * it as a process and never imports it: constructing a harness adapter is the
   * MCP app's composition root's alone.
   */
  readonly orchestratePath?: string;
  /**
   * `nightshift resume`'s landing, with an examiner (P8, D-P8-14). Started as a
   * process for the same reason: an examiner is an agent.
   */
  readonly resumePath?: string;
  /**
   * `nightshift-transcript` (P14, D-P14-07): reads a planning session's
   * transcript. Spawned, never imported: reading one is a harness's code.
   */
  readonly transcriptPath?: string;
  /** The local instance's entry point, `nightshift-local` (P12, D-P12-01). Spawned, never imported. */
  readonly localPath?: string;
  /** A built Studio for the local instance to serve (D-P12-04). */
  readonly studioDir?: string;
}

/**
 * Runs a long-lived program in the foreground (P12): its stderr passes through,
 * each stdout line is handed to `onLine` and then printed, and the promise is
 * its exit code. `Ctrl-C` reaches it through the terminal; the CLI waits for it
 * to finish rather than dying first.
 */
export type Launch = (
  file: string,
  args: readonly string[],
  onLine: (line: string) => void | Promise<void>,
) => Promise<number>;

export interface CliEnvironment {
  /** Ordinary output. */
  readonly out: Write;
  /** Diagnostics and failures. */
  readonly err: Write;
  /** Where relative paths (`--repo`, a contract path) resolve from. */
  readonly cwd: string;
  /** Selects the config and state directories. Carries `env`, `platform`, `home`. */
  readonly paths: PathEnvironment;
  readonly fetch: FetchLike;
  readonly openBrowser: BrowserOpener;
  /** A line the operator pastes into the terminal during `login`. */
  readonly readPaste: PasteSource;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly git: GitRunner;
  /** Starts the one-request callback listener. Injected so a test binds no port it did not choose. */
  readonly startLoopback: (options: LoopbackOptions) => Promise<Loopback>;
  /** Absent in suites that run no program; `init` then says what to run by hand. */
  readonly exec?: Exec;
  readonly launch?: Launch;
  readonly assets?: CliAssets;
}

/**
 * A word as cmd.exe must see it. With `shell`, spawn hands cmd.exe one command
 * line, and a path with a space in it, like `C:\Program Files\nodejs\node.exe`,
 * is two words to it unless quoted: the orchestrator then dies with
 * `'C:\Program' is not recognized`.
 */
export const shellWord = (word: string): string =>
  /\s/.test(word) && !(word.startsWith('"') && word.endsWith('"')) ? `"${word}"` : word;

/** The ambient environment. Called by `bin/nightshift.ts`, and nowhere else. */
const nodeExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    // `shell` on Windows only, where `claude` is a `.cmd` shim a bare spawn cannot find.
    const shell = process.platform === "win32";
    const child = shell
      ? spawn(shellWord(file), args.map(shellWord), { cwd: options.cwd, shell })
      : spawn(file, [...args], { cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

const nodeLaunch: Launch = (file, args, onLine) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["inherit", "pipe", "inherit"] });
    // The terminal's Ctrl-C reaches the child too; the CLI waits for it to close.
    const ignore = (): void => {};
    process.on("SIGINT", ignore);
    const lines = createInterface({ input: child.stdout });
    let pending: Promise<void> = Promise.resolve();
    lines.on("line", (line) => {
      pending = pending.then(() => onLine(line));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      process.off("SIGINT", ignore);
      pending.then(() => resolve(code ?? 1), reject);
    });
  });

/**
 * In the workspace the CLI sits at `apps/cli/{src,dist}`, beside the skills and
 * the server it hands over. Publishing the package is not in v1 (P7 §5).
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const createCliEnvironment = (): CliEnvironment => ({
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
  cwd: process.cwd(),
  paths: { env: process.env },
  fetch: globalThis.fetch as unknown as FetchLike,
  openBrowser,
  readPaste: terminalPaste,
  clock: systemClock,
  ids: createUlidIdGenerator(),
  git: nodeGitRunner,
  startLoopback,
  exec: nodeExec,
  launch: nodeLaunch,
  assets: {
    skillsDir: join(REPO_ROOT, "skills"),
    mcpServerPath: join(REPO_ROOT, "apps", "mcp", "dist", "bin", "nightshift-mcp.js"),
    orchestratePath: join(REPO_ROOT, "apps", "mcp", "dist", "bin", "nightshift-orchestrate.js"),
    resumePath: join(REPO_ROOT, "apps", "mcp", "dist", "bin", "nightshift-resume.js"),
    transcriptPath: join(REPO_ROOT, "apps", "mcp", "dist", "bin", "nightshift-transcript.js"),
    localPath: join(REPO_ROOT, "apps", "api", "dist", "bin", "nightshift-local.js"),
    studioDir: join(REPO_ROOT, "apps", "studio", "dist"),
  },
});
