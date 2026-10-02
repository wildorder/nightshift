/**
 * The workspace on the volume (P10, T3, D-P10-15, D-P10-02).
 *
 * ```text
 * /workspace/
 *   mirror.git/   bare mirror of the repository, fetched each run
 *   stores/       npm, pnpm, cargo, pip, uv caches, reached through the environment
 *   checkout/     the program checkout the engine integrates into, at the authorised SHA
 *   runs/<runId>/ worktrees, logs, bundles
 * ```
 *
 * A fresh volume gets all of it made; a warm one (from the project's snapshot)
 * gets the mirror fetched and the checkout moved to the SHA, with the stores
 * and the last installed tree already there. Then the plan on the checkout is
 * hashed against the dispatch's `planHash`, and the program's `setup` runs once
 * in the checkout against the stores. Only after that does the runner say
 * `ready`.
 *
 * The clone's credential is the read token the heartbeat carried; it is given
 * to git through a credential helper that reads an environment variable the
 * runner sets for that one command, never a file.
 */
import { createHash } from "node:crypto";
import type { Dispatch, ProgramContract } from "@nightshift/contracts";
import { planHash, type RunScope } from "@nightshift/core";
import { WORKER_GROUP } from "../run-as.js";
import type { Machine } from "./machine.js";

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
}

export interface Prepared {
  /** Seconds the program's setup took in the checkout, for the utilization record. */
  readonly setupSeconds: number;
  readonly lockfileHashes: Record<string, string>;
  readonly warm: boolean;
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

export const prepareWorkspace = async (
  machine: Machine,
  input: PrepareInput,
): Promise<Prepared> => {
  const { layout, dispatch, program, log } = input;
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
    const fetched = await gitWithToken(machine, layout.mirror, input.githubToken, [
      "fetch",
      "--prune",
      "origin",
    ]);
    if (fetched.exitCode !== 0) throw new WorkspaceError(`fetch: ${fetched.stderr.trim()}`);
  } else {
    log("cold volume: cloning the mirror");
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

  // The program's setup, once, against the stores (D-P10-15). Its duration is
  // the warm-versus-cold number.
  const env = storesEnvironment(layout);
  const startedAt = machine.now();
  for (const step of program.setup ?? []) {
    log(`setup ${step.id}: ${step.command}`);
    const result = await machine.exec("env", [
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      "bash",
      "-lc",
      `cd ${JSON.stringify(layout.checkout)} && ${step.command}`,
    ]);
    if (result.exitCode !== 0) {
      throw new WorkspaceError(
        `setup ${step.id} exited ${result.exitCode}: ${result.stderr.trim().slice(-2000)}`,
      );
    }
  }
  const setupSeconds = Math.max(0, (machine.now() - startedAt) / 1000);

  const lockfileHashes: Record<string, string> = {};
  for (const lockfile of [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "uv.lock",
  ]) {
    const text = await machine.readFile(`${layout.checkout}/${lockfile}`);
    if (text !== undefined) lockfileHashes[lockfile] = sha256Hex(text);
  }
  return { setupSeconds, lockfileHashes, warm };
};

export type { RunScope };
