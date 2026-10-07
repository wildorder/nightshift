/**
 * The gate-machinery fingerprint (P15, D-P15-02).
 *
 * Gate health is recorded per project against a fingerprint of what the gates
 * are: the setup and verification steps, the lockfiles, and the files the
 * auditor names as gate machinery. A plan whose fingerprint matches a healthy
 * record skips the audit, so the fingerprint must change whenever any of those
 * could behave differently, and must not change for anything cosmetic.
 *
 * Pure: the caller reads the files at the commit and hands in their bytes, and
 * the hash is injected, so `core` imports no `node:crypto`.
 *
 * ## The encoding is unambiguous
 *
 * The digest is taken over one canonical byte stream. It starts with a version
 * tag, and every variable-length field is preceded by its length and every list
 * by its count, so no two different inputs can produce the same stream: `"ab"`
 * then `"c"` is not `"a"` then `"bc"`, and a path holding a newline cannot pose
 * as two fields.
 */
import type { SetupStep, VerificationStep } from "@nightshift/contracts";

/** Lowercase hex SHA-256 of raw bytes. Injected: `core` imports no `node:crypto`. */
export type Sha256Bytes = (bytes: Uint8Array) => string;

/** One file of gate machinery at the audited commit. `bytes` undefined means absent there. */
export interface GateFile {
  readonly path: string;
  readonly bytes: Uint8Array | undefined;
}

export interface GateFingerprintInput {
  /** `contract.setup ?? []`, in order. */
  readonly setup: readonly SetupStep[];
  /** The gates, in order: gate order is part of the standard. */
  readonly verification: readonly VerificationStep[];
  /** The lockfiles present and each named machinery path. Order does not matter. */
  readonly files: readonly GateFile[];
}

export const GATE_FINGERPRINT_VERSION = "nightshift-gate-fingerprint/1";

class ByteStream {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  private push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** A non-negative integer as 8 bytes, big-endian. */
  count(n: number): void {
    const chunk = new Uint8Array(8);
    new DataView(chunk.buffer).setBigUint64(0, BigInt(n));
    this.push(chunk);
  }

  bytes(bytes: Uint8Array): void {
    this.count(bytes.length);
    this.push(bytes);
  }

  text(text: string): void {
    this.bytes(new TextEncoder().encode(text));
  }

  /** A single marker byte, distinguishing sections and presence. */
  tag(value: number): void {
    this.push(Uint8Array.of(value));
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
};

/** The files by path, a repeated identical path once; a path given two contents is refused. */
const canonicalFiles = (files: readonly GateFile[]): readonly GateFile[] => {
  const byPath = new Map<string, GateFile>();
  for (const file of files) {
    const seen = byPath.get(file.path);
    if (seen === undefined) byPath.set(file.path, file);
    else if (!sameBytes(seen.bytes, file.bytes)) {
      throw new Error(
        `gate fingerprint: ${JSON.stringify(file.path)} is listed twice with different contents`,
      );
    }
  }
  return [...byPath.values()].sort((a, b) => compare(a.path, b.path));
};

const writeStep = (out: ByteStream, step: SetupStep | VerificationStep): void => {
  out.text(step.id);
  out.text(step.command);
  const requires = "requires" in step ? [...(step.requires ?? [])].sort(compare) : [];
  out.count(requires.length);
  for (const id of requires) out.text(id);
};

/**
 * The fingerprint of a repository's gates (D-P15-02). Step order counts, and so
 * does which list a step is in; a step's `description` does not. Files count by
 * path and content, in no particular order, and an absent file is not an empty one.
 */
export const gateFingerprint = (input: GateFingerprintInput, sha256: Sha256Bytes): string => {
  const out = new ByteStream();
  out.text(GATE_FINGERPRINT_VERSION);

  out.tag(0x01);
  out.count(input.setup.length);
  for (const step of input.setup) writeStep(out, step);

  out.tag(0x02);
  out.count(input.verification.length);
  for (const step of input.verification) writeStep(out, step);

  const files = canonicalFiles(input.files);
  out.tag(0x03);
  out.count(files.length);
  for (const file of files) {
    out.text(file.path);
    if (file.bytes === undefined) out.tag(0x00);
    else {
      out.tag(0x01);
      out.bytes(file.bytes);
    }
  }

  return sha256(out.done());
};

/**
 * The lockfiles a fingerprint counts when they are present: the same list as
 * `LOCKFILES` in `@nightshift/verification`, which decides when an installed
 * tree still fits. Repeated here because `core` sits below `verification` and
 * a client of the control plane can reach `core` alone; a test holds the two
 * lists equal.
 */
export const GATE_LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "uv.lock",
] as const;

/** A file's bytes at the commit being fingerprinted, `undefined` when it is not a file there. */
export type ReadGateFile = (path: string) => Promise<Uint8Array | undefined>;

export interface GateFingerprintAtInput {
  readonly setup: readonly SetupStep[];
  readonly verification: readonly VerificationStep[];
  /** The gate-machinery paths the audit named. */
  readonly machinery: readonly string[];
}

/**
 * {@link gateFingerprint} at one commit, reading what it covers through `read`:
 * each named machinery path (absent counts, as absent) and every lockfile in
 * {@link GATE_LOCKFILES} present there. The one way to compute it, so the CLI
 * that records the audit and the engine that later checks it agree.
 */
export const gateFingerprintAt = async (
  input: GateFingerprintAtInput,
  read: ReadGateFile,
  sha256: Sha256Bytes,
): Promise<string> => {
  const files: GateFile[] = [];
  for (const path of input.machinery) files.push({ path, bytes: await read(path) });
  for (const lockfile of GATE_LOCKFILES) {
    if (input.machinery.includes(lockfile)) continue;
    const bytes = await read(lockfile);
    if (bytes !== undefined) files.push({ path: lockfile, bytes });
  }
  return gateFingerprint({ setup: input.setup, verification: input.verification, files }, sha256);
};
