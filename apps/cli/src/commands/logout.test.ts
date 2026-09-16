import { readFile } from "node:fs/promises";
import { credentialsPath, profilePath } from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import type { TestEnvironment } from "../testing/harness.js";
import {
  createFakeFetch,
  createTestEnvironment,
  signIn,
  TEST_AUTH_DOMAIN,
  TEST_CLIENT_ID,
  TEST_REFRESH_TOKEN,
} from "../testing/harness.js";
import { logout } from "./logout.js";

const live: TestEnvironment[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
});

describe("nightshift logout", () => {
  it("deletes the credentials file and says the token was revoked", async () => {
    const fake = createFakeFetch(() => ({ status: 200, body: "" }));
    const created = await createTestEnvironment({ fetch: fake.fetch });
    live.push(created);
    await signIn(created.environment);

    const result = await logout(created.environment, { revoke: true });

    expect(result).toEqual({ deleted: true, revoked: true, detail: "revoked at Cognito" });
    await expect(readFile(credentialsPath(created.environment.paths), "utf8")).rejects.toThrow();
    expect(created.out.join("\n")).toContain("revoked at Cognito");
    expect(fake.requests[0]?.url).toBe(`https://${TEST_AUTH_DOMAIN}/oauth2/revoke`);
    expect(fake.form(fake.requests[0] as never)).toEqual({
      token: TEST_REFRESH_TOKEN,
      client_id: TEST_CLIENT_ID,
    });
  });

  it("leaves the profile alone, so the next login needs no flags", async () => {
    const created = await createTestEnvironment({
      fetch: createFakeFetch(() => ({ status: 200, body: "" })).fetch,
    });
    live.push(created);
    await signIn(created.environment);

    await logout(created.environment, { revoke: true });

    await expect(readFile(profilePath(created.environment.paths), "utf8")).resolves.toContain(
      TEST_CLIENT_ID,
    );
  });

  it("says plainly when the token was NOT revoked, and deletes it anyway", async () => {
    const created = await createTestEnvironment({
      fetch: createFakeFetch(() => ({
        status: 400,
        body: JSON.stringify({ error: "unsupported_token_type" }),
      })).fetch,
    });
    live.push(created);
    await signIn(created.environment);

    const result = await logout(created.environment, { revoke: true });

    expect(result.deleted).toBe(true);
    expect(result.revoked).toBe(false);
    const printed = created.out.join("\n");
    expect(printed).toContain("NOT revoked");
    expect(printed).toContain("unsupported_token_type");
    // The honest consequence, stated rather than glossed over.
    expect(printed).toContain("remains valid until it expires");
    await expect(readFile(credentialsPath(created.environment.paths), "utf8")).rejects.toThrow();
  });

  it("deletes the file without a network call when revocation is declined", async () => {
    const fake = createFakeFetch(() => ({ status: 200, body: "" }));
    const created = await createTestEnvironment({ fetch: fake.fetch });
    live.push(created);
    await signIn(created.environment);

    const result = await logout(created.environment, { revoke: false });

    expect(fake.requests).toHaveLength(0);
    expect(result.deleted).toBe(true);
    expect(result.detail).toContain("--no-revoke");
  });

  it("still deletes the file when the revocation endpoint is unreachable", async () => {
    const created = await createTestEnvironment({
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    live.push(created);
    await signIn(created.environment);

    const result = await logout(created.environment, { revoke: true });

    expect(result.deleted).toBe(true);
    expect(result.revoked).toBe(false);
    await expect(readFile(credentialsPath(created.environment.paths), "utf8")).rejects.toThrow();
  });

  it("is not an error when there was nothing to sign out of", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    const result = await logout(created.environment, { revoke: true });

    expect(result).toMatchObject({ deleted: false, revoked: false });
    expect(created.out.join("\n")).toContain("no credentials to delete");
  });

  it("never prints the token it deleted", async () => {
    const created = await createTestEnvironment({
      fetch: createFakeFetch(() => ({ status: 500, body: `oops ${TEST_REFRESH_TOKEN}` })).fetch,
    });
    live.push(created);
    await signIn(created.environment);

    const result = await logout(created.environment, { revoke: true });

    expect(created.out.join("\n")).not.toContain(TEST_REFRESH_TOKEN);
    expect(result.detail).not.toContain(TEST_REFRESH_TOKEN);
  });
});
