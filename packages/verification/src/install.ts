/**
 * One install per lineage of checkouts (D-P10-24).
 *
 * Every checkout Nightshift creates starts with no installed dependencies, and
 * setup runs in each of them: a worker's worktree, an examiner's checkout, and
 * again before every verification. With `npm ci` as the install step that was
 * a full install thirty-odd times a run, a minute each on a real repository,
 * on the path between a worker finishing and its verification starting. The
 * contract said setup should be cheap when there is nothing to do; this is
 * what makes it so.
 *
 * The install step is skipped when the checkout's lockfiles hash exactly as
 * they did when its installed tree was made. The hashes a tree was installed
 * for are kept in a marker inside the tree, written only after an install
 * passes, so a commit that changes a lockfile installs again, and a tree that
 * was removed installs again. Steps that are not installs always run.
 *
 * A new checkout without a tree is **seeded** from a reference checkout (the
 * run's program checkout) by hardlinking its tree, which takes seconds for tens
 * of thousands of files and costs no disk. Only when the reference's **marker**
 * matches the new checkout's lockfiles: the marker is the one proof of what the
 * reference's tree was installed for. The reference's lockfiles are not: a
 * checkout pulled without reinstalling, or whose own setup failed after a
 * lockfile changed, has new lockfiles over an old tree, and seeding from it
 * would certify old dependencies as the new ones (P15's arbiter, 2026-10-07).
 * A reference with no marker, or whose marker records other lockfiles (a
 * failed install never writes one, so the old record stands and no longer
 * matches), seeds nothing, and the checkout installs for itself.
 *
 * On a machine the record also names the pinned runtimes' versions (P16
 * S-01), as `runtime:<name>` entries beside the lockfiles': a tree built for
 * another Node is not this one's, so a pin change installs again. The
 * engine's environment says which runtimes it runs in (`RUNTIMES_ENV`); a
 * laptop's says none, and its records are the lockfiles alone.
 *
 * A skipped step is still recorded, under its own id, with the reason: a
 * cache hit is visible in the evidence and is never mistaken for a run of the
 * command (SC-P10-08).
 */
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SetupStep } from "@nightshift/contracts";
import { isInstallStep, maySkipInstall } from "@nightshift/core";

/** The lockfiles whose hashes decide whether an installed tree still fits. */
export const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "uv.lock",
] as const;

/** The installed tree a Node install produces, and the one that is seeded. */
export const INSTALLED_TREE = "node_modules";

/** The marker's file name, inside the installed tree. */
export const INSTALL_MARKER_NAME = ".nightshift-install.json";

/** Inside the tree, so it goes wherever the tree goes and with it when the tree is removed. */
export const INSTALL_MARKER = join(INSTALLED_TREE, INSTALL_MARKER_NAME);

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** `sha256` per lockfile present under `dir`. */
export const lockfileHashes = async (dir: string): Promise<Record<string, string>> => {
  const hashes: Record<string, string> = {};
  for (const lockfile of LOCKFILES) {
    try {
      hashes[lockfile] = sha256(await readFile(join(dir, lockfile), "utf8"));
    } catch {
      // Not this lockfile.
    }
  }
  return hashes;
};

/** The engine's pinned runtimes, `node@22.11.0 python@3.12.1`, set on a machine (P16 S-01). */
export const RUNTIMES_ENV = "NIGHTSHIFT_RUNTIMES";

/** The value of `RUNTIMES_ENV` for these runtimes, in a stable order. */
export const formatRuntimes = (
  runtimes: readonly { readonly runtime: string; readonly version: string }[],
): string =>
  [...runtimes]
    .sort((a, b) => a.runtime.localeCompare(b.runtime))
    .map(({ runtime, version }) => `${runtime}@${version}`)
    .join(" ");

/** `RUNTIMES_ENV`'s value as marker entries: `{ "runtime:node": "22.11.0" }`. */
export const runtimeHashes = (value: string | undefined): Record<string, string> => {
  const hashes: Record<string, string> = {};
  for (const entry of (value ?? "").split(/\s+/)) {
    const at = entry.indexOf("@");
    if (at <= 0 || at === entry.length - 1) continue;
    hashes[`runtime:${entry.slice(0, at)}`] = entry.slice(at + 1);
  }
  return hashes;
};

/**
 * What an installed tree under `dir` is marked with: its lockfiles' hashes
 * and, when there are lockfiles, the runtimes it is installed for.
 */
export const installHashes = async (
  dir: string,
  runtimes: Readonly<Record<string, string>>,
): Promise<Record<string, string>> => {
  const hashes = await lockfileHashes(dir);
  return Object.keys(hashes).length === 0 ? hashes : { ...hashes, ...runtimes };
};

export const hasInstalledTree = (dir: string): Promise<boolean> =>
  exists(join(dir, INSTALLED_TREE));

export const readInstallMarker = async (
  dir: string,
): Promise<Record<string, string> | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, INSTALL_MARKER), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const hashes: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") hashes[key] = value;
    }
    return hashes;
  } catch {
    return undefined;
  }
};

/**
 * Writes `dir`'s marker as a new file, never into the existing one: a seeded
 * tree's marker is a hardlink to the reference's, and writing through it would
 * rewrite the reference's record of what it was installed for.
 */
export const writeInstallMarker = async (
  dir: string,
  hashes: Readonly<Record<string, string>>,
): Promise<void> => {
  await mkdir(join(dir, INSTALLED_TREE), { recursive: true });
  const path = join(dir, INSTALL_MARKER);
  const next = `${path}.${process.pid}.next`;
  await writeFile(next, `${JSON.stringify(hashes, null, 2)}\n`, "utf8");
  await rename(next, path);
};

/** How many entries are linked at once; a tree is tens of thousands of small files. */
const LINK_CONCURRENCY = 64;

/** Directories an installed tree is never looked for under. */
const NOT_A_WORKSPACE = new Set([INSTALLED_TREE, ".git", "dist", "build", "coverage", ".next"]);
/** How deep a workspace's own tree may sit: `packages/<ws>/node_modules` is depth 2. */
const WORKSPACE_DEPTH = 4;

/**
 * Every `node_modules` under `dir`, as paths relative to it: the root's, and
 * each workspace's own, where npm puts a version that conflicts with the
 * hoisted one. Nothing inside a tree is searched, nor build output, nor
 * deeper than a workspace plausibly sits. (A monorepo's first remote run
 * failed its build on exactly this: the root tree was seeded and
 * `packages/marketplace/node_modules` was not, 2026-10-05.)
 */
export const installedTrees = async (dir: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === INSTALLED_TREE) {
        found.push(child);
        continue;
      }
      if (NOT_A_WORKSPACE.has(entry.name) || entry.name.startsWith(".")) continue;
      if (depth < WORKSPACE_DEPTH) await walk(child, depth + 1);
    }
  };
  await walk("", 0);
  return found.sort();
};

/**
 * Copies every installed tree of `from` into `to` by hardlink, file by file,
 * at the same relative paths, so the copy shares the reference's blocks and
 * takes seconds. Symlinks (npm's `.bin` on Linux, and the workspace links
 * under the root tree, which are relative) are recreated as symlinks; a file
 * that cannot be linked (another filesystem) is copied. Returns how many
 * files were placed.
 */
export const seedInstalledTree = async (from: string, to: string): Promise<number> => {
  let placed = 0;
  for (const tree of await installedTrees(from)) {
    placed += await seedOneTree(join(from, tree), join(to, tree));
  }
  return placed;
};

const seedOneTree = async (source: string, target: string): Promise<number> => {
  let placed = 0;
  const pending: string[] = [""];
  const files: { readonly rel: string; readonly symlink: boolean }[] = [];
  // Directories first, breadth first, so every parent exists before its files.
  while (pending.length > 0) {
    const batch = pending.splice(0, LINK_CONCURRENCY);
    await Promise.all(
      batch.map(async (rel) => {
        await mkdir(join(target, rel), { recursive: true });
        const entries = await readdir(join(source, rel), { withFileTypes: true });
        for (const entry of entries) {
          const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) pending.push(child);
          else files.push({ rel: child, symlink: entry.isSymbolicLink() });
        }
      }),
    );
  }
  for (let index = 0; index < files.length; index += LINK_CONCURRENCY) {
    await Promise.all(
      files.slice(index, index + LINK_CONCURRENCY).map(async ({ rel, symlink: isLink }) => {
        const src = join(source, rel);
        const dst = join(target, rel);
        if (isLink) {
          await symlink(await readlink(src), dst).catch(() => undefined);
        } else {
          try {
            await link(src, dst);
          } catch {
            await mkdir(dirname(dst), { recursive: true });
            await copyFile(src, dst);
          }
        }
        placed += 1;
      }),
    );
  }
  return placed;
};

export interface InstallPlan {
  /** Whether the install steps are skipped this time, and why either way. */
  readonly skipInstalls: boolean;
  readonly reason: string;
  /** The checkout's lockfile hashes now, written as the marker when an install passes. */
  readonly hashes: Record<string, string>;
  /** Files hardlinked from the reference, when the tree was seeded. */
  readonly seeded: number;
}

/**
 * Decides the install for `cwd` before setup runs, seeding the tree from
 * `reference` when that is what makes the skip possible.
 */
export const planInstall = async (
  cwd: string,
  setup: readonly SetupStep[],
  reference: string | undefined,
  /** The runtimes the steps run on, as `runtimeHashes` gives them; none on a laptop. */
  runtimes: Readonly<Record<string, string>> = runtimeHashes(process.env[RUNTIMES_ENV]),
): Promise<InstallPlan> => {
  const hashes = await installHashes(cwd, runtimes);
  if (!setup.some((step) => isInstallStep(step.command))) {
    return { skipInstalls: false, reason: "setup has no install step", hashes, seeded: 0 };
  }
  if (await hasInstalledTree(cwd)) {
    const marker = await readInstallMarker(cwd);
    const decision = maySkipInstall({
      reference: marker,
      checkout: hashes,
      installedTree: true,
    });
    return {
      skipInstalls: decision.skip,
      reason: decision.skip
        ? "the installed tree was made for these lockfiles"
        : marker === undefined
          ? "the installed tree carries no record of what it was installed for"
          : decision.reason,
      hashes,
      seeded: 0,
    };
  }
  if (reference === undefined || reference === cwd || !(await exists(reference))) {
    return {
      skipInstalls: false,
      reason: "no installed tree and nothing to seed from",
      hashes,
      seeded: 0,
    };
  }
  // What the reference's tree was installed for, by its marker: never what its
  // lockfiles say now (see the header).
  const referenceTree = await hasInstalledTree(reference);
  const decision = maySkipInstall({
    reference: referenceTree ? await readInstallMarker(reference) : undefined,
    checkout: hashes,
    installedTree: referenceTree,
  });
  if (!decision.skip) {
    return { skipInstalls: false, reason: `not seeded: ${decision.reason}`, hashes, seeded: 0 };
  }
  let seeded: number;
  try {
    seeded = await seedInstalledTree(reference, cwd);
  } catch (error) {
    // The reference changed under the seed: its own setup was running there
    // (D-P15-11). Not a failure of this checkout's setup, which installs.
    return {
      skipInstalls: false,
      reason: `not seeded: the reference's tree could not be read (${error instanceof Error ? error.message : String(error)})`,
      hashes,
      seeded: 0,
    };
  }
  await writeInstallMarker(cwd, hashes);
  return {
    skipInstalls: true,
    reason: `the installed tree was seeded from ${reference} (${seeded} files hardlinked), whose lockfiles match`,
    hashes,
    seeded,
  };
};
