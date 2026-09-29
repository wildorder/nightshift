/**
 * `nightshift local` and `nightshift use` (P12, D-P12-01, D-P12-05), over an
 * injected launcher: the real bin is started end to end by `local:e2e`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentStage, readProfile, writeProfile } from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import type { CliEnvironment, Launch } from "../environment.js";
import { UsageError } from "../failures.js";
import { READY_LINE, runLocal, useStage } from "./local.js";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const environmentWith = (launch: Launch | undefined, out: string[], opened: string[]) => {
  const bin = join(dir, "nightshift-local.js");
  writeFileSync(bin, "");
  return {
    out: (line: string) => void out.push(line),
    err: (line: string) => void out.push(`err: ${line}`),
    cwd: dir,
    paths: { env: { NIGHTSHIFT_CONFIG_DIR: join(dir, "config") } },
    openBrowser: async (url: string) => {
      opened.push(url);
      return true;
    },
    ...(launch === undefined ? {} : { launch }),
    assets: { skillsDir: dir, mcpServerPath: dir, localPath: bin },
  } as unknown as CliEnvironment;
};

describe("nightshift local", () => {
  it("writes the local profile when the plane is ready, selects it, and opens the Studio", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-local-cli-"));
    const out: string[] = [];
    const opened: string[] = [];
    let args: readonly string[] = [];
    const launch: Launch = async (_file, a, onLine) => {
      args = a;
      await onLine("booting");
      await onLine(
        [
          READY_LINE,
          "http://127.0.0.1:47820/api",
          "http://127.0.0.1:47820/#token=s",
          "/state/token",
        ].join("\t"),
      );
      return 0;
    };
    const environment = environmentWith(launch, out, opened);
    expect(await runLocal(environment, { port: "47820", open: true })).toBe(0);
    expect(args).toContain("--no-warnings=ExperimentalWarning");
    expect(args).toEqual(expect.arrayContaining(["--port", "47820"]));
    expect(currentStage(environment.paths)).toBe("local");
    expect(await readProfile(environment.paths)).toEqual({
      apiEndpoint: "http://127.0.0.1:47820/api",
      stage: "local",
      auth: "token",
      tokenFile: "/state/token",
    });
    expect(opened).toEqual(["http://127.0.0.1:47820/#token=s"]);
    expect(out).toContain("booting");
  });

  it("says so when this build does not carry the local instance", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-local-cli-"));
    await expect(
      runLocal(environmentWith(undefined, [], []), { open: false }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("nightshift use", () => {
  it("switches to a stage with a profile, and refuses one without", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-local-cli-"));
    const out: string[] = [];
    const environment = environmentWith(undefined, out, []);
    await writeProfile(
      { apiEndpoint: "https://api.dev.example", authDomain: "a", clientId: "c", stage: "dev" },
      environment.paths,
    );
    await writeProfile(
      { apiEndpoint: "http://127.0.0.1:1/api", stage: "local", auth: "token", tokenFile: "/t" },
      environment.paths,
    );
    expect(await useStage(environment, "dev")).toBe(0);
    expect(currentStage(environment.paths)).toBe("dev");
    expect(out.at(-1)).toContain("using dev");
    await expect(useStage(environment, "prod")).rejects.toThrow(/no profile for stage/);
  });
});

describe("nightshift login and the local stage", () => {
  it("refuses to sign in to the local stage, and does not take a local profile's stage as the default", async () => {
    const { resolveProfile, DEFAULT_STAGE } = await import("./login.js");
    expect(() => resolveProfile({ stage: "local" }, undefined)).toThrow(/no sign-in/);
    const fromLocal = resolveProfile(
      { clientId: "c" },
      { apiEndpoint: "http://127.0.0.1:1/api", stage: "local", auth: "token", tokenFile: "/t" },
    );
    expect(fromLocal.profile.stage).toBe(DEFAULT_STAGE);
  });
});
