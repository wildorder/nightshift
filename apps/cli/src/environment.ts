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
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly git: GitRunner;
  /** Starts the one-request callback listener. Injected so a test binds no port it did not choose. */
  readonly startLoopback: (options: LoopbackOptions) => Promise<Loopback>;
}

/** The ambient environment. Called by `bin/nightshift.ts`, and nowhere else. */
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
  clock: systemClock,
  ids: createUlidIdGenerator(),
  git: nodeGitRunner,
  startLoopback,
});
