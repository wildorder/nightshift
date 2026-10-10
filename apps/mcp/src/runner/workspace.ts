/**
 * The workspace on the volume (P10, T3, D-P10-15, D-P10-02).
 *
 * ```text
 * /workspace/
 *   mirror.git/   bare mirror of the repository, fetched each run
 *   stores/       npm, pnpm, cargo, pip, uv caches, reached through the environment
 *     runtimes/   the dispatch's pinned runtimes, installed by mise (and rustup)
 *   checkout/     the program checkout the engine integrates into, at the authorised SHA
 *   runs/<runId>/ worktrees, logs, bundles
 * ```
 *
 * A fresh volume gets all of it made; a warm one (from the project's snapshot)
 * gets the mirror fetched and the checkout moved to the SHA, with the stores
 * and the last installed tree already there. Then the plan on the checkout is
 * hashed against the dispatch's `planHash`, the dispatch's pinned runtimes are
 * installed (P16 S-01, D-04), and the program's `setup` runs once in the
 * checkout in the project environment. Only after that does the runner say
 * `ready`.
 *
 * The clone's credential is the read token the heartbeat carried; it is given
 * to git through a credential helper that reads an environment variable the
 * runner sets for that one command, never a file.
 */
import { createHash } from "node:crypto";
import type {
  Dispatch,
  DispatchToolchain,
  ProgramContract,
  RunnerProgress,
  RuntimeVersion,
} from "@nightshift/contracts";
import {
  isInstallStep,
  parseRuntimeVersion,
  planHash,
  RUNTIME_VERSION_COMMANDS,
  type RunScope,
} from "@nightshift/core";
import {
  formatRuntimes,
  INSTALL_MARKER_NAME,
  INSTALLED_TREE,
  LOCKFILES,
  RUNTIMES_ENV,
  runtimeHashes,
} from "@nightshift/verification";
import { formatProjectEnv } from "../project-env.js";
import { WORKER_GROUP } from "../run-as.js";
import type { CommandResult, Machine } from "./machine.js";

export interface WorkspaceLayout {
  readonly root: string;
  readonly mirror: string;
  readonly stores: string;
  readonly checkout: string;
  readonly run: string;
}

export const layoutOf = (root: string, runId: string): WorkspaceLayout => ({
  root,
  mirror: `${root}/mirror.git`,
  stores: `${root}/stores`,
  checkout: `${root}/checkout`,
  run: `${root}/runs/${runId}`,
});

/** The environment every process on the machine gets, so the stores on the volume are the caches. */
export const storesEnvironment = (layout: WorkspaceLayout): Record<string, string> => ({
  npm_config_cache: `${layout.stores}/npm`,
  PNPM_HOME: `${layout.stores}/pnpm`,
  npm_config_store_dir: `${layout.stores}/pnpm-store`,
  CARGO_HOME: `${layout.stores}/cargo`,
  RUSTUP_HOME: "/opt/rust/rustup",
  PIP_CACHE_DIR: `${layout.stores}/pip`,
  UV_CACHE_DIR: `${layout.stores}/uv`,
  PLAYWRIGHT_BROWSERS_PATH: `${layout.stores}/playwright`,
});

/**
 * Where mise installs a dispatch's runtimes (`MISE_DATA_DIR`), on the warm
 * volume: `RUNTIMES_DIR` in `infra/cdk/src/lib/runner-image.ts`,
 * `/workspace/stores/runtimes`, which apps may not import.
 */
export const runtimesDir = (layout: WorkspaceLayout): string => `${layout.stores}/runtimes`;

/**
 * Where a pinned Rust toolchain is installed (P16 S-01). The image's rustup
 * home, `/opt/rust/rustup`, is root's and read-only, and holds only stable;
 * a project pinning another Rust gets a rustup home of its own on the volume,
 * which the engine writes and the workers read.
 */
export const rustupHome = (layout: WorkspaceLayout): string => `${runtimesDir(layout)}/rustup`;

/** The image's rustup and its proxies (`cargo`, `rustc`, `rustfmt`, …), from `runner-image.ts`. */
const IMAGE_CARGO_BIN = "/opt/rust/cargo/bin";
const IMAGE_RUSTUP = `${IMAGE_CARGO_BIN}/rustup`;

/** The image's own PATH, which the runner's unit starts from. */
export const IMAGE_PATH = "/usr/local/bin:/usr/bin:/bin";

/** The runtimes the project pins, which the machine installs; the image's are the image's. */
export const pinnedRuntimes = (
  toolchain: DispatchToolchain | undefined,
): readonly RuntimeVersion[] => (toolchain ?? []).filter((entry) => entry.source.kind === "pin");

/** Where mise puts `runtime@version`'s executables: `<MISE_DATA_DIR>/installs/<runtime>/<version>/bin`. */
export const runtimeBin = (layout: WorkspaceLayout, runtime: string, version: string): string =>
  `${runtimesDir(layout)}/installs/${runtime}/${version}/bin`;

/**
 * The rustup toolchain that is exactly the dispatch's Rust: a release by its
 * number; a beta or nightly, which rustup cannot name by its number, by the
 * pin's own channel (`nightly-2024-12-01`).
 */
export const rustToolchainName = (entry: RuntimeVersion): string =>
  /^\d+\.\d+\.\d+$/.test(entry.version) || entry.source.kind !== "pin"
    ? entry.version
    : entry.source.spec;

/**
 * The one environment every project process on the machine runs in (P16
 * S-01): boot setup, the gate audit, the engine's own steps, and each worker
 * user's agent.
 *
 * - Each pinned runtime's `bin` first on PATH, then the image's PATH and
 *   whatever else the runner's had (`inherited`). Rust is rustup's: its home
 *   on the volume, `RUSTUP_TOOLCHAIN` the exact pinned toolchain, and the
 *   image's proxies on PATH.
 * - The store variables, so the volume's caches are the caches.
 * - For a worker user whose uid is known, `DOCKER_HOST` on its own rootless
 *   socket; without one the run-as wrapper defaults it (`commandAs`).
 *
 * Pure: nothing here looks at the machine.
 */
export const projectEnvironment = (
  layout: WorkspaceLayout,
  toolchain: DispatchToolchain | undefined,
  runAs?: { readonly uid?: number },
  inherited?: string,
): Record<string, string> => {
  const pinned = pinnedRuntimes(toolchain);
  const rust = pinned.find((entry) => entry.runtime === "rust");
  const first = pinned
    .filter((entry) => entry.runtime !== "rust")
    .map((entry) => runtimeBin(layout, entry.runtime, entry.version));
  const path: string[] = [];
  for (const dir of [
    ...first,
    ...(rust === undefined ? [] : [IMAGE_CARGO_BIN]),
    ...IMAGE_PATH.split(":"),
    ...(inherited ?? "").split(":"),
  ]) {
    if (dir !== "" && !path.includes(dir)) path.push(dir);
  }
  const env: Record<string, string> = { PATH: path.join(":"), ...storesEnvironment(layout) };
  if (rust !== undefined) {
    env.RUSTUP_HOME = rustupHome(layout);
    env.RUSTUP_TOOLCHAIN = rustToolchainName(rust);
  }
  const java = pinned.find((entry) => entry.runtime === "java");
  if (java !== undefined) {
    env.JAVA_HOME = `${runtimesDir(layout)}/installs/java/${java.version}`;
  }
  if (pinned.length > 0) env[RUNTIMES_ENV] = formatRuntimes(pinned);
  if (runAs?.uid !== undefined) env.DOCKER_HOST = `unix:///run/user/${runAs.uid}/docker.sock`;
  return env;
};

/**
 * The runtimes the machine installs, exactly, for the `toolchain` stage's
 * detail: "node 22.22.0, python 3.12.8"; with none pinned, the image's.
 */
export const toolchainDetail = (toolchain: DispatchToolchain | undefined): string => {
  const pinned = pinnedRuntimes(toolchain);
  if (pinned.length === 0) return "the image's runtimes";
  const named = pinned.map((entry) => `${entry.runtime} ${entry.version}`).join(", ");
  return named.length <= 500 ? named : `${named.slice(0, 499)}…`;
};

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

export interface PrepareInput {
  readonly layout: WorkspaceLayout;
  readonly dispatch: Dispatch;
  readonly program: ProgramContract;
  /** The ratified plan's text, read from the plane, to be hashed against the dispatch. */
  readonly planText: string;
  /** The GitHub read token the heartbeat carried. */
  readonly githubToken: string;
  readonly log: (line: string) => void;
  /** The runner's own PATH, kept after the project's runtimes and the image's PATH. */
  readonly inheritedPath?: string;
  /**
   * The user project code runs as (D-P10-30). Present, the stores and the
   * checkout are handed to it and the setup runs as it, so every store entry
   * and the installed tree are its own; absent (the tests), as this process.
   */
  readonly projectUser?: string;
  /** Told where the workspace has got to (P16 S-03): the runner's heartbeat carries it. */
  readonly onProgress?: (progress: RunnerProgress) => void;
}

export interface Prepared {
  /** Seconds the program's setup took in the checkout, for the utilization record. */
  readonly setupSeconds: number;
  /** The lockfiles' hashes and the pinned runtimes' versions (`runtime:<name>`): the warm key. */
  readonly lockfileHashes: Record<string, string>;
  readonly warm: boolean;
  /** The project environment setup ran in, for the engine and its workers (P16 S-01). */
  readonly environment: Record<string, string>;
  /** Where it was written, `KEY=VALUE` a line: `<run>/project.env`. */
  readonly environmentFile: string;
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `https://x-access-token:<token>@github.com/owner/name.git` is never written anywhere; git gets it per command. */
const gitWithToken = async (
  machine: Machine,
  cwd: string | undefined,
  token: string,
  args: readonly string[],
) => {
  // The helper echoes the token from the environment of this one invocation.
  // The `${…}` is the shell's, not JavaScript's: git runs this line in sh.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, on purpose
  const helper =
    '!f() { echo username=x-access-token; echo "password=${NIGHTSHIFT_GIT_TOKEN}"; }; f';
  return machine.exec("env", [
    `NIGHTSHIFT_GIT_TOKEN=${token}`,
    "git",
    ...(cwd === undefined ? [] : ["-C", cwd]),
    "-c",
    `credential.helper=${helper}`,
    "-c",
    "credential.useHttpPath=true",
    ...args,
  ]);
};

const run = async (machine: Machine, file: string, args: readonly string[], what: string) => {
  const result = await machine.exec(file, args);
  if (result.exitCode !== 0) {
    throw new WorkspaceError(`${what}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result;
};

/** A TOML string array, `key = ["a", "b"]`, from a `rust-toolchain.toml`; empty when absent. */
const tomlStrings = (text: string, key: string): readonly string[] => {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(text);
  if (match?.[1] === undefined) return [];
  return [...match[1].matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((item) => item[1] ?? item[2] ?? "")
    .filter((item) => item !== "");
};

/** The command that prints `runtime`'s version, by the installed executable's absolute path. */
const versionCommand = (
  layout: WorkspaceLayout,
  entry: RuntimeVersion,
): { readonly file: string; readonly args: readonly string[] } | undefined => {
  const command = (RUNTIME_VERSION_COMMANDS as Readonly<Record<string, readonly string[]>>)[
    entry.runtime
  ];
  if (command === undefined) return undefined;
  const [binary, ...args] = command;
  if (binary === undefined) return undefined;
  return { file: `${runtimeBin(layout, entry.runtime, entry.version)}/${binary}`, args };
};

/**
 * Installs the dispatch's pinned runtimes before setup (P16 S-01, D-04), each
 * at exactly its version, and proves each by its own `--version`.
 *
 * - Every runtime but Rust through mise, into `runtimesDir` on the volume. A
 *   warm volume already has them, and mise does nothing.
 * - Rust through the image's rustup, which the plan keeps for it, into a
 *   rustup home on the volume (`rustupHome`): the image's own is root's and
 *   holds only stable, so a toolchain the project pins is installed here, by
 *   the engine, with the components and targets its `rust-toolchain.toml`
 *   names. `RUSTUP_TOOLCHAIN` then selects exactly it (`projectEnvironment`).
 *
 * The runtimes are left readable, not writable, by the workers' group. A
 * failed install or a version that is not the dispatch's stops the workspace
 * with the tool's own words.
 */
type Probe = { readonly file: string; readonly args: readonly string[] };

const failed = (what: string, result: CommandResult): WorkspaceError =>
  new WorkspaceError(`${what}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);

/**
 * The pinned Rust, by the image's rustup, into the volume's rustup home with
 * the components and targets the project's `rust-toolchain.toml` names.
 */
const installRust = async (
  machine: Machine,
  layout: WorkspaceLayout,
  entry: RuntimeVersion,
  log: (line: string) => void,
): Promise<Probe> => {
  const name = rustToolchainName(entry);
  const file =
    entry.source.kind === "pin"
      ? await machine.readFile(`${layout.checkout}/${entry.source.file}`)
      : undefined;
  const toml = file?.includes("[") ? file : "";
  const extras = [
    ...tomlStrings(toml, "components").flatMap((component) => ["--component", component]),
    ...tomlStrings(toml, "targets").flatMap((target) => ["--target", target]),
  ];
  log(`runtimes: rustup toolchain install ${name}`);
  const rustup = [`RUSTUP_HOME=${rustupHome(layout)}`, `CARGO_HOME=${layout.stores}/cargo`];
  const installed = await machine.exec("env", [
    ...rustup,
    IMAGE_RUSTUP,
    "toolchain",
    "install",
    name,
    "--profile",
    "minimal",
    "--no-self-update",
    ...extras,
  ]);
  if (installed.exitCode !== 0) throw failed(`rustup toolchain install ${name}`, installed);
  return {
    file: "env",
    args: [...rustup, `RUSTUP_TOOLCHAIN=${name}`, `${IMAGE_CARGO_BIN}/rustc`, "--version"],
  };
};

/** Any other pinned runtime, by mise, into `runtimesDir`. */
const installWithMise = async (
  machine: Machine,
  layout: WorkspaceLayout,
  entry: RuntimeVersion,
  log: (line: string) => void,
): Promise<Probe | undefined> => {
  const named = `${entry.runtime}@${entry.version}`;
  log(`runtimes: mise install ${named}`);
  const installed = await machine.exec("env", [
    `MISE_DATA_DIR=${runtimesDir(layout)}`,
    `MISE_CACHE_DIR=${layout.stores}/mise-cache`,
    "MISE_YES=1",
    "mise",
    "install",
    named,
  ]);
  if (installed.exitCode !== 0) throw failed(`mise install ${named}`, installed);
  return versionCommand(layout, entry);
};

export const installRuntimes = async (
  machine: Machine,
  layout: WorkspaceLayout,
  toolchain: DispatchToolchain | undefined,
  log: (line: string) => void,
): Promise<void> => {
  const pinned = pinnedRuntimes(toolchain);
  if (pinned.length === 0) return;
  const dir = runtimesDir(layout);
  await run(machine, "mkdir", ["-p", dir, `${layout.stores}/mise-cache`], `mkdir ${dir}`);
  for (const entry of pinned) {
    const named = `${entry.runtime}@${entry.version}`;
    const probe =
      entry.runtime === "rust"
        ? await installRust(machine, layout, entry, log)
        : await installWithMise(machine, layout, entry, log);
    // A runtime Nightshift has no version command for is mise's word alone.
    if (probe === undefined) continue;
    const ran = await machine.exec(probe.file, probe.args);
    // `java -version` writes to stderr.
    const found = parseRuntimeVersion(entry.runtime, `${ran.stdout}\n${ran.stderr}`);
    if (ran.exitCode !== 0 || found !== entry.version) {
      const said = found ?? (ran.stderr.trim() || `exit ${ran.exitCode}`);
      throw new WorkspaceError(`${named} was installed but reports ${said}, not ${entry.version}`);
    }
    log(`runtimes: ${named} ready`);
  }
  // Every worker reads them; only the engine installs.
  await machine.exec("chgrp", ["-R", WORKER_GROUP, dir]);
  await machine.exec("chmod", ["-R", "g+rX,g-w", dir]);
};

export const prepareWorkspace = async (
  machine: Machine,
  input: PrepareInput,
): Promise<Prepared> => {
  const { layout, dispatch, program, log } = input;
  const progress = (stage: RunnerProgress["stage"], detail: string): void =>
    input.onProgress?.({ stage, detail });
  const url = dispatch.input.repositoryUrl.replace(/\.git$/, "");
  const cloneUrl = `${url}.git`;

  // The hash first: a changed plan is refused before anything is fetched.
  const hash = planHash(program, input.planText, sha256Hex);
  if (hash.hash !== dispatch.input.planHash) {
    throw new WorkspaceError(
      `the plan on the plane hashes to ${hash.hash.slice(0, 12)}, not the ${dispatch.input.planHash.slice(0, 12)} dispatched; the plan changed since`,
    );
  }

  for (const dir of [layout.stores, layout.run, `${layout.run}/worktrees`, `${layout.run}/logs`]) {
    await run(machine, "mkdir", ["-p", dir], `mkdir ${dir}`);
  }

  // The mirror: fetched when it is there, cloned when it is not.
  const mirrored = await machine.exec("git", [
    "-C",
    layout.mirror,
    "rev-parse",
    "--is-bare-repository",
  ]);
  const warm = mirrored.exitCode === 0 && mirrored.stdout.trim() === "true";
  if (warm) {
    log("warm volume: fetching the mirror");
    progress("workspace", "fetching the mirror");
    const fetched = await gitWithToken(machine, layout.mirror, input.githubToken, [
      "fetch",
      "--prune",
      "origin",
    ]);
    if (fetched.exitCode !== 0) throw new WorkspaceError(`fetch: ${fetched.stderr.trim()}`);
  } else {
    log("cold volume: cloning the mirror");
    progress("workspace", "cloning the mirror");
    const cloned = await gitWithToken(machine, undefined, input.githubToken, [
      "clone",
      "--mirror",
      cloneUrl,
      layout.mirror,
    ]);
    if (cloned.exitCode !== 0) throw new WorkspaceError(`clone: ${cloned.stderr.trim()}`);
  }
  const has = await machine.exec("git", [
    "-C",
    layout.mirror,
    "cat-file",
    "-e",
    `${dispatch.input.baseSha}^{commit}`,
  ]);
  if (has.exitCode !== 0) {
    throw new WorkspaceError(
      `the mirror has no commit ${dispatch.input.baseSha.slice(0, 12)}; the branch at GitHub moved or was never pushed`,
    );
  }

  // The checkout: made from the mirror, moved to the SHA; a divergent one is remade.
  progress("workspace", `checking out ${dispatch.input.baseSha.slice(0, 8)}`);
  const checkedOut = await machine.exec("git", ["-C", layout.checkout, "rev-parse", "--git-dir"]);
  const fresh = checkedOut.exitCode !== 0;
  if (fresh) {
    await run(
      machine,
      "git",
      ["clone", "--no-checkout", layout.mirror, layout.checkout],
      "clone the checkout from the mirror",
    );
  } else {
    await run(machine, "git", ["-C", layout.checkout, "fetch", "origin"], "fetch the checkout");
  }
  // A checkout that existed may have been left dirty by the last run; one just
  // cloned with --no-checkout has no files yet, which is not the same thing.
  const dirty = fresh
    ? { stdout: "" }
    : await machine.exec("git", ["-C", layout.checkout, "status", "--porcelain"]);
  if (dirty.stdout.trim().length > 0) {
    log("the checkout was left dirty; resetting it");
    await run(machine, "git", ["-C", layout.checkout, "reset", "--hard"], "reset the checkout");
    await run(
      machine,
      "git",
      ["-C", layout.checkout, "clean", "-fdq", "-e", "node_modules"],
      "clean the checkout",
    );
  }
  await run(
    machine,
    "git",
    [
      "-C",
      layout.checkout,
      "checkout",
      "-q",
      "-B",
      program.repository.programBranch,
      dispatch.input.baseSha,
    ],
    `check out ${dispatch.input.baseSha.slice(0, 12)}`,
  );
  // The push target is GitHub, through the publisher; the checkout's origin
  // stays the mirror so nothing on the machine can push (D-P10-22).

  // Shared with the workers' group (D-P10-25): their commits land in this
  // object store, and the engine verifies and removes what they wrote.
  for (const repo of [layout.mirror, layout.checkout]) {
    await machine.exec("git", ["-C", repo, "config", "core.sharedRepository", "group"]);
  }
  await machine.exec("chgrp", ["-R", WORKER_GROUP, layout.root]);
  await machine.exec("chmod", ["-R", "g+rwX", layout.root]);
  await machine.exec("find", [layout.root, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"]);

  // The pinned runtimes, before setup (P16 S-01, D-04), and the one project
  // environment, written where the engine's processes and the boot proof read it.
  const toolchain = dispatch.input.toolchain;
  progress("toolchain", toolchainDetail(toolchain));
  await installRuntimes(machine, layout, toolchain, log);
  const env = projectEnvironment(layout, toolchain, undefined, input.inheritedPath);
  const environmentFile = `${layout.run}/project.env`;
  await machine.writeFile(environmentFile, formatProjectEnv(env));

  // The stores and the checkout are the project user's (D-P10-30): package
  // managers hard-link store files into node_modules and then chmod them, and
  // only a file's owner may. A warm volume carries entries an earlier run's
  // users wrote, so ownership is handed over on every boot, not only the first.
  if (input.projectUser !== undefined) {
    await run(
      machine,
      "sudo",
      ["-n", "chown", "-R", `${input.projectUser}:${WORKER_GROUP}`, layout.stores, layout.checkout],
      "hand the stores and the checkout to the project user",
    );
  }

  // The program's setup, once, in the project environment (D-P10-15), as the
  // project user. Its duration is the warm-versus-cold number. Not a login
  // shell: a profile would put the image's PATH and rustup home back over the
  // project's. Group-writable, as every project process writes (D-P10-25).
  const startedAt = machine.now();
  if ((program.setup ?? []).length === 0) progress("setup", "no setup steps");
  for (const step of program.setup ?? []) {
    log(`setup ${step.id}: ${step.command}`);
    progress("setup", `setup ${step.id}`.slice(0, 500));
    const command = [
      "env",
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      "bash",
      "-c",
      `umask 002 && cd ${JSON.stringify(layout.checkout)} && ${step.command}`,
    ];
    const result =
      input.projectUser === undefined
        ? await machine.exec(command[0] ?? "env", command.slice(1))
        : await machine.exec("sudo", ["-n", "-u", input.projectUser, "-H", ...command]);
    if (result.exitCode !== 0) {
      throw new WorkspaceError(
        `setup ${step.id} exited ${result.exitCode}: ${result.stderr.trim().slice(-2000)}`,
      );
    }
  }
  const setupSeconds = Math.max(0, (machine.now() - startedAt) / 1000);

  const lockfileHashes: Record<string, string> = {};
  for (const lockfile of LOCKFILES) {
    const text = await machine.readFile(`${layout.checkout}/${lockfile}`);
    if (text !== undefined) lockfileHashes[lockfile] = sha256Hex(text);
  }
  // The runtimes join the warm key and the marker (P16 S-01), as verification
  // reads them from the engine's environment (`installHashes`): a tree built
  // for another Node is installed again.
  Object.assign(lockfileHashes, runtimeHashes(env[RUNTIMES_ENV]));
  // The checkout is the setup reference every worktree is seeded from
  // (D-P10-24, D-P15-11), so its tree is marked with the lockfiles and
  // runtimes it was installed for, as setup marks any tree it installs. The engine does not
  // run setup here again at the run's start; it does after a repair lands.
  if ((program.setup ?? []).some((step) => isInstallStep(step.command))) {
    await machine.exec("mkdir", ["-p", `${layout.checkout}/${INSTALLED_TREE}`]);
    await machine.writeFile(
      `${layout.checkout}/${INSTALLED_TREE}/${INSTALL_MARKER_NAME}`,
      `${JSON.stringify(lockfileHashes, null, 2)}\n`,
    );
  }
  return { setupSeconds, lockfileHashes, warm, environment: env, environmentFile };
};

export type { RunScope };
