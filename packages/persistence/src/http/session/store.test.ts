import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rejectionOf } from "@nightshift/core";
import { afterEach, describe, expect, it } from "vitest";
import { credentialsPath, type PathEnvironment, profilePath } from "./paths.js";
import {
  type Credentials,
  deleteCredentials,
  NotLoggedInError,
  type Profile,
  readCredentials,
  readProfile,
  requireCredentials,
  requireProfile,
  writeCredentials,
  writeProfile,
} from "./store.js";

const PROFILE: Profile = {
  apiEndpoint: "https://4xnsx809u6.execute-api.us-west-2.amazonaws.com",
  authDomain: "nightshift-dev-755348349819.auth.us-west-2.amazoncognito.com",
  clientId: "hs42ak267ticrk2calntvc7a9",
  stage: "dev",
};

const CREDENTIALS: Credentials = {
  refreshToken: "a-refresh-token-nobody-should-ever-see",
  subject: "58819310-5081-70f2-81fe-66601586db46",
  clientId: PROFILE.clientId,
  obtainedAt: "2026-09-15T12:00:00.000Z",
};

const made: string[] = [];

const freshConfigDir = async (): Promise<PathEnvironment> => {
  const dir = await mkdtemp(join(tmpdir(), "nightshift-session-"));
  made.push(dir);
  return { env: { NIGHTSHIFT_CONFIG_DIR: join(dir, "config") } };
};

afterEach(() => {
  made.length = 0;
});

describe("the profile", () => {
  it("round trips", async () => {
    const at = await freshConfigDir();
    await writeProfile(PROFILE, at);
    expect(await readProfile(at)).toEqual(PROFILE);
  });

  it("is absent rather than an error before the first login", async () => {
    expect(await readProfile(await freshConfigDir())).toBeUndefined();
  });

  it("says plainly what to do when something requires one", async () => {
    const at = await freshConfigDir();
    await expect(requireProfile(at)).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(requireProfile(at)).rejects.toThrow(/nightshift login/);
  });

  it("refuses a file that is not a profile, rather than half-reading it", async () => {
    const at = await freshConfigDir();
    await writeProfile(PROFILE, at);
    await writeFile(profilePath(at), JSON.stringify({ apiEndpoint: "" }), "utf8");
    await expect(readProfile(at)).rejects.toThrow();
  });

  it("creates the config directory when it does not exist", async () => {
    const at = await freshConfigDir();
    await writeProfile(PROFILE, at);
    expect((await stat(profilePath(at))).isFile()).toBe(true);
  });
});

describe("the credentials", () => {
  it("round trips", async () => {
    const at = await freshConfigDir();
    await writeCredentials(CREDENTIALS, at);
    expect(await readCredentials(at)).toEqual(CREDENTIALS);
  });

  /**
   * The one secret Nightshift keeps on a developer's machine. Owner-only, and
   * still owner-only after a second login rewrites it — `writeFile`'s `mode`
   * applies only when the file is created.
   */
  it.skipIf(process.platform === "win32")(
    "is readable only by its owner, on the first write and on a rewrite",
    async () => {
      const at = await freshConfigDir();
      await writeCredentials(CREDENTIALS, at);
      expect((await stat(credentialsPath(at))).mode & 0o777).toBe(0o600);

      await writeCredentials({ ...CREDENTIALS, refreshToken: "a-newer-token" }, at);
      expect((await stat(credentialsPath(at))).mode & 0o777).toBe(0o600);
    },
  );

  it("never appears in the error raised when it is missing", async () => {
    const at = await freshConfigDir();
    const failure = await rejectionOf(requireCredentials(at));
    expect(failure).toBeInstanceOf(NotLoggedInError);
    expect(failure.message).not.toContain(CREDENTIALS.refreshToken);
  });

  it("is deleted by logout, and deleting twice is not an error", async () => {
    const at = await freshConfigDir();
    await writeCredentials(CREDENTIALS, at);
    expect(await deleteCredentials(at)).toBe(true);
    expect(await readCredentials(at)).toBeUndefined();
    expect(await deleteCredentials(at)).toBe(false);
  });

  it("leaves the profile alone when the credentials are deleted", async () => {
    const at = await freshConfigDir();
    await writeProfile(PROFILE, at);
    await writeCredentials(CREDENTIALS, at);
    await deleteCredentials(at);
    expect(await readProfile(at)).toEqual(PROFILE);
  });

  it("stores no password: there is none to store", async () => {
    const at = await freshConfigDir();
    await writeCredentials(CREDENTIALS, at);
    const text = await readFile(credentialsPath(at), "utf8");
    expect(text).not.toContain("password");
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      "clientId",
      "obtainedAt",
      "refreshToken",
      "subject",
    ]);
  });
});
