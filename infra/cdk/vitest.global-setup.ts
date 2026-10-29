/**
 * Where the CDK tests' cloud assemblies go, and that they go away.
 *
 * Every `new App()` without an `outdir` synthesises into a fresh
 * `cdk.out*` folder under the OS temp directory, and nothing removes it:
 * about 97 folders per run of this project. On a laptop that is slow
 * clutter. On a remote runner, where `/tmp` is a small in-memory tmpfs
 * shared by every worker user, it filled the machine in one night and
 * failed every verification after (P15's run, 2026-10-07).
 *
 * So the project runs with its own temp directory: made here, before
 * any worker starts, inherited by every worker (`os.tmpdir()` reads
 * `TMPDIR` on POSIX and `TEMP`/`TMP` on Windows), and removed when the
 * project's tests are done. `CDK_OUTDIR` is not the lever: setting it
 * makes every App synthesise again at process exit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const scratch = mkdtempSync(join(tmpdir(), "nightshift-cdk-tests-"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = scratch;
  return () => rmSync(scratch, { recursive: true, force: true });
}
