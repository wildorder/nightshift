/**
 * Launching an npm-global agent CLI through a chosen Node (P16 S-01).
 *
 * `claude` and `codex` are bins whose `#!/usr/bin/env node` shebang runs them
 * on whichever Node is first on `PATH`. On a machine that is the project's
 * pinned Node, which may be one the CLI does not support. So the composition
 * resolves the bin on the image's own `PATH` (a POSIX one: this is for the
 * machine) and launches it as `<image node> <script>`; a native binary is
 * launched by its real path.
 */
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path/posix";

/** What an adapter spawns in place of a CLI's name: `file ...args <cli args>`. */
export interface CliLauncher {
  readonly file: string;
  readonly args: readonly string[];
}

export interface NodeCliDeps {
  /** The POSIX `PATH` the bin is looked for on: the image's, not the project's. */
  readonly path: string;
  readonly exists: (path: string) => boolean;
  readonly realpath: (path: string) => string;
  /** The file's first line, or `undefined` when it cannot be read. */
  readonly firstLine: (path: string) => string | undefined;
}

/** The first line of a file, from its first few hundred bytes. */
const readFirstLine = (path: string): string | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(256);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("latin1").split(/\r?\n/, 1)[0];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

export const nodeCliDeps = (path: string): NodeCliDeps => ({
  path,
  exists: existsSync,
  realpath: realpathSync,
  firstLine: readFirstLine,
});

/** `#!/usr/bin/env node`, `#!/usr/bin/env -S node …`, `#!/usr/local/bin/node`. */
const NODE_SHEBANG = /^#!\s*(?:\S*\/env\s+(?:-S\s+)?)?(?:\S*\/)?node(?:\s|$)/;

/**
 * How to launch `binName` from `deps.path` on `nodePath`: a script with a Node
 * shebang as `nodePath <script>`, anything else by its real path. `undefined`
 * when the bin is not on that `PATH`, so the caller launches it by name.
 */
export const resolveNodeCli = (
  binName: string,
  nodePath: string,
  deps: NodeCliDeps,
): CliLauncher | undefined => {
  for (const dir of deps.path.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, binName);
    if (!deps.exists(candidate)) continue;
    const real = deps.realpath(candidate);
    const line = deps.firstLine(real) ?? "";
    return NODE_SHEBANG.test(line) ? { file: nodePath, args: [real] } : { file: real, args: [] };
  }
  return undefined;
};
