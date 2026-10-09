/**
 * The pins (P16 S-01, D-03).
 */
import { DispatchInputSchema } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import {
  dispatchToolchain,
  type Pin,
  parseRuntimeVersion,
  RUNTIME_MARKER_FILES,
  RUNTIME_VERSION_COMMANDS,
  type RuntimeFinding,
  resolvePins,
  runtimeFindings,
  runtimesToMeasure,
  satisfiesPin,
} from "./pins.js";

const pinsOf = (files: Record<string, string>): readonly Pin[] => {
  const resolved = resolvePins(files);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.pins;
};

describe("resolvePins", () => {
  const table: readonly [string, Record<string, string>, readonly Pin[]][] = [
    [
      "Nightshift's own repository: .node-version over engines.node",
      {
        ".node-version": "24\n",
        "package.json": JSON.stringify({ engines: { node: ">=24 <25" } }),
      },
      [{ runtime: "node", spec: "24", source: ".node-version" }],
    ],
    ["keki: .nvmrc 22", { ".nvmrc": "22\n" }, [{ runtime: "node", spec: "22", source: ".nvmrc" }]],
    [
      "engines.node when nothing else pins node",
      { "package.json": JSON.stringify({ engines: { node: ">=24 <25" } }) },
      [{ runtime: "node", spec: ">=24 <25", source: "package.json#engines.node" }],
    ],
    [
      "volta beats engines",
      { "package.json": JSON.stringify({ volta: { node: "22.22.0" }, engines: { node: ">=20" } }) },
      [{ runtime: "node", spec: "22.22.0", source: "package.json#volta.node" }],
    ],
    [
      "a multi-runtime .tool-versions, with comments and fallbacks",
      {
        ".tool-versions":
          "# runtimes\nnodejs 22.22.0 20.0.0\npython 3.12.7 # the API\ngolang 1.22.3\n\nruby 3.3.0\njava 21.0.2\nrust 1.79.0\n",
      },
      [
        { runtime: "node", spec: "22.22.0", source: ".tool-versions" },
        { runtime: "python", spec: "3.12.7", source: ".tool-versions" },
        { runtime: "go", spec: "1.22.3", source: ".tool-versions" },
        { runtime: "ruby", spec: "3.3.0", source: ".tool-versions" },
        { runtime: "java", spec: "21.0.2", source: ".tool-versions" },
        { runtime: "rust", spec: "1.79.0", source: ".tool-versions" },
      ],
    ],
    [
      "every single-runtime file",
      {
        ".python-version": "3.12\n",
        ".ruby-version": "ruby-3.3.0\n",
        ".go-version": "1.22\n",
        ".java-version": "21\n",
      },
      [
        { runtime: "python", spec: "3.12", source: ".python-version" },
        { runtime: "ruby", spec: "3.3.0", source: ".ruby-version" },
        { runtime: "go", spec: "1.22", source: ".go-version" },
        { runtime: "java", spec: "21", source: ".java-version" },
      ],
    ],
    [
      "rust-toolchain.toml's [toolchain] channel",
      {
        "rust-toolchain.toml":
          '[package]\nchannel = "nope"\n\n[toolchain]\nchannel = "1.79.0"\ncomponents = ["clippy"]\n',
      },
      [{ runtime: "rust", spec: "1.79.0", source: "rust-toolchain.toml" }],
    ],
    [
      "a legacy rust-toolchain file",
      { "rust-toolchain": "nightly-2024-05-01\n" },
      [{ runtime: "rust", spec: "nightly-2024-05-01", source: "rust-toolchain" }],
    ],
    [
      "a leading v, and files that agree",
      { ".nvmrc": "v22\n", ".node-version": "22", ".tool-versions": "nodejs 22.x\n" },
      [{ runtime: "node", spec: "22", source: ".nvmrc" }],
    ],
    [
      "an nvm alias, recorded as written",
      { ".nvmrc": "lts/iron\n" },
      [{ runtime: "node", spec: "lts/iron", source: ".nvmrc" }],
    ],
    ["nothing pinned", { "package.json": "{}" }, []],
  ];

  it.each(table)("%s", (_name, files, pins) => {
    expect(pinsOf(files)).toEqual(pins);
  });

  it("refuses .nvmrc and .tool-versions that disagree, naming both", () => {
    const resolved = resolvePins({ ".nvmrc": "22\n", ".tool-versions": "nodejs 24.11.1\n" });
    expect(resolved).toEqual({
      ok: false,
      conflicts: [
        {
          runtime: "node",
          a: { spec: "22", source: ".nvmrc" },
          b: { spec: "24.11.1", source: ".tool-versions" },
        },
      ],
      message: expect.stringContaining(".nvmrc pins node 22 but .tool-versions pins 24.11.1"),
    });
  });

  it("never lets engines.node conflict", () => {
    expect(
      resolvePins({
        ".nvmrc": "22",
        "package.json": JSON.stringify({ engines: { node: ">=24" } }),
      }).ok,
    ).toBe(true);
  });
});

describe("satisfiesPin", () => {
  const table: readonly [string, string, boolean][] = [
    ["22.22.0", "22", true],
    ["24.11.1", "22", false],
    ["3.12.7", "3.12", true],
    ["3.13.0", "3.12", false],
    ["22.22.0", "22.22.0", true],
    ["22.22.1", "22.22.0", false],
    ["24.11.1", ">=24 <25", true],
    ["25.0.0", ">=24 <25", false],
    ["24.11.1", ">= 24 < 25", true],
    ["22.22.0", "^22", true],
    ["23.0.0", "^22", false],
    ["0.2.5", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["22.1.9", "~22.1", true],
    ["22.2.0", "~22.1", false],
    ["22.22.0", "22.x", true],
    ["22.22.0", "20 || 22", true],
    ["21.0.0", "20 || 22", false],
    ["22.5.0", "20 - 22", true],
    ["23.0.0", "20 - 22", false],
    ["23.0.0", ">22", true],
    ["22.9.0", ">22", false],
    ["22.9.0", "<=22", true],
    ["22.22.0", "*", true],
    ["21.0.2.1", "21", true],
    ["22.22.0", "lts/*", false],
    ["22.22.0", "system", false],
    ["3.13.0rc1", "3.13", false],
    ["3.13.0rc1", "3.13.0rc1", true],
    ["1.79.0", "stable", true],
    ["1.81.0-nightly", "nightly-2024-05-01", true],
    ["1.79.0", "nightly", false],
  ];
  it.each(table)("%s against %s → %s", (version, spec, ok) => {
    expect(satisfiesPin(version, spec)).toBe(ok);
  });
});

describe("parseRuntimeVersion", () => {
  const table: readonly [string, string, string | undefined][] = [
    ["node", "v22.22.0\n", "22.22.0"],
    ["python", "Python 3.12.7\n", "3.12.7"],
    ["ruby", "ruby 3.3.0 (2023-12-25 revision 5124f9ac75) [x86_64-linux]\n", "3.3.0"],
    ["ruby", "ruby 2.7.8p225 (2023-03-30 revision 1f4d455848) [x86_64-linux]\n", "2.7.8"],
    ["go", "go version go1.22.3 linux/amd64\n", "1.22.3"],
    ["go", "go version go1.20 darwin/arm64\n", "1.20"],
    ["java", 'openjdk version "21.0.2" 2024-01-16\nOpenJDK Runtime Environment', "21.0.2"],
    ["java", "openjdk 21.0.2 2024-01-16\n", "21.0.2"],
    ["java", 'openjdk version "17" 2021-09-14\n', "17.0.0"],
    ["java", 'java version "1.8.0_392"\n', "8.0.392"],
    ["rust", "rustc 1.79.0 (129f3b996 2024-06-10)\n", "1.79.0"],
    ["rust", "rustc 1.81.0-nightly (4bc39f028 2024-06-26)\n", "1.81.0-nightly"],
    ["node", "v22\n", undefined],
    ["python", "command not found", undefined],
  ];
  it.each(table)("%s: %j → %s", (runtime, stdout, version) => {
    expect(parseRuntimeVersion(runtime, stdout)).toBe(version);
  });

  it("names a command for every runtime", () => {
    expect(RUNTIME_VERSION_COMMANDS.node).toEqual(["node", "--version"]);
    expect(RUNTIME_VERSION_COMMANDS.go).toEqual(["go", "version"]);
    expect(RUNTIME_VERSION_COMMANDS.rust).toEqual(["rustc", "--version"]);
  });
});

describe("dispatchToolchain", () => {
  const keki = pinsOf({ ".nvmrc": "22\n" });

  it("carries keki's measured 22.22.0, which satisfies .nvmrc 22", () => {
    const result = dispatchToolchain(keki, { node: "v22.22.0" });
    expect(result).toEqual({
      ok: true,
      toolchain: [
        {
          runtime: "node",
          version: "22.22.0",
          source: { kind: "pin", file: ".nvmrc", spec: "22" },
        },
      ],
    });
    if (!result.ok) return;
    const input = {
      repositoryUrl: "https://github.com/acme/keki.git",
      branch: "main",
      baseSha: "a".repeat(40),
      planHash: "sha256:plan",
      toolchain: result.toolchain,
    };
    expect(DispatchInputSchema.safeParse(input).success).toBe(true);
  });

  it("refuses keki on 24.11.1, naming both versions and the pin file", () => {
    expect(dispatchToolchain(keki, { node: "24.11.1" })).toEqual({
      ok: false,
      message: "your audit ran on node 24.11.1; this project pins 22 (.nvmrc)",
    });
  });

  it("refuses Nightshift on 22.22.0 against .node-version 24", () => {
    const pins = pinsOf({
      ".node-version": "24",
      "package.json": JSON.stringify({ engines: { node: ">=24 <25" } }),
    });
    expect(dispatchToolchain(pins, { node: "22.22.0" })).toEqual({
      ok: false,
      message: "your audit ran on node 22.22.0; this project pins 24 (.node-version)",
    });
  });

  // F-01: satisfying the pin is not enough; the machine must get the audit's exact release.
  it.each(["22", "v22", "22.22"])("refuses a partial measured node version %s", (measured) => {
    const result = dispatchToolchain(keki, { node: measured });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("not an exact version");
    expect(result.message).toContain(".nvmrc");
  });

  it("refuses a partial measured python version", () => {
    const pins = pinsOf({ ".python-version": "3.12" });
    expect(dispatchToolchain(pins, { python: "3.12" }).ok).toBe(false);
  });

  it("refuses a pinned runtime that was not measured", () => {
    const pins = pinsOf({ ".python-version": "3.12\n" });
    expect(dispatchToolchain(pins, {})).toEqual({
      ok: false,
      message:
        "this project pins python 3.12 (.python-version) but python was not found on this machine",
    });
  });

  it("refuses an nvm alias, which no version can be shown to satisfy", () => {
    expect(dispatchToolchain(pinsOf({ ".nvmrc": "lts/*" }), { node: "22.22.0" })).toEqual({
      ok: false,
      message: "your audit ran on node 22.22.0; this project pins lts/* (.nvmrc)",
    });
  });

  it("reports every refusal", () => {
    const pins = pinsOf({ ".tool-versions": "nodejs 24\npython 3.12\n" });
    const result = dispatchToolchain(pins, { node: "22.22.0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.split("\n")).toHaveLength(2);
  });
});

describe("runtimeFindings (rule 8, declares its runtimes)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly files: Record<string, string>;
    readonly measured?: Record<string, string | undefined>;
    readonly findings: readonly RuntimeFinding[];
  }> = [
    { name: "an empty repository", files: {}, findings: [] },
    {
      name: "a pinned, met runtime",
      files: { "package.json": "{}", ".nvmrc": "24\n" },
      measured: { node: "24.1.0" },
      findings: [],
    },
    {
      name: "package.json with no Node pin",
      files: { "package.json": "{}" },
      findings: [{ kind: "unpinned", runtime: "node", marker: "package.json" }],
    },
    {
      name: "engines.node counts as Node's pin",
      files: { "package.json": JSON.stringify({ engines: { node: ">=24 <25" } }) },
      measured: { node: "24.3.0" },
      findings: [],
    },
    {
      name: "each Python marker, named once, by the first present",
      files: { "requirements.txt": "", "pyproject.toml": "", Pipfile: "" },
      findings: [{ kind: "unpinned", runtime: "python", marker: "pyproject.toml" }],
    },
    {
      name: "setup.py",
      files: { "setup.py": "" },
      findings: [{ kind: "unpinned", runtime: "python", marker: "setup.py" }],
    },
    {
      name: "a Gemfile",
      files: { Gemfile: "" },
      findings: [{ kind: "unpinned", runtime: "ruby", marker: "Gemfile" }],
    },
    {
      name: "go.mod, which is not itself a pin",
      files: { "go.mod": "module x\n\ngo 1.22\n" },
      findings: [{ kind: "unpinned", runtime: "go", marker: "go.mod" }],
    },
    {
      name: "go.mod with Go pinned in .tool-versions",
      files: { "go.mod": "module x\n", ".tool-versions": "golang 1.22.4\n" },
      measured: { go: "1.22.4" },
      findings: [],
    },
    {
      name: "a Cargo.toml",
      files: { "Cargo.toml": "" },
      findings: [{ kind: "unpinned", runtime: "rust", marker: "Cargo.toml" }],
    },
    {
      name: "each Java marker",
      files: { "build.gradle.kts": "", "build.gradle": "" },
      findings: [{ kind: "unpinned", runtime: "java", marker: "build.gradle" }],
    },
    {
      name: "pom.xml",
      files: { "pom.xml": "" },
      findings: [{ kind: "unpinned", runtime: "java", marker: "pom.xml" }],
    },
    {
      name: "pins that disagree, naming both files and specs, not judged against the machine",
      files: { "package.json": "{}", ".nvmrc": "22\n", ".node-version": "24\n" },
      measured: { node: "20.0.0" },
      findings: [
        {
          kind: "conflicting",
          runtime: "node",
          a: { spec: "22", source: ".nvmrc" },
          b: { spec: "24", source: ".node-version" },
        },
      ],
    },
    {
      name: "a measured runtime that does not satisfy its pin",
      files: { ".nvmrc": "24\n" },
      measured: { node: "v22.22.0" },
      findings: [
        { kind: "unmet", runtime: "node", spec: "24", source: ".nvmrc", measured: "22.22.0" },
      ],
    },
    {
      name: "a measured runtime that names no exact version",
      files: { ".nvmrc": "22\n" },
      measured: { node: "22" },
      findings: [{ kind: "unmet", runtime: "node", spec: "22", source: ".nvmrc", measured: "22" }],
    },
    {
      name: "a pinned runtime missing from the machine",
      files: { ".python-version": "3.12\n" },
      findings: [{ kind: "unmet", runtime: "python", spec: "3.12", source: ".python-version" }],
    },
    {
      name: "an unmeasurable tool, pinned, never judged",
      files: { ".tool-versions": "terraform 1.9.0\n" },
      findings: [],
    },
    {
      name: "an unmeasurable tool whose pins disagree, skipped",
      files: { ".tool-versions": "terraform 1.9.0\nterraform 1.10.0\n" },
      findings: [],
    },
    {
      name: "an unmeasurable conflict beside a measurable one: only the measurable is reported",
      files: {
        ".tool-versions": "terraform 1.9.0\nterraform 1.10.0\nnodejs 24.1.0\n",
        ".nvmrc": "22",
      },
      measured: { node: "22.1.0" },
      findings: [
        {
          kind: "conflicting",
          runtime: "node",
          a: { spec: "22", source: ".nvmrc" },
          b: { spec: "24.1.0", source: ".tool-versions" },
        },
      ],
    },
    {
      name: "several findings at once",
      files: { "package.json": "{}", Gemfile: "", ".ruby-version": "3.3.0\n" },
      measured: { ruby: "3.2.2" },
      findings: [
        { kind: "unpinned", runtime: "node", marker: "package.json" },
        {
          kind: "unmet",
          runtime: "ruby",
          spec: "3.3.0",
          source: ".ruby-version",
          measured: "3.2.2",
        },
      ],
    },
  ];

  for (const { name, files, measured, findings } of cases) {
    it(name, () => {
      expect(runtimeFindings(files, measured ?? {})).toEqual(findings);
    });
  }

  it("never reports a runtime Nightshift does not install", () => {
    const found = runtimeFindings(
      { ".tool-versions": "terraform 1.9.0\nterraform 1.10.0\nnodejs 22\nnodejs 24\n" },
      {},
    );
    expect(found.map((finding) => finding.runtime)).toEqual(["node"]);
  });

  it("measures each agreed, installable pin, even beside a conflict", () => {
    expect(
      runtimesToMeasure({
        ".nvmrc": "22",
        ".node-version": "24",
        ".python-version": "3.12",
        ".tool-versions": "terraform 1.9.0\nruby 3.3.0\n",
      }),
    ).toEqual(["python", "ruby"]);
  });

  it("names a marker for every runtime it installs", () => {
    expect(new Set(Object.values(RUNTIME_MARKER_FILES))).toEqual(
      new Set(["node", "python", "ruby", "go", "java", "rust"]),
    );
  });
});
