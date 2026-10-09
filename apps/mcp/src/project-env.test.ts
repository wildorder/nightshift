import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptProjectEnv,
  formatProjectEnv,
  PROJECT_ENV_FILE_ENV,
  parseProjectEnv,
  readProjectEnv,
} from "./project-env.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the project environment's file (P16 S-01)", () => {
  const env = {
    PATH: "/workspace/stores/runtimes/installs/node/22.11.0/bin:/usr/local/bin:/usr/bin:/bin",
    npm_config_cache: "/workspace/stores/npm",
    ODD: "a=b",
  };

  it("is KEY=VALUE lines that read back as written", () => {
    const text = formatProjectEnv(env);
    expect(text.split("\n")[1]).toBe("npm_config_cache=/workspace/stores/npm");
    expect(parseProjectEnv(`# comment\n\n${text}`)).toEqual(env);
  });

  it("is read only when the environment names it: never on a laptop", async () => {
    expect(await readProjectEnv({})).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "ns-projenv-"));
    dirs.push(dir);
    const file = join(dir, "project.env");
    writeFileSync(file, formatProjectEnv(env));
    expect(await readProjectEnv({ [PROJECT_ENV_FILE_ENV]: file })).toEqual(env);

    const engine: NodeJS.ProcessEnv = {
      [PROJECT_ENV_FILE_ENV]: file,
      PATH: "/usr/bin",
      HOME: "/h",
    };
    expect(await adoptProjectEnv(engine)).toBe(3);
    expect(engine).toMatchObject({ ...env, HOME: "/h" });
    const laptop: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(await adoptProjectEnv(laptop)).toBe(0);
    expect(laptop).toEqual({ PATH: "/usr/bin" });
  });
});
