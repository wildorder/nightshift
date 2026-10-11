import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type NodeCliDeps, nodeCliDeps, resolveNodeCli } from "./node-cli.js";

const fakeFs = (
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
  path = "/usr/local/bin",
): NodeCliDeps => ({
  path,
  exists: (p) => p in links || p in files,
  realpath: (p) => links[p] ?? p,
  firstLine: (p) => files[p]?.split("\n", 1)[0],
});

describe("resolveNodeCli (P16 S-01)", () => {
  it.skipIf(process.platform !== "win32")(
    "launches an npm-installed CLI on Windows with arguments intact",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "nightshift cli "));
      try {
        writeFileSync(
          join(directory, "entry.cjs"),
          "console.log(JSON.stringify(process.argv.slice(2)))",
        );
        writeFileSync(
          join(directory, "agent.cmd"),
          '@ECHO off\r\n"%_prog%" "%dp0%\\entry.cjs" %*\r\n',
        );
        const launch = resolveNodeCli("agent", process.execPath, nodeCliDeps(directory, "win32"));
        expect(launch).toBeDefined();
        if (launch === undefined) throw new Error("missing launcher");
        const args = ['a prompt with "quotes" & | < > %PATH%', "second\nline", "C:\\a path\\file"];
        const child = spawnSync(launch.file, [...launch.args, ...args], {
          encoding: "utf8",
          windowsHide: true,
        });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual(args);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("resolves a Windows npm shim to its script without a shell", () => {
    const script = "C:\\Users\\A User\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    const shim = "C:\\Users\\A User\\npm\\codex.cmd";
    const deps: NodeCliDeps = {
      ...fakeFs(
        { [script]: "#!/usr/bin/env node", [shim]: "@ECHO off" },
        {},
        "C:\\missing;C:\\Users\\A User\\npm",
      ),
      platform: "win32",
      readShim: () =>
        '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    };
    expect(resolveNodeCli("codex", "C:\\engine\\node.exe", deps)).toEqual({
      file: "C:\\engine\\node.exe",
      args: [script],
    });
  });

  it("uses a Windows native executable before an npm shim in the same directory", () => {
    const deps: NodeCliDeps = {
      ...fakeFs({ "C:\\bin\\claude.exe": "MZ", "C:\\bin\\claude.cmd": "@ECHO off" }, {}, "C:\\bin"),
      platform: "win32",
      readShim: () => {
        throw new Error("native launcher should win");
      },
    };
    expect(resolveNodeCli("claude", "C:\\engine\\node.exe", deps)).toEqual({
      file: "C:\\bin\\claude.exe",
      args: [],
    });
  });

  it("does not execute an unrecognised Windows shim or POSIX npm wrapper", () => {
    const deps: NodeCliDeps = {
      ...fakeFs(
        { "C:\\bin\\codex.cmd": "@ECHO off", "C:\\bin\\codex": "#!/bin/sh" },
        {},
        "C:\\bin",
      ),
      platform: "win32",
      readShim: () => "@ECHO off\r\necho unknown shim",
    };
    expect(resolveNodeCli("codex", "C:\\engine\\node.exe", deps)).toBeUndefined();
  });

  it("launches a bin with a node shebang through the given node, by its real script", () => {
    const deps = fakeFs(
      { "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js": "#!/usr/bin/env node\n…" },
      {
        "/usr/local/bin/claude": "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      },
    );
    expect(resolveNodeCli("claude", "/usr/local/bin/node", deps)).toEqual({
      file: "/usr/local/bin/node",
      args: ["/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
    });
  });

  it("recognises env -S and absolute node shebangs", () => {
    for (const shebang of ["#!/usr/bin/env -S node --no-warnings", "#!/usr/local/bin/node"]) {
      const deps = fakeFs({ "/usr/local/bin/codex": `${shebang}\n` });
      expect(resolveNodeCli("codex", "/n", deps)).toEqual({
        file: "/n",
        args: ["/usr/local/bin/codex"],
      });
    }
  });

  it("launches a native binary by its real path", () => {
    const deps = fakeFs(
      { "/opt/codex/codex-x86_64": "\u007fELF\u0002\u0001" },
      { "/usr/local/bin/codex": "/opt/codex/codex-x86_64" },
    );
    expect(resolveNodeCli("codex", "/usr/local/bin/node", deps)).toEqual({
      file: "/opt/codex/codex-x86_64",
      args: [],
    });
  });

  it("does not take a nodejs-something shebang for node", () => {
    const deps = fakeFs({ "/usr/local/bin/x": "#!/usr/bin/env nodemon\n" });
    expect(resolveNodeCli("x", "/n", deps)).toEqual({ file: "/usr/local/bin/x", args: [] });
  });

  it("looks only on the PATH it is given, and answers undefined when the bin is not there", () => {
    const deps = fakeFs({ "/home/p/.nvm/bin/claude": "#!/usr/bin/env node\n" });
    expect(resolveNodeCli("claude", "/n", deps)).toBeUndefined();
  });
});
