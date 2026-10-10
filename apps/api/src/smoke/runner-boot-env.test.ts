import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  commandLine,
  DEFAULT_EXACT_VERSIONS,
  EXIT_MARKED_TAIL_BYTES,
  fixtureToolchain,
  parseExitMarked,
  parseProjectEnv,
  parseWorkerNumbers,
  withExitMarker,
} from "./runner-boot-env.js";

describe("fixtureToolchain", () => {
  it("carries each pin's own version when it is already exact", () => {
    const result = fixtureToolchain({ ".nvmrc": "22.22.0\n", ".python-version": "3.12.8\n" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolchain).toEqual([
      {
        runtime: "node",
        version: "22.22.0",
        source: { kind: "pin", file: ".nvmrc", spec: "22.22.0" },
      },
      {
        runtime: "python",
        version: "3.12.8",
        source: { kind: "pin", file: ".python-version", spec: "3.12.8" },
      },
    ]);
  });

  it("falls back to the documented default for a partial pin", () => {
    const result = fixtureToolchain({ ".nvmrc": "22\n", ".python-version": "3.12\n" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolchain.find((entry) => entry.runtime === "node")?.version).toBe(
      DEFAULT_EXACT_VERSIONS.node,
    );
    expect(result.toolchain.find((entry) => entry.runtime === "python")?.version).toBe(
      DEFAULT_EXACT_VERSIONS.python,
    );
  });

  it("takes an override over the default when it satisfies the pin", () => {
    const result = fixtureToolchain(
      { ".nvmrc": "22\n", ".python-version": "3.12\n" },
      { node: "22.9.0" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolchain.find((entry) => entry.runtime === "node")?.version).toBe("22.9.0");
  });

  it("refuses an override that does not satisfy the pin", () => {
    const result = fixtureToolchain(
      { ".nvmrc": "22\n", ".python-version": "3.12.8\n" },
      { node: "20.0.0" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/NIGHTSHIFT_SMOKE_NODE_VERSION/);
  });

  it("refuses when the fixture pins neither node nor python", () => {
    const result = fixtureToolchain({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/\.nvmrc/);
    expect(result.message).toMatch(/\.python-version/);
  });

  it("refuses when the fixture pins only node", () => {
    const result = fixtureToolchain({ ".nvmrc": "22.22.0\n" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/\.python-version/);
  });

  it("surfaces a pin conflict instead of choosing either side", () => {
    const result = fixtureToolchain({
      ".nvmrc": "22\n",
      ".node-version": "24\n",
      ".python-version": "3.12.8\n",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/disagree/);
  });
});

describe("parseProjectEnv", () => {
  it("reads KEY=VALUE lines, skipping blanks and comments", () => {
    expect(parseProjectEnv("PATH=/a:/b\n\n# a comment\nNODE_VERSION=22.22.0\n")).toEqual({
      PATH: "/a:/b",
      NODE_VERSION: "22.22.0",
    });
  });

  it("keeps an embedded = in the value", () => {
    expect(parseProjectEnv("FOO=a=b=c")).toEqual({ FOO: "a=b=c" });
  });
});

describe("commandLine", () => {
  it("quotes the run-as wrapper's arguments for a shell", () => {
    const line = commandLine({
      file: "sudo",
      args: [
        "-n",
        "-u",
        "worker-1",
        "-H",
        "env",
        "NODE_VERSION=22.22.0",
        "sh",
        "-c",
        'umask 002 && exec "$0" "$@"',
        "node",
        "--version",
      ],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    expect(line).toBe(
      "PATH='/usr/local/bin:/usr/bin:/bin' 'sudo' '-n' '-u' 'worker-1' '-H' 'env' " +
        `'NODE_VERSION=22.22.0' 'sh' '-c' 'umask 002 && exec "$0" "$@"' 'node' '--version'`,
    );
  });

  it("escapes an embedded single quote", () => {
    expect(commandLine({ file: "echo", args: ["it's"], env: {} })).toBe(`'echo' 'it'\\''s'`);
  });
});

describe("withExitMarker / parseExitMarked", () => {
  it("round-trips a command's output and exit code", () => {
    expect(parseExitMarked("hello\n\nEXIT:0\n")).toEqual({ body: "hello\n", exitCode: 0 });
  });

  it("reports a non-zero exit code", () => {
    expect(parseExitMarked("\nEXIT:1\n")).toEqual({ body: "", exitCode: 1 });
  });

  it("prints the command's output and then its exit code, through a real shell", () => {
    const ran = spawnSync("sh", ["-c", withExitMarker("echo hi; exit 3")], { encoding: "utf8" });
    expect(parseExitMarked(ran.stdout)).toEqual({ body: "hi\n", exitCode: 3 });
  });

  it("keeps the marker when the output is far longer than what SSM returns", () => {
    const ran = spawnSync("sh", ["-c", withExitMarker("yes line | head -n 20000")], {
      encoding: "utf8",
    });
    const parsed = parseExitMarked(ran.stdout);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.body.length).toBeLessThanOrEqual(EXIT_MARKED_TAIL_BYTES);
  });
});

describe("parseWorkerNumbers", () => {
  it("extracts and sorts worker numbers from a directory listing", () => {
    expect(parseWorkerNumbers("/home/worker-1\n/home/worker-16\n/home/worker-2\n")).toEqual([
      1, 2, 16,
    ]);
  });

  it("is empty for no workers", () => {
    expect(parseWorkerNumbers("")).toEqual([]);
  });
});
