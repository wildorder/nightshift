import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALL_MARKER,
  lockfileHashes,
  readInstallMarker,
  writeInstallMarker,
} from "./install.js";
import { runCheckoutSteps, runSetupSteps, setupAsStep } from "./setup.js";

/** `node -e` with no double quote inside, so it survives `sh -c` and `cmd /c` alike. */
const nodeCommand = (script: string): string => `"${process.execPath}" -e "${script}"`;
const exitWith = (code: number): string => nodeCommand(`process.exit(${code})`);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ns-setup-"));
  dirs.push(dir);
  return dir;
};

describe("setup", () => {
  it("is recorded under a prefixed id, so it cannot collide with a check", () => {
    expect(setupAsStep({ id: "install", command: "npm ci" })).toEqual({
      id: "setup:install",
      command: "npm ci",
    });
  });

  it("stops at the first step that fails", async () => {
    const results = await runSetupSteps({
      setup: [
        { id: "one", command: exitWith(0) },
        { id: "two", command: exitWith(3) },
        { id: "three", command: exitWith(0) },
      ],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(results.map((result) => [result.stepId, result.exitCode])).toEqual([
      ["setup:one", 0],
      ["setup:two", 3],
    ]);
  });

  it("runs no check when setup fails", async () => {
    const ran = await runCheckoutSteps({
      setup: [{ id: "install", command: exitWith(1) }],
      steps: [{ id: "test", command: exitWith(0) }],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(ran.setupFailed).toBe(true);
    expect(ran.checks).toEqual([]);
  });

  it("runs the checks in the directory setup prepared", async () => {
    const ran = await runCheckoutSteps({
      setup: [{ id: "install", command: nodeCommand("require('fs').writeFileSync('ready','ok')") }],
      steps: [
        {
          id: "ready",
          command: nodeCommand("process.exit(require('fs').existsSync('ready') ? 0 : 1)"),
        },
      ],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(ran.setupFailed).toBe(false);
    expect(ran.checks.map((result) => [result.stepId, result.exitCode])).toEqual([["ready", 0]]);
  });

  it("with no setup, is exactly the checks", async () => {
    const ran = await runCheckoutSteps({
      setup: [],
      steps: [{ id: "test", command: exitWith(0) }],
      cwd: await scratch(),
      timeoutMs: 30_000,
    });
    expect(ran.setup).toEqual([]);
    expect(ran.checks.map((result) => result.exitCode)).toEqual([0]);
  });
});

describe("the install, once per lineage of checkouts (D-P10-24)", () => {
  const LOCK = '{"lockfileVersion":3,"packages":{}}';
  /** `npm ci` here would fail: there is no package.json. Its only way to exit 0 is to be skipped. */
  const install = { id: "install", command: "npm ci --prefer-offline" };
  /** An install-looking command that is harmless when it does run. */
  const harmlessInstall = { id: "install", command: "npm install --version" };
  const text = (result: { output: Uint8Array } | undefined) =>
    new TextDecoder().decode(result?.output ?? new Uint8Array());

  /**
   * A checkout with a lockfile and, when asked, an installed tree the lockfile
   * fits, marked as a passing install marks it.
   */
  const checkout = async (lock: string, withTree: boolean): Promise<string> => {
    const dir = await scratch();
    await writeFile(join(dir, "package-lock.json"), lock, "utf8");
    if (withTree) {
      await mkdir(join(dir, "node_modules", "left-pad"), { recursive: true });
      await writeFile(join(dir, "node_modules", "left-pad", "index.js"), "module.exports=1;\n");
      await writeInstallMarker(dir, await lockfileHashes(dir));
    }
    return dir;
  };

  it("seeds a new checkout from the reference by hardlink and skips the install, recording the skip", async () => {
    const reference = await checkout(LOCK, true);
    const fresh = await checkout(LOCK, false);
    const results = await runSetupSteps({
      setup: [
        install,
        { id: "ready", command: nodeCommand("require('fs').writeFileSync('ready','ok')") },
      ],
      cwd: fresh,
      timeoutMs: 30_000,
      reference,
    });
    expect(results.map((r) => [r.stepId, r.exitCode])).toEqual([
      ["setup:install", 0],
      ["setup:ready", 0],
    ]);
    expect(text(results[0])).toContain("[setup skipped]");
    expect(text(results[0])).toContain("seeded from");
    const seeded = join(fresh, "node_modules", "left-pad", "index.js");
    expect(await readFile(seeded, "utf8")).toBe("module.exports=1;\n");
    // The same file, not a copy.
    const original = join(reference, "node_modules", "left-pad", "index.js");
    expect((await stat(seeded)).ino).toBe((await stat(original)).ino);
    expect(await readInstallMarker(fresh)).toEqual(await lockfileHashes(fresh));
    // Steps that are not installs ran.
    await stat(join(fresh, "ready"));
  });

  it("seeds a workspace's own tree too, where npm keeps a version that conflicts with the hoisted one", async () => {
    const reference = await checkout(LOCK, true);
    // A monorepo: the root tree, a workspace's nested tree, and a workspace link
    // from the root tree back into the workspace (as npm makes, relatively).
    const nested = join(reference, "packages", "marketplace", "node_modules", "tailwindcss");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "index.js"), "module.exports='4';\n");
    await mkdir(join(reference, "packages", "marketplace", "src"), { recursive: true });
    await writeFile(join(reference, "packages", "marketplace", "src", "a.js"), "");
    // Something that looks like a tree but is inside build output is left alone.
    await mkdir(join(reference, "dist", "node_modules", "junk"), { recursive: true });
    const fresh = await checkout(LOCK, false);
    const results = await runSetupSteps({
      setup: [install],
      cwd: fresh,
      timeoutMs: 30_000,
      reference,
    });
    expect(results.map((r) => r.exitCode)).toEqual([0]);
    expect(text(results[0])).toContain("seeded from");
    expect(
      await readFile(
        join(fresh, "packages", "marketplace", "node_modules", "tailwindcss", "index.js"),
        "utf8",
      ),
    ).toBe("module.exports='4';\n");
    expect(await readFile(join(fresh, "node_modules", "left-pad", "index.js"), "utf8")).toBe(
      "module.exports=1;\n",
    );
    await expect(stat(join(fresh, "dist"))).rejects.toThrow();
    // The source files of the workspace are the checkout's business, not the seed's.
    await expect(stat(join(fresh, "packages", "marketplace", "src"))).rejects.toThrow();
  });

  it("installs when the lockfiles differ from the reference's, and marks the tree it made", async () => {
    const reference = await checkout(LOCK, true);
    const changed = await checkout('{"lockfileVersion":3,"packages":{"x":{}}}', false);
    const results = await runSetupSteps({
      setup: [harmlessInstall],
      cwd: changed,
      timeoutMs: 60_000,
      reference,
    });
    expect(results.map((r) => r.exitCode)).toEqual([0]);
    expect(text(results[0])).not.toContain("[setup skipped]");
    expect(await readInstallMarker(changed)).toEqual(await lockfileHashes(changed));

    // Now the tree fits its lockfiles: the next setup skips without a reference.
    const again = await runSetupSteps({ setup: [install], cwd: changed, timeoutMs: 30_000 });
    expect(again.map((r) => r.exitCode)).toEqual([0]);
    expect(text(again[0])).toContain("[setup skipped]");

    // A lockfile edit after that installs again.
    await writeFile(
      join(changed, "package-lock.json"),
      '{"lockfileVersion":3,"packages":{"y":{}}}',
    );
    const afterEdit = await runSetupSteps({
      setup: [harmlessInstall],
      cwd: changed,
      timeoutMs: 60_000,
    });
    expect(text(afterEdit[0])).not.toContain("[setup skipped]");
  });

  it("never skips a tree with no record of what it was installed for, nor one with no reference", async () => {
    const unmarked = await checkout(LOCK, true);
    await rm(join(unmarked, INSTALL_MARKER));
    const results = await runSetupSteps({
      setup: [harmlessInstall],
      cwd: unmarked,
      timeoutMs: 60_000,
    });
    expect(text(results[0])).not.toContain("[setup skipped]");

    const alone = await checkout(LOCK, false);
    const ran = await runSetupSteps({ setup: [harmlessInstall], cwd: alone, timeoutMs: 60_000 });
    expect(text(ran[0])).not.toContain("[setup skipped]");
  });

  it("never seeds from a tree its marker does not vouch for: new lockfiles over an old install", async () => {
    // The reference took a commit that changed the lockfile and its own setup
    // failed: new lockfiles, the old tree, the old marker (P15's arbiter).
    const reference = await checkout(LOCK, true);
    const changed = '{"lockfileVersion":3,"packages":{"":{"name":"changed"}}}';
    await writeFile(join(reference, "package-lock.json"), changed, "utf8");
    const fresh = await checkout(changed, false);
    const results = await runSetupSteps({
      setup: [harmlessInstall],
      cwd: fresh,
      reference,
      timeoutMs: 60_000,
    });
    expect(text(results[0])).not.toContain("seeded from");
    expect(
      await stat(join(fresh, "node_modules", "left-pad")).catch(() => undefined),
    ).toBeUndefined();
    // And the reference's own record is left as it was: nothing vouched for the old tree anew.
    expect(await readInstallMarker(reference)).toEqual({
      "package-lock.json": expect.any(String),
    });
    expect(await readInstallMarker(reference)).not.toEqual(await lockfileHashes(reference));
  });

  it("does not seed from a tree installed by hand, which carries no marker", async () => {
    const reference = await checkout(LOCK, true);
    await rm(join(reference, INSTALL_MARKER));
    const fresh = await checkout(LOCK, false);
    const results = await runSetupSteps({
      setup: [harmlessInstall],
      cwd: fresh,
      reference,
      timeoutMs: 60_000,
    });
    expect(text(results[0])).not.toContain("seeded from");
  });

  it("gives a seeded tree a marker of its own, leaving the reference's untouched", async () => {
    const reference = await checkout(LOCK, true);
    const fresh = await checkout(LOCK, false);
    await runSetupSteps({ setup: [install], cwd: fresh, reference, timeoutMs: 60_000 });
    const mine = await stat(join(fresh, INSTALL_MARKER));
    const theirs = await stat(join(reference, INSTALL_MARKER));
    expect(mine.ino).not.toBe(theirs.ino);
  });

  it("does not seed from a reference with no tree", async () => {
    const treeless = await checkout(LOCK, false);
    const fresh = await checkout(LOCK, false);
    const results = await runSetupSteps({
      setup: [harmlessInstall],
      cwd: fresh,
      timeoutMs: 60_000,
      reference: treeless,
    });
    expect(text(results[0])).not.toContain("[setup skipped]");
  });
});
