import { describe, expect, it } from "vitest";
import { type NodeCliDeps, resolveNodeCli } from "./node-cli.js";

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
