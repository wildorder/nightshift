/** A checkout's scratch: beside it, fresh when asked, gone when discarded, removed as its worker when there is one. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepInvocation } from "@nightshift/verification";
import { afterEach, describe, expect, it } from "vitest";
import { discardScratch, ensureScratch, freshScratch, scratchEnv, scratchOf } from "./scratch.js";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

let root = "";
/** Scratches under the test's own root, as the paths port puts them under the state directory. */
const paths = {
  scratch: (checkout: string) => join(root, "t", checkout.split(/[\\/]/).at(-1) ?? "x"),
};

const checkout = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), "nightshift-scratch-"));
  made.push(root);
  const path = join(root, "node_a");
  await mkdir(path);
  return path;
};

describe("a checkout's scratch", () => {
  it("is where the paths port says, never inside the checkout", async () => {
    const path = await checkout();
    expect(scratchOf(paths, path)).toBe(join(root, "t", "node_a"));
    expect(scratchEnv("/x")).toEqual({ TMPDIR: "/x", TEMP: "/x", TMP: "/x" });
  });

  it("is fresh when asked for, whatever an earlier run left", async () => {
    const path = await checkout();
    const dir = await freshScratch(paths, path);
    await writeFile(join(dir, "cdk.out1234"), "left behind");
    expect(await readdir(await freshScratch(paths, path))).toEqual([]);
  });

  it("is kept by ensure, for an agent resumed in the same checkout", async () => {
    const path = await checkout();
    const dir = await freshScratch(paths, path);
    await writeFile(join(dir, "mine"), "x");
    expect(await readdir(await ensureScratch(paths, path))).toEqual(["mine"]);
  });

  it("goes when discarded, removed as the checkout's worker first when there is one", async () => {
    const path = await checkout();
    await writeFile(join(await freshScratch(paths, path), "f"), "x");
    const asked: StepInvocation[] = [];
    await discardScratch(paths, path, (invocation) => {
      asked.push(invocation);
      return invocation;
    });
    expect(existsSync(scratchOf(paths, path))).toBe(false);
    expect(asked.map((invocation) => [invocation.file, ...invocation.args])).toEqual([
      ["rm", "-rf", scratchOf(paths, path)],
    ]);
    // Discarding what is not there is not a failure.
    await expect(discardScratch(paths, path)).resolves.toBeUndefined();
  });
});
