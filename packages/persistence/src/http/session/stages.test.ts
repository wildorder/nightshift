/**
 * One profile per stage (P12, D-P12-05): selection, the flat-file migration,
 * and the token provider for a local instance.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialsPath, currentStage, knownStages, profilePath, selectStage } from "./paths.js";
import { readCredentials, readProfile, writeProfile } from "./store.js";
import { createTokenProvider } from "./tokens.js";

let dir = "";
const env = () => ({ env: { NIGHTSHIFT_CONFIG_DIR: dir } });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cognito = {
  apiEndpoint: "https://api.dev.example",
  authDomain: "auth.example",
  clientId: "c1",
  stage: "dev",
};

describe("profiles per stage", () => {
  it("writes a stage's profile under its own directory and selects it", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-stages-"));
    expect(currentStage(env())).toBeUndefined();
    await writeProfile(cognito, env());
    expect(currentStage(env())).toBe("dev");
    expect(profilePath(env())).toBe(join(dir, "profiles", "dev", "profile.json"));

    await writeProfile(
      { apiEndpoint: "http://127.0.0.1:47820/api", stage: "local", auth: "token", tokenFile: "/t" },
      env(),
    );
    expect(currentStage(env())).toBe("local");
    expect(knownStages(env())).toEqual(["dev", "local"]);
    // The hosted profile is untouched, and switching back is one call.
    selectStage("dev", env());
    expect((await readProfile(env()))?.stage).toBe("dev");
    expect((await readProfile(env(), "local"))?.stage).toBe("local");
  });

  it("moves a pre-P12 flat profile and its credentials under the stage, once, keeping the sign-in", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-stages-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.json"), JSON.stringify(cognito));
    const credentials = {
      refreshToken: "R",
      subject: "s",
      clientId: "c1",
      obtainedAt: "2026-09-28T00:00:00.000Z",
    };
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(credentials));

    expect(currentStage(env())).toBe("dev");
    expect(existsSync(join(dir, "profile.json"))).toBe(false);
    expect(readFileSync(join(dir, "profiles", "dev", "profile.json"), "utf8")).toContain(
      "auth.example",
    );
    expect((await readCredentials(env()))?.refreshToken).toBe("R");
    expect(credentialsPath(env())).toBe(join(dir, "profiles", "dev", "credentials.json"));
  });

  it("refuses a stage name that is not one", () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-stages-"));
    expect(() => selectStage("../etc", env())).toThrow(/not a stage name/);
  });

  it("gives a local instance's token as the bearer, read from its file each time", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-stages-"));
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "first\n");
    const provider = createTokenProvider({
      profile: { apiEndpoint: "http://x/api", stage: "local", auth: "token", tokenFile },
    });
    expect(await provider.idToken()).toBe("first");
    writeFileSync(tokenFile, "second\n");
    expect(await provider.idToken()).toBe("second");
    rmSync(tokenFile);
    await expect(provider.idToken()).rejects.toThrow(/nightshift local/);
  });
});
