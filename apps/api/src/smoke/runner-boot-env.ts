/**
 * Pure helpers for the runner boot proof's P16 S-01 checks (`runner-boot.smoke.ts`):
 * the fixture's toolchain, and the line that runs a command as a worker user
 * through the run sandbox's own wrapper. Kept apart from the smoke test itself,
 * whose import alone opens AWS clients and fetches a machine token, so these
 * can be unit tested without touching a machine.
 */
import type { DispatchToolchain } from "@nightshift/contracts";
import { isExactRuntimeVersion } from "@nightshift/contracts";
import { dispatchToolchain, type Pin, resolvePins, satisfiesPin } from "@nightshift/core";

type RequiredRuntime = "node" | "python";
const REQUIRED_RUNTIMES: readonly RequiredRuntime[] = ["node", "python"];

/**
 * An exact version satisfying a pin that names no exact version of its own
 * (`22`, `^3.12`); overridable per runtime by `NIGHTSHIFT_SMOKE_<RUNTIME>_VERSION`.
 */
export const DEFAULT_EXACT_VERSIONS: Readonly<Record<RequiredRuntime, string>> = {
  node: "22.22.0",
  python: "3.12.8",
};

const PIN_HINTS: Readonly<Record<RequiredRuntime, string>> = {
  node: ".nvmrc with an exact Node 22 version (e.g. `22.22.0`)",
  python: ".python-version with an exact 3.12.x version (e.g. `3.12.8`)",
};

export interface FixtureToolchainOverrides {
  readonly node?: string | undefined;
  readonly python?: string | undefined;
}

export type FixtureToolchainResult =
  | { readonly ok: true; readonly toolchain: DispatchToolchain }
  | { readonly ok: false; readonly message: string };

/**
 * The toolchain a dispatch carries for the fixture (P16 S-01, D-03): its Node
 * and Python pins, each at the pin's own version when that is already exact,
 * else a documented default (or `overrides`) that satisfies it. Refuses
 * clearly when the fixture pins neither, two files disagree, or no exact
 * version satisfies a pin.
 */
export const fixtureToolchain = (
  files: Readonly<Record<string, string>>,
  overrides: FixtureToolchainOverrides = {},
): FixtureToolchainResult => {
  const resolution = resolvePins(files);
  if (!resolution.ok) {
    return { ok: false, message: `the fixture's pin files disagree:\n${resolution.message}` };
  }
  const missing = REQUIRED_RUNTIMES.filter(
    (runtime) => !resolution.pins.some((pin) => pin.runtime === runtime),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      message: `the fixture pins no ${missing.join(" or ")}; commit ${missing
        .map((runtime) => PIN_HINTS[runtime])
        .join(" and ")} to wildorder/nightshift-remote-fixture`,
    };
  }
  const measured: Record<string, string> = {};
  const pins: Pin[] = [];
  for (const runtime of REQUIRED_RUNTIMES) {
    const pin = resolution.pins.find((candidate) => candidate.runtime === runtime);
    if (pin === undefined) continue;
    pins.push(pin);
    if (isExactRuntimeVersion(runtime, pin.spec)) {
      measured[runtime] = pin.spec;
      continue;
    }
    const candidate = overrides[runtime] ?? DEFAULT_EXACT_VERSIONS[runtime];
    if (!isExactRuntimeVersion(runtime, candidate) || !satisfiesPin(candidate, pin.spec)) {
      return {
        ok: false,
        message:
          `${candidate} does not satisfy the fixture's ${runtime} pin ${pin.spec} (${pin.source}); ` +
          `set NIGHTSHIFT_SMOKE_${runtime.toUpperCase()}_VERSION to an exact version that does`,
      };
    }
    measured[runtime] = candidate;
  }
  const resolved = dispatchToolchain(pins, measured);
  return resolved.ok
    ? { ok: true, toolchain: resolved.toolchain }
    : { ok: false, message: resolved.message };
};

// ── the run sandbox's own wrapper ───────────────────────────────────────────

/**
 * `KEY=VALUE` lines, as the runner writes `project.env`: blank lines and `#`
 * comments are skipped, and an `=` inside the value is kept whole.
 */
export const parseProjectEnv = (text: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
};

/** A token single-quoted for a POSIX shell; an embedded `'` is escaped the standard way. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export interface ShellCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** One shell line that spawns `command`, its own `env` as leading assignments. */
export const commandLine = (command: ShellCommand): string =>
  [
    ...Object.entries(command.env).map(([name, value]) => `${name}=${shellQuote(value)}`),
    shellQuote(command.file),
    ...command.args.map(shellQuote),
  ].join(" ");

/** How much of a command's output `withExitMarker` keeps: well under SSM's limit on what it returns. */
export const EXIT_MARKED_TAIL_BYTES = 4000;

/**
 * `script`, with its exit code printed on its own last line, for a caller that
 * gets only stdout back. The output is captured and only its tail printed,
 * before the marker: SSM truncates what it returns, so a long output such as
 * `docker info` printed whole lost the marker and read as no exit code at all
 * (2026-10-09). The tail is enough for any check this proof makes. The script
 * runs in a subshell, so one that calls `exit` still reaches the marker.
 */
export const withExitMarker = (script: string): string =>
  [
    "nightshift_out=$(mktemp)",
    "(",
    script,
    ') >"$nightshift_out" 2>&1',
    "nightshift_code=$?",
    `tail -c ${EXIT_MARKED_TAIL_BYTES} "$nightshift_out"`,
    'rm -f "$nightshift_out"',
    `printf '\\nEXIT:%s\\n' "$nightshift_code"`,
  ].join("\n");

/** The `withExitMarker` marker, split back off: the command's own output, and its exit code. */
export const parseExitMarked = (
  output: string,
): { readonly body: string; readonly exitCode: number } => {
  const match = /\nEXIT:(-?\d+)\n?$/.exec(output);
  if (match?.[1] === undefined) return { body: output, exitCode: Number.NaN };
  return { body: output.slice(0, match.index), exitCode: Number(match[1]) };
};
