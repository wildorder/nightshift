/**
 * The machine runs the project's environment (P16 S-01): the pinned runtimes
 * installed before setup, one project environment, over a fake machine.
 */
import { createHash } from "node:crypto";
import type { DispatchToolchain, RunnerProgress } from "@nightshift/contracts";
import { createFixtures, makeDispatch, makeProgramContract, planHash } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { parseProjectEnv } from "../project-env.js";
import type { CommandResult, Machine } from "./machine.js";
import {
  installRuntimes,
  layoutOf,
  prepareWorkspace,
  projectEnvironment,
  rustToolchainName,
  storesEnvironment,
  toolchainDetail,
  WorkspaceError,
} from "./workspace.js";

const f = createFixtures();
const layout = layoutOf("/workspace", f.scope.runId);
const ok = (stdout = "", stderr = ""): CommandResult => ({ exitCode: 0, stdout, stderr });
const fail = (stderr: string): CommandResult => ({ exitCode: 1, stdout: "", stderr });

const pin = (file: string, spec: string) => ({ kind: "pin" as const, file, spec });

const TOOLCHAIN: DispatchToolchain = [
  { runtime: "node", version: "22.11.0", source: pin(".nvmrc", "22") },
  { runtime: "python", version: "3.12.1", source: pin(".python-version", "3.12") },
  { runtime: "ruby", version: "3.3.0", source: { kind: "image" } },
];

/** Rust 1.79.0: not the image's stable, so rustup must install it (F-02). */
const RUST: DispatchToolchain = [
  { runtime: "rust", version: "1.79.0", source: pin("rust-toolchain.toml", "1.79.0") },
];

interface FakeMachine extends Machine {
  readonly commands: string[];
  readonly files: Map<string, string>;
}

/** Every command recorded; each runtime's `--version` reports what `versions` says. */
const fakeMachine = (
  options: {
    readonly versions?: Readonly<Record<string, string>>;
    readonly exec?: (file: string, args: readonly string[]) => CommandResult | undefined;
  } = {},
): FakeMachine => {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const versions = options.versions ?? {
    node: "v22.11.0",
    python: "Python 3.12.1",
    rustc: "rustc 1.79.0 (129f3b996 2024-06-10)",
  };
  return {
    commands,
    files,
    exec: async (file, args) => {
      const line = [file, ...args].join(" ");
      commands.push(line);
      const custom = options.exec?.(file, args);
      if (custom !== undefined) return custom;
      if (line.includes("rev-parse --is-bare-repository")) return ok("true\n");
      if (line.includes("rev-parse --git-dir")) return ok(".git\n");
      const binary = (file === "env" ? args.find((arg) => !arg.includes("=")) : file) ?? "";
      const name = binary.split("/").at(-1) ?? "";
      if (args.at(-1) === "--version" && versions[name] !== undefined) {
        return ok(`${versions[name]}\n`);
      }
      return ok();
    },
    readFile: async (path) => files.get(path),
    writeFile: async (path, text) => {
      files.set(path, text);
    },
    http: async () => ({ status: 404, text: "" }),
    sleep: async () => undefined,
    now: () => 0,
  };
};

describe("projectEnvironment (P16 S-01)", () => {
  it("puts each pinned runtime's bin first on PATH, then the image's and the runner's", () => {
    const env = projectEnvironment(layout, TOOLCHAIN, undefined, "/usr/bin:/opt/extra");
    expect(env.PATH).toBe(
      [
        "/workspace/stores/runtimes/installs/node/22.11.0/bin",
        "/workspace/stores/runtimes/installs/python/3.12.1/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/extra",
      ].join(":"),
    );
    // The image's ruby is the image's: nothing of it on PATH.
    expect(env.PATH).not.toContain("ruby");
  });

  it("folds in the store variables and names the runtimes the trees are installed for", () => {
    const env = projectEnvironment(layout, TOOLCHAIN);
    expect(env).toMatchObject(storesEnvironment(layout));
    expect(env.NIGHTSHIFT_RUNTIMES).toBe("node@22.11.0 python@3.12.1");
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it("sets DOCKER_HOST on the worker user's own rootless socket", () => {
    const env = projectEnvironment(layout, TOOLCHAIN, { uid: 1003 });
    expect(env.DOCKER_HOST).toBe("unix:///run/user/1003/docker.sock");
  });

  it("is the stores and the image's PATH alone with no toolchain, as on a dispatch before P16", () => {
    const env = projectEnvironment(layout, undefined);
    expect(env).toEqual({ PATH: "/usr/local/bin:/usr/bin:/bin", ...storesEnvironment(layout) });
    expect(env.RUSTUP_HOME).toBe("/opt/rust/rustup");
  });

  it("selects a pinned Rust from a rustup home on the volume, not the image's read-only one (F-02)", () => {
    const env = projectEnvironment(layout, RUST);
    expect(env.RUSTUP_HOME).toBe("/workspace/stores/runtimes/rustup");
    expect(env.RUSTUP_TOOLCHAIN).toBe("1.79.0");
    expect(env.PATH?.split(":")[0]).toBe("/opt/rust/cargo/bin");
  });

  it("names a nightly or beta Rust by its pin's channel, which rustup can install", () => {
    expect(
      rustToolchainName({
        runtime: "rust",
        version: "1.85.0-nightly",
        source: pin("rust-toolchain.toml", "nightly-2024-12-01"),
      }),
    ).toBe("nightly-2024-12-01");
    expect(rustToolchainName(RUST[0] as DispatchToolchain[number])).toBe("1.79.0");
  });

  it("gives a pinned Java its JAVA_HOME", () => {
    const env = projectEnvironment(layout, [
      { runtime: "java", version: "21.0.2", source: pin(".java-version", "21") },
    ]);
    expect(env.JAVA_HOME).toBe("/workspace/stores/runtimes/installs/java/21.0.2");
  });
});

describe("installRuntimes (P16 S-01, D-04)", () => {
  it("installs each pinned runtime with mise into the runtimes dir and proves its version", async () => {
    const machine = fakeMachine();
    await installRuntimes(machine, layout, TOOLCHAIN, () => undefined);
    const installs = machine.commands.filter((line) => line.includes("mise install"));
    expect(installs).toEqual([
      "env MISE_DATA_DIR=/workspace/stores/runtimes MISE_CACHE_DIR=/workspace/stores/mise-cache MISE_YES=1 mise install node@22.11.0",
      "env MISE_DATA_DIR=/workspace/stores/runtimes MISE_CACHE_DIR=/workspace/stores/mise-cache MISE_YES=1 mise install python@3.12.1",
    ]);
    expect(machine.commands).toContain(
      "/workspace/stores/runtimes/installs/node/22.11.0/bin/node --version",
    );
    expect(machine.commands).toContain(
      "/workspace/stores/runtimes/installs/python/3.12.1/bin/python --version",
    );
    // The image's ruby is not installed.
    expect(machine.commands.join("\n")).not.toContain("ruby");
    // The workers read the runtimes; they do not write them.
    expect(machine.commands).toContain("chgrp -R nightshift /workspace/stores/runtimes");
    expect(machine.commands).toContain("chmod -R g+rX,g-w /workspace/stores/runtimes");
  });

  it("stops the workspace with mise's own words when an install fails", async () => {
    const machine = fakeMachine({
      exec: (_file, args) =>
        args.includes("python@3.12.1")
          ? fail("mise ERROR python@3.12.1: no precompiled python found")
          : undefined,
    });
    const attempt = installRuntimes(machine, layout, TOOLCHAIN, () => undefined);
    await expect(attempt).rejects.toBeInstanceOf(WorkspaceError);
    await expect(attempt).rejects.toThrow(
      "mise install python@3.12.1: mise ERROR python@3.12.1: no precompiled python found",
    );
  });

  it("refuses a runtime whose --version is not the dispatch's", async () => {
    const machine = fakeMachine({ versions: { node: "v22.12.0", python: "Python 3.12.1" } });
    await expect(installRuntimes(machine, layout, TOOLCHAIN, () => undefined)).rejects.toThrow(
      "node@22.11.0 was installed but reports 22.12.0, not 22.11.0",
    );
  });

  it("installs a pinned Rust that is not the image's stable through rustup into the volume's rustup home, with the file's components (F-02)", async () => {
    const machine = fakeMachine();
    machine.files.set(
      `${layout.checkout}/rust-toolchain.toml`,
      '[toolchain]\nchannel = "1.79.0"\ncomponents = ["clippy", "rustfmt"]\ntargets = ["wasm32-unknown-unknown"]\n',
    );
    await installRuntimes(machine, layout, RUST, () => undefined);
    expect(machine.commands).toContain(
      [
        "env RUSTUP_HOME=/workspace/stores/runtimes/rustup CARGO_HOME=/workspace/stores/cargo",
        "/opt/rust/cargo/bin/rustup toolchain install 1.79.0 --profile minimal --no-self-update",
        "--component clippy --component rustfmt --target wasm32-unknown-unknown",
      ].join(" "),
    );
    // Proved by the toolchain the project environment selects, never the image's stable.
    expect(machine.commands).toContain(
      "env RUSTUP_HOME=/workspace/stores/runtimes/rustup CARGO_HOME=/workspace/stores/cargo RUSTUP_TOOLCHAIN=1.79.0 /opt/rust/cargo/bin/rustc --version",
    );
    expect(machine.commands.join("\n")).not.toContain("mise install rust");
    expect(machine.commands.join("\n")).not.toContain("RUSTUP_HOME=/opt/rust/rustup");
  });

  it("stops the workspace with rustup's words when the toolchain cannot be installed", async () => {
    const machine = fakeMachine({
      exec: (_file, args) =>
        args.includes("toolchain")
          ? fail("error: toolchain '1.79.0' is not installable")
          : undefined,
    });
    await expect(installRuntimes(machine, layout, RUST, () => undefined)).rejects.toThrow(
      "rustup toolchain install 1.79.0: error: toolchain '1.79.0' is not installable",
    );
  });

  it("does nothing without a pinned runtime", async () => {
    const machine = fakeMachine();
    await installRuntimes(machine, layout, [], () => undefined);
    await installRuntimes(machine, layout, undefined, () => undefined);
    expect(machine.commands).toEqual([]);
  });
});

describe("prepareWorkspace in the project environment (P16 S-01)", () => {
  const program = makeProgramContract(f, {
    repository: {
      url: "https://github.com/wildorder/fixture",
      baseBranch: "main",
      programBranch: "program/fixture",
    },
    setup: [{ id: "install", command: "npm ci --prefer-offline" }],
  });
  const planText = "# Plan\n";
  const dispatch = makeDispatch(f, {
    input: {
      repositoryUrl: "https://github.com/wildorder/fixture",
      branch: "program/fixture",
      baseSha: "a".repeat(40),
      planHash: planHash(program, planText, (text) =>
        createHash("sha256").update(text).digest("hex"),
      ).hash,
      toolchain: TOOLCHAIN,
    },
  });

  const prepare = (machine: Machine, onProgress?: (progress: RunnerProgress) => void) =>
    prepareWorkspace(machine, {
      layout,
      dispatch,
      program,
      planText,
      githubToken: "ghs_read",
      log: () => undefined,
      inheritedPath: "/usr/local/bin:/usr/bin:/bin",
      ...(onProgress === undefined ? {} : { onProgress }),
    });

  it("says where it has got to (P16 S-03): the mirror, the checkout, the exact runtimes, each setup step", async () => {
    const machine = fakeMachine();
    const progress: RunnerProgress[] = [];
    await prepare(machine, (given) => progress.push(given));
    expect(progress).toEqual([
      { stage: "workspace", detail: "fetching the mirror" },
      { stage: "workspace", detail: "checking out aaaaaaaa" },
      { stage: "toolchain", detail: "node 22.11.0, python 3.12.1" },
      { stage: "setup", detail: "setup install" },
    ]);
    // With nothing pinned, the image's runtimes are what runs.
    expect(toolchainDetail(undefined)).toBe("the image's runtimes");
    expect(
      toolchainDetail([{ runtime: "ruby", version: "3.3.0", source: { kind: "image" } }]),
    ).toBe("the image's runtimes");
  });

  it("installs the runtimes before setup, and runs setup in the project environment, not a login shell", async () => {
    const machine = fakeMachine();
    machine.files.set(`${layout.checkout}/package-lock.json`, '{"lockfileVersion":3}');
    const prepared = await prepare(machine);
    const install = machine.commands.findIndex((line) => line.includes("mise install node@"));
    const setup = machine.commands.findIndex((line) => line.includes("npm ci --prefer-offline"));
    expect(install).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(install);
    const line = machine.commands[setup] ?? "";
    expect(line).toContain(
      "PATH=/workspace/stores/runtimes/installs/node/22.11.0/bin:/workspace/stores/runtimes/installs/python/3.12.1/bin:/usr/local/bin",
    );
    expect(line).toContain("npm_config_cache=/workspace/stores/npm");
    expect(line).toContain(" bash -c ");
    expect(line).not.toContain("bash -lc");
    expect(prepared.environment).toEqual(
      projectEnvironment(layout, TOOLCHAIN, undefined, "/usr/local/bin:/usr/bin:/bin"),
    );
  });

  it("writes the project environment to project.env for the engine and the boot proof", async () => {
    const machine = fakeMachine();
    const prepared = await prepare(machine);
    expect(prepared.environmentFile).toBe(`/workspace/runs/${f.scope.runId}/project.env`);
    const text = machine.files.get(prepared.environmentFile) ?? "";
    expect(parseProjectEnv(text)).toEqual(prepared.environment);
    expect(text).not.toMatch(/TOKEN|ghs_read/);
  });

  it("puts the runtime versions in the warm key and the installed tree's marker", async () => {
    const machine = fakeMachine();
    machine.files.set(`${layout.checkout}/package-lock.json`, '{"lockfileVersion":3}');
    const prepared = await prepare(machine);
    expect(prepared.lockfileHashes).toMatchObject({
      "runtime:node": "22.11.0",
      "runtime:python": "3.12.1",
    });
    expect(Object.keys(prepared.lockfileHashes).sort()).toEqual([
      "package-lock.json",
      "runtime:node",
      "runtime:python",
    ]);
    expect(
      JSON.parse(
        machine.files.get(`${layout.checkout}/node_modules/.nightshift-install.json`) ?? "",
      ),
    ).toEqual(prepared.lockfileHashes);
  });

  it("stops before setup when a runtime cannot be installed", async () => {
    const machine = fakeMachine({
      exec: (_file, args) =>
        args.includes("node@22.11.0") ? fail("gpg: BAD signature") : undefined,
    });
    await expect(prepare(machine)).rejects.toThrow("mise install node@22.11.0: gpg: BAD signature");
    expect(machine.commands.some((line) => line.includes("npm ci"))).toBe(false);
  });
});
