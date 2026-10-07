/**
 * The gate fingerprint at a commit (P15, D-P15-02), from git's bytes.
 *
 * `gateFingerprintAt` in `core` decides what is read and how it is hashed; this
 * supplies the two things `core` may not hold: git, read as raw bytes (a CRLF
 * checkout and an LF one fingerprint alike, because nothing is decoded), and a
 * `node:crypto` sha256.
 *
 * Here rather than in the CLI because two writers of the gate-health record
 * compute it: `nightshift gates --record`, and the engine when a repair lands
 * (P15, D-P15-07). One reader of the bytes, so the two always agree.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ProgramContract } from "@nightshift/contracts";
import { gateFingerprintAt, type ReadGateFile } from "@nightshift/core";

/** A file's bytes at `commit`, `undefined` when it is not a file there. */
export type ReadBlob = (commit: string, path: string) => Promise<Uint8Array | undefined>;

export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const gitBytes = (
  repoPath: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: Buffer; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });

/** Reads blobs out of the repository at `repoPath` with `git cat-file`, never the working tree. */
export const gitBlobReader =
  (repoPath: string): ReadBlob =>
  async (commit, path) => {
    const spec = `${commit}:${path}`;
    const kind = await gitBytes(repoPath, ["cat-file", "-t", spec]);
    // Absent at the commit, or a directory: not a file there.
    if (kind.exitCode !== 0 || kind.stdout.toString("utf8").trim() !== "blob") return undefined;
    const blob = await gitBytes(repoPath, ["cat-file", "blob", spec]);
    if (blob.exitCode !== 0) {
      throw new Error(`git could not read ${spec}: ${blob.stderr.trim()}`);
    }
    return new Uint8Array(blob.stdout);
  };

/**
 * The fingerprint of `contract`'s gates at `commit`: its setup and verification,
 * each `machinery` path, and every lockfile present there.
 */
export const fingerprintAtCommit = (
  read: ReadBlob,
  commit: string,
  contract: Pick<ProgramContract, "setup" | "verification">,
  machinery: readonly string[],
): Promise<string> => {
  const at: ReadGateFile = (path) => read(commit, path);
  return gateFingerprintAt(
    { setup: contract.setup ?? [], verification: contract.verification, machinery },
    at,
    sha256Bytes,
  );
};
