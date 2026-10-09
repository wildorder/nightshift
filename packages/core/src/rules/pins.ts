/**
 * The pins (P16 S-01, D-03).
 *
 * A project says which language runtimes it runs on in files it already
 * commits. `resolvePins` reads them; `satisfiesPin` says whether an exact
 * version meets one; `dispatchToolchain` turns the reference audit's measured
 * versions into the versions a dispatch carries, or refuses.
 *
 * The pin decides what is allowed; the laptop's measured version decides what
 * is installed. A partial pin (`22`) leaves the patch to chance, so a dispatch
 * carries the exact version the audit ran on, never the pin.
 *
 * Choices a later reader would want:
 *
 * - Where several files pin one runtime and agree, the first in `PIN_FILES`'
 *   order is the source; `22`, `v22` and `22.x` agree.
 * - `.tool-versions` may list fallbacks after the first version; only the
 *   first counts, as it is the one the version manager uses.
 * - An alias that names no version (`lts/*`, `lts/iron`, `node`, `system`,
 *   `stable`) is recorded as written. It is not refused here, because the
 *   project does pin something; it is refused by `dispatchToolchain`, since no
 *   exact version can be shown to satisfy it, with a message naming it. Rust's
 *   channels are the exception: `stable`, `beta` and `nightly[-date]` are
 *   satisfied by a version of that channel, and rustup honours the file itself.
 * - `engines.node` is a compatibility statement, not a pin: it is used only
 *   when nothing else pins Node, and so never conflicts.
 *
 * Pure: the caller reads the files and runs the commands.
 */
import type { DispatchToolchain } from "@nightshift/contracts";
import { isExactRuntimeVersion } from "@nightshift/contracts";

/** mise's tool names for the runtimes the pin files name. */
export const PINNED_RUNTIMES = ["node", "python", "ruby", "go", "java", "rust"] as const;
export type PinnedRuntime = (typeof PINNED_RUNTIMES)[number];

/** Every file `resolvePins` reads, in order of precedence. */
export const PIN_FILES = [
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  ".go-version",
  ".java-version",
  "rust-toolchain.toml",
  "rust-toolchain",
  ".tool-versions",
  "package.json",
] as const;

export interface Pin {
  readonly runtime: string;
  /** The version or range, as written, less a leading `v`. */
  readonly spec: string;
  /** The file, or `package.json#volta.node` for a field. */
  readonly source: string;
}

export interface PinConflict {
  readonly runtime: string;
  readonly a: { readonly spec: string; readonly source: string };
  readonly b: { readonly spec: string; readonly source: string };
}

export type PinResolution =
  | { readonly ok: true; readonly pins: readonly Pin[] }
  | { readonly ok: false; readonly conflicts: readonly PinConflict[]; readonly message: string };

/** `.tool-versions` names some tools differently from mise. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  nodejs: "node",
  golang: "go",
};

const SINGLE_RUNTIME_FILES: Readonly<Record<string, PinnedRuntime>> = {
  ".nvmrc": "node",
  ".node-version": "node",
  ".python-version": "python",
  ".ruby-version": "ruby",
  ".go-version": "go",
  ".java-version": "java",
};

const stripComment = (line: string): string => {
  const hash = line.indexOf("#");
  return (hash === -1 ? line : line.slice(0, hash)).trim();
};

const meaningfulLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(stripComment)
    .filter((line) => line !== "");

const cleanSpec = (runtime: string, raw: string): string => {
  let spec = raw.trim().replace(/^["']|["']$/g, "");
  if (/^v\d/.test(spec)) spec = spec.slice(1);
  if (runtime === "ruby") spec = spec.replace(/^ruby-(?=\d)/, "");
  if (runtime === "go") spec = spec.replace(/^go(?=\d)/, "");
  return spec;
};

/** What two pins compare equal by: `22`, `22.x` and `22.*` say the same. */
const comparable = (spec: string): string => spec.replace(/(?:\.(?:x|X|\*))+$/, "");

const singleRuntimePin = (file: string, runtime: PinnedRuntime, text: string): Pin[] => {
  const first = meaningfulLines(text)[0];
  return first === undefined ? [] : [{ runtime, spec: cleanSpec(runtime, first), source: file }];
};

const toolVersionsPins = (file: string, text: string): Pin[] =>
  meaningfulLines(text).flatMap((line) => {
    const [tool, version] = line.split(/\s+/);
    if (tool === undefined || version === undefined) return [];
    const runtime = TOOL_ALIASES[tool] ?? tool;
    return [{ runtime, spec: cleanSpec(runtime, version), source: file }];
  });

/** `[toolchain] channel = "…"`; a legacy `rust-toolchain` is the channel alone, or the same TOML. */
const rustPins = (file: string, text: string): Pin[] => {
  if (file === "rust-toolchain" && !text.includes("[")) {
    return singleRuntimePin(file, "rust", text);
  }
  let inToolchain = false;
  for (const line of meaningfulLines(text)) {
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section !== null) {
      inToolchain = section[1]?.trim() === "toolchain";
      continue;
    }
    const channel = /^channel\s*=\s*["']([^"']+)["']$/.exec(line);
    if (inToolchain && channel?.[1] !== undefined) {
      return [{ runtime: "rust", spec: cleanSpec("rust", channel[1]), source: file }];
    }
  }
  return [];
};

const field = (value: unknown, ...path: string[]): string | undefined => {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() !== "" ? current : undefined;
};

/** `volta.node` is a pin; `engines.node` is returned apart, as the fallback. */
const packageJsonPins = (text: string): { pins: Pin[]; engines?: Pin | undefined } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { pins: [] };
  }
  const volta = field(parsed, "volta", "node");
  const engines = field(parsed, "engines", "node");
  return {
    pins:
      volta === undefined
        ? []
        : [{ runtime: "node", spec: cleanSpec("node", volta), source: "package.json#volta.node" }],
    engines:
      engines === undefined
        ? undefined
        : { runtime: "node", spec: engines.trim(), source: "package.json#engines.node" },
  };
};

/** The pins one file states; `engines.node` apart, as the fallback. */
const pinsInFile = (file: string, text: string): { pins: Pin[]; engines?: Pin | undefined } => {
  const single = SINGLE_RUNTIME_FILES[file];
  if (single !== undefined) return { pins: singleRuntimePin(file, single, text) };
  if (file === "rust-toolchain.toml" || file === "rust-toolchain") {
    return { pins: rustPins(file, text) };
  }
  if (file === ".tool-versions") return { pins: toolVersionsPins(file, text) };
  return packageJsonPins(text);
};

const conflictMessage = (conflicts: readonly PinConflict[]): string =>
  conflicts
    .map(
      (c) =>
        `${c.a.source} pins ${c.runtime} ${c.a.spec} but ${c.b.source} pins ${c.b.spec}; make them agree`,
    )
    .join("\n");

/** Every pin the files state, the first per runtime, and every pin that disagrees with it. */
const collectPins = (
  files: Readonly<Record<string, string>>,
): { pins: Pin[]; conflicts: PinConflict[] } => {
  const found: Pin[] = [];
  let engines: Pin | undefined;
  for (const file of PIN_FILES) {
    const text = files[file];
    if (text === undefined) continue;
    const fromFile = pinsInFile(file, text);
    found.push(...fromFile.pins);
    engines = fromFile.engines ?? engines;
  }
  if (engines !== undefined && !found.some((pin) => pin.runtime === "node")) found.push(engines);

  const pins: Pin[] = [];
  const conflicts: PinConflict[] = [];
  for (const pin of found) {
    const first = pins.find((chosen) => chosen.runtime === pin.runtime);
    if (first === undefined) pins.push(pin);
    else if (comparable(first.spec) !== comparable(pin.spec)) {
      conflicts.push({
        runtime: pin.runtime,
        a: { spec: first.spec, source: first.source },
        b: { spec: pin.spec, source: pin.source },
      });
    }
  }
  return { pins, conflicts };
};

/** Every pinned runtime, from the files present, or the files that disagree. */
export const resolvePins = (files: Readonly<Record<string, string>>): PinResolution => {
  const { pins, conflicts } = collectPins(files);
  return conflicts.length > 0
    ? { ok: false, conflicts, message: conflictMessage(conflicts) }
    : { ok: true, pins };
};

// ── satisfiesPin ─────────────────────────────────────────────────────────────

interface Parsed {
  readonly parts: readonly number[];
  readonly pre: string;
}

const parseExact = (version: string): Parsed | undefined => {
  const match = /^v?(\d+(?:\.\d+)*)(.*)$/.exec(version.trim());
  if (match?.[1] === undefined) return undefined;
  return { parts: match[1].split(".").map(Number), pre: match[2] ?? "" };
};

const compare = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** A partial version: the numbers given before any `x` or `*`. */
const parsePartial = (text: string): readonly number[] | undefined => {
  const match = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(text);
  if (match === null) return undefined;
  const parts: number[] = [];
  for (const part of match.slice(1)) {
    if (part === undefined || !/^\d+$/.test(part)) break;
    parts.push(Number(part));
  }
  return parts;
};

/** The first version above every version that starts with `parts`. */
const bump = (parts: readonly number[], at: number): number[] => [
  ...parts.slice(0, at),
  (parts[at] ?? 0) + 1,
];

type Test = (parts: readonly number[]) => boolean;

const within =
  (low: readonly number[], high: readonly number[] | undefined): Test =>
  (v) =>
    compare(v, low) >= 0 && (high === undefined || compare(v, high) < 0);

/** `^`: up to the next change in the first non-zero part given. */
const caret = (parts: readonly number[]): Test => {
  if (parts.length === 0) return () => true;
  const firstNonZero = parts.findIndex((p) => p !== 0);
  const at = firstNonZero === -1 ? parts.length - 1 : Math.min(firstNonZero, parts.length - 1);
  return within(parts, bump(parts, at));
};

const OPERATORS: Readonly<
  Record<string, (parts: readonly number[], next: readonly number[] | undefined) => Test>
> = {
  "": within,
  "=": within,
  ">=": (parts) => (v) => compare(v, parts) >= 0,
  ">": (_parts, next) => (next === undefined ? () => false : (v) => compare(v, next) >= 0),
  "<": (parts) => (parts.length === 0 ? () => false : (v) => compare(v, parts) < 0),
  "<=": (_parts, next) => (next === undefined ? () => true : (v) => compare(v, next) < 0),
  "~": (parts) =>
    within(parts, parts.length === 0 ? undefined : bump(parts, Math.min(parts.length - 1, 1))),
  "^": caret,
};

const comparator = (text: string): Test | undefined => {
  const match = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(text);
  const operator = OPERATORS[match?.[1] ?? ""];
  const parts = parsePartial(match?.[2] ?? "");
  if (operator === undefined || parts === undefined) return undefined;
  return operator(parts, parts.length === 0 ? undefined : bump(parts, parts.length - 1));
};

/** `A - B`: at least A, at most B (all of B's versions, when B is partial). */
const hyphenRange = (low: string, high: string): Test | undefined => {
  const from = parsePartial(low);
  const to = parsePartial(high);
  if (from === undefined || to === undefined) return undefined;
  const ceiling = to.length === 0 ? undefined : bump(to, to.length - 1);
  return within(from, ceiling);
};

const comparatorSet = (text: string): Test | undefined => {
  const set = text.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
  if (set === "") return () => true;
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
  if (hyphen?.[1] !== undefined && hyphen[2] !== undefined)
    return hyphenRange(hyphen[1], hyphen[2]);
  const tests = set.split(/\s+/).map(comparator);
  if (tests.some((t) => t === undefined)) return undefined;
  return (v) => tests.every((t) => t?.(v) === true);
};

const RUST_CHANNELS: Readonly<Record<string, (pre: string) => boolean>> = {
  stable: (pre) => pre === "",
  beta: (pre) => pre.startsWith("-beta"),
  nightly: (pre) => pre === "-nightly",
};

/**
 * Whether the exact `version` meets the pin `spec`: a partial pin by any
 * version it is a prefix of (`22` by `22.22.0`), an exact pin only by itself,
 * and an npm-style range (`>=24 <25`, `^22`, `~22.1`, `22.x`, `a || b`,
 * `A - B`) by any version in it. A pre-release meets only a spec that names it
 * exactly. A spec that names no version (`lts/*`, `system`) is met by nothing,
 * except Rust's channel names, met by a version of that channel.
 */
export const satisfiesPin = (version: string, spec: string): boolean => {
  const exact = parseExact(version);
  if (exact === undefined) return false;
  const wanted = spec.trim();
  if (wanted.replace(/^v(?=\d)/, "") === version.trim().replace(/^v(?=\d)/, "")) return true;
  const channel = /^(stable|beta|nightly)(?:-\d{4}-\d{2}-\d{2})?$/.exec(wanted);
  if (channel?.[1] !== undefined) return RUST_CHANNELS[channel[1]]?.(exact.pre) === true;
  if (exact.pre !== "") return false;
  return wanted.split("||").some((set) => comparatorSet(set)?.(exact.parts) === true);
};

// ── the versions a dispatch carries ─────────────────────────────────────────

/** The command whose output `parseRuntimeVersion` reads. `java -version` writes to stderr. */
export const RUNTIME_VERSION_COMMANDS: Readonly<Record<PinnedRuntime, readonly string[]>> = {
  node: ["node", "--version"],
  python: ["python", "--version"],
  ruby: ["ruby", "--version"],
  go: ["go", "version"],
  java: ["java", "-version"],
  rust: ["rustc", "--version"],
};

/** Java before 9 reports `1.8.0_392`; mise and JEP 223 call it `8.0.392`. GA releases elide zeros. */
const javaVersion = (text: string): string | undefined => {
  const match = /(?:openjdk|java)(?:\s+version)?\s+"?(\d+(?:\.\d+)*)(?:_(\d+))?/.exec(text);
  if (match?.[1] === undefined) return undefined;
  let parts = match[1].split(".");
  if (parts[0] === "1" && parts.length > 1) {
    parts = [...parts.slice(1, 3), ...(match[2] === undefined ? [] : [match[2]])];
  }
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
};

const VERSION_PATTERNS: Readonly<Record<string, RegExp>> = {
  node: /\bv?(\d+\.\d+\.\d+)\b/,
  python: /Python\s+(\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?)/,
  ruby: /ruby\s+(\d+\.\d+\.\d+(?:-?(?:preview|rc)\d+)?)/,
  go: /\bgo(\d+\.\d+(?:\.\d+)?(?:(?:rc|beta)\d+)?)\b/,
  rust: /rustc\s+(\d+\.\d+\.\d+(?:-(?:beta(?:\.\d+)?|nightly))?)/,
};

/**
 * The exact version in a runtime's `RUNTIME_VERSION_COMMANDS` output, or
 * `undefined` when the output names none: never a partial version.
 */
export const parseRuntimeVersion = (runtime: string, stdout: string): string | undefined => {
  const version =
    runtime === "java" ? javaVersion(stdout) : VERSION_PATTERNS[runtime]?.exec(stdout)?.[1];
  return version !== undefined && isExactRuntimeVersion(runtime, version) ? version : undefined;
};

export type ToolchainResolution =
  | { readonly ok: true; readonly toolchain: DispatchToolchain }
  | { readonly ok: false; readonly message: string };

/**
 * The versions a dispatch carries: for every pin, the version the reference
 * audit measured, which must be exact for its runtime (`isExactRuntimeVersion`)
 * and satisfy the pin. Pin satisfaction alone is not enough: measured `22`
 * satisfies a pin of `22` yet names no release, and the machine would install
 * whichever patch it found. Every refusal is reported, one per line.
 */
export const dispatchToolchain = (
  pins: readonly Pin[],
  measured: Readonly<Record<string, string | undefined>>,
): ToolchainResolution => {
  const toolchain: DispatchToolchain = [];
  const refusals: string[] = [];
  for (const pin of pins) {
    const pinned = `${pin.runtime} ${pin.spec} (${pin.source})`;
    const raw = measured[pin.runtime]?.trim();
    if (raw === undefined || raw === "") {
      refusals.push(`this project pins ${pinned} but ${pin.runtime} was not found on this machine`);
      continue;
    }
    const version = raw.replace(/^v(?=\d)/, "");
    if (!isExactRuntimeVersion(pin.runtime, version)) {
      refusals.push(
        `your audit reported ${pin.runtime} ${version}, which is not an exact version; ` +
          `this project pins ${pin.spec} (${pin.source}) and the machine must install the exact ${pin.runtime} the audit ran on`,
      );
      continue;
    }
    if (!satisfiesPin(version, pin.spec)) {
      refusals.push(
        `your audit ran on ${pin.runtime} ${version}; this project pins ${pin.spec} (${pin.source})`,
      );
      continue;
    }
    toolchain.push({
      runtime: pin.runtime,
      version,
      source: { kind: "pin", file: pin.source, spec: pin.spec },
    });
  }
  return refusals.length > 0
    ? { ok: false, message: refusals.join("\n") }
    : { ok: true, toolchain };
};

// ── rule 8, declares its runtimes (S-02, SC-08) ─────────────────────────────

/**
 * The files at a repository's root that say plainly it uses a runtime, in the
 * order a finding names them. `go.mod` is a marker, not a pin: `resolvePins`
 * does not read it, so a Go project pins Go in `.go-version` or
 * `.tool-versions`.
 */
export const RUNTIME_MARKER_FILES: Readonly<Record<string, PinnedRuntime>> = {
  "package.json": "node",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "setup.py": "python",
  Pipfile: "python",
  Gemfile: "ruby",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "java",
};

/** What rule 8's mechanical audit finds, each naming the files and versions. */
export type RuntimeFinding =
  /** The repository plainly uses `runtime` (`marker` says so) and pins no version of it. */
  | { readonly kind: "unpinned"; readonly runtime: PinnedRuntime; readonly marker: string }
  /** Two pin files disagree about `runtime`. */
  | {
      readonly kind: "conflicting";
      readonly runtime: PinnedRuntime;
      readonly a: { readonly spec: string; readonly source: string };
      readonly b: { readonly spec: string; readonly source: string };
    }
  /**
   * The auditing machine's `runtime` does not satisfy its pin, or names no
   * exact version; `measured` is absent when the runtime was not found.
   */
  | {
      readonly kind: "unmet";
      readonly runtime: PinnedRuntime;
      readonly spec: string;
      readonly source: string;
      readonly measured?: string;
    };

const isPinnedRuntime = (runtime: string): runtime is PinnedRuntime =>
  (PINNED_RUNTIMES as readonly string[]).includes(runtime);

/**
 * The runtimes `runtimeFindings` judges against the auditing machine: each
 * measurable runtime with one agreed pin. A runtime whose pins disagree is
 * not among them, and neither is a tool Nightshift does not install.
 */
export const runtimesToMeasure = (files: Readonly<Record<string, string>>): PinnedRuntime[] => {
  const { pins, conflicts } = collectPins(files);
  const conflicting = new Set(conflicts.map((conflict) => conflict.runtime));
  return pins
    .map((pin) => pin.runtime)
    .filter((runtime): runtime is PinnedRuntime => isPinnedRuntime(runtime))
    .filter((runtime) => !conflicting.has(runtime));
};

/**
 * Rule 8's findings on a checkout: `files` holds the pin files and marker
 * files present at its root, `measured` each pinned runtime's exact version
 * on the auditing machine (absent where it was not found). Only runtimes
 * Nightshift measures and installs (`PINNED_RUNTIMES`) are judged: a pinned
 * tool such as `terraform` in `.tool-versions` is skipped, its conflicts
 * included. A runtime whose pins disagree is reported once as conflicting and
 * not judged against the machine, since there is no one pin to meet.
 */
export const runtimeFindings = (
  files: Readonly<Record<string, string>>,
  measured: Readonly<Record<string, string | undefined>>,
): RuntimeFinding[] => {
  const { pins, conflicts } = collectPins(files);
  const findings: RuntimeFinding[] = [];
  // Kept in step with `runtimesToMeasure`, which says what `measured` should hold.
  const pinned = new Set<string>([...pins, ...conflicts].map((pin) => pin.runtime));

  const unpinned = new Set<PinnedRuntime>();
  for (const [marker, runtime] of Object.entries(RUNTIME_MARKER_FILES)) {
    if (files[marker] === undefined || pinned.has(runtime) || unpinned.has(runtime)) continue;
    unpinned.add(runtime);
    findings.push({ kind: "unpinned", runtime, marker });
  }

  const conflicting = new Set<string>();
  for (const conflict of conflicts) {
    const { runtime } = conflict;
    if (!isPinnedRuntime(runtime)) continue;
    conflicting.add(runtime);
    findings.push({ kind: "conflicting", runtime, a: conflict.a, b: conflict.b });
  }

  for (const pin of pins) {
    const { runtime } = pin;
    if (!isPinnedRuntime(runtime) || conflicting.has(runtime)) continue;
    const version = measured[runtime]?.trim().replace(/^v(?=\d)/, "");
    const at = { kind: "unmet", runtime, spec: pin.spec, source: pin.source } as const;
    if (version === undefined || version === "") findings.push(at);
    else if (!isExactRuntimeVersion(runtime, version) || !satisfiesPin(version, pin.spec)) {
      findings.push({ ...at, measured: version });
    }
  }
  return findings;
};
