/**
 * A checkout's own temp directory.
 *
 * Every process Nightshift starts in a checkout (setup, each verification
 * step, the agent working there) is given `TMPDIR`, `TEMP` and `TMP` pointing
 * at a directory beside the checkout, never the machine's shared one. Two
 * reasons, both found on P15's remote run (2026-10-07):
 *
 * - **Hermetic.** What one verification leaves in a temp directory must not
 *   decide the next, any more than an ignored file in the checkout may
 *   (`pristineCheckout`). A fresh scratch per verification is the same rule
 *   for the other place a process writes.
 * - **Bounded.** On a machine `/tmp` is an in-memory tmpfs shared by the
 *   engine and every worker user, and only a file's owner can remove it. A
 *   repository whose tests leak temp folders filled it in one night, eating
 *   half the machine's memory, and every verification after failed. A scratch
 *   lives on the workspace's disk and goes when its checkout's work is done.
 *
 * Outside the checkout, so no gate that walks the tree (a linter, a sterility
 * check, a test glob) ever sees it, and `git status` is untouched. Where it is
 * is the paths port's (`LocalPaths.scratch`): short and of fixed length under
 * the state directory, because tools put unix sockets in a temp directory and a
 * socket's path has a byte limit. It used to sit beside the checkout, with the
 * checkout's length, and broke tsx under a gate audit (keki-backend,
 * 2026-10-07).
 *
 * On a machine a checkout's processes run as its worker (D-P10-25), and the
 * tools they run make owner-only directories the engine cannot delete. So a
 * scratch is removed as that worker when there is one, then by this process
 * for whatever is left.
 */
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import type { LocalPaths } from "@nightshift/core";
import type { StepInvocation } from "@nightshift/verification";

/** Where checkouts' scratches live: the paths port's. */
export type ScratchPaths = Pick<LocalPaths, "scratch">;

/** Wraps a command so it runs as the checkout's worker, as verification steps are. */
export type RunScratchAs = (invocation: StepInvocation) => StepInvocation;

/** Where `checkout`'s scratch lives. */
export const scratchOf = (paths: ScratchPaths, checkout: string): string => paths.scratch(checkout);

/** The variables every platform's temp lookup reads: `TMPDIR` on POSIX, `TEMP` and `TMP` on Windows. */
export const scratchEnv = (dir: string): Readonly<Record<string, string>> => ({
  TMPDIR: dir,
  TEMP: dir,
  TMP: dir,
});

/**
 * What a project step is given beyond the sanitized base (P16, D-10): the
 * project environment when there is one, whole, and the scratch over it, so
 * the step's temp directory is always its own.
 */
export const projectStepEnv = (
  projectEnv: Readonly<Record<string, string>> | undefined,
  dir: string,
): Readonly<Record<string, string>> => ({ ...(projectEnv ?? {}), ...scratchEnv(dir) });

const runToEnd = (invocation: StepInvocation): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn(invocation.file, [...invocation.args], {
      env: { ...invocation.env },
      stdio: "ignore",
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });

/** Removes `checkout`'s scratch, whoever wrote into it. Never throws: a leftover is not a failure. */
export const discardScratch = async (
  paths: ScratchPaths,
  checkout: string,
  as?: RunScratchAs,
): Promise<void> => {
  const dir = scratchOf(paths, checkout);
  if (as !== undefined) {
    await runToEnd(
      as({ file: "rm", args: ["-rf", dir], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }),
    );
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
};

/** An empty scratch for `checkout`, whatever an earlier run left there. Returns its path. */
export const freshScratch = async (
  paths: ScratchPaths,
  checkout: string,
  as?: RunScratchAs,
): Promise<string> => {
  await discardScratch(paths, checkout, as);
  const dir = scratchOf(paths, checkout);
  await mkdir(dir, { recursive: true });
  return dir;
};

/**
 * `checkout`'s scratch, made if it is missing and otherwise left as it is: an
 * agent resumed in the same checkout keeps what it wrote. Returns its path.
 */
export const ensureScratch = async (paths: ScratchPaths, checkout: string): Promise<string> => {
  const dir = scratchOf(paths, checkout);
  await mkdir(dir, { recursive: true });
  return dir;
};
