/**
 * The local instance end to end over HTTP (P12, T2; SC-P12-03 … SC-P12-05).
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_PRINCIPAL_PREFIX } from "../testing/local-control-plane.js";
import { tokenPath } from "./credentials.js";
import { type LocalInstance, startLocalInstance } from "./main.js";

let dir = "";
let instance: LocalInstance | undefined;

afterEach(async () => {
  await instance?.close();
  instance = undefined;
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const start = async (studio?: string) => {
  instance = await startLocalInstance({
    port: 0,
    state: join(dir, "state"),
    ...(studio === undefined ? {} : { studio }),
  });
  return instance;
};

const secretOf = (i: LocalInstance) => new URL(i.studioUrl).hash.replace("#token=", "");

const call = (i: LocalInstance, path: string, init: RequestInit = {}, bearer?: string) =>
  fetch(`${i.apiUrl}${path}`, {
    ...init,
    headers: {
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });

describe("the local instance", () => {
  it("refuses a request with no bearer, a wrong one, and a test principal", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-local-"));
    const i = await start();
    expect((await call(i, "/projects")).status).toBe(401);
    expect((await call(i, "/projects", {}, "not-the-secret")).status).toBe(401);
    const forged = `${TEST_PRINCIPAL_PREFIX}${Buffer.from(JSON.stringify({ kind: "user", userId: "someone" })).toString("base64url")}`;
    expect((await call(i, "/projects", {}, forged)).status).toBe(401);
    expect((await call(i, "/projects", {}, secretOf(i))).status).toBe(200);
    if (process.platform !== "win32") {
      expect(statSync(tokenPath(join(dir, "state"))).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the operator, the org, the secret and the records across a restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-local-"));
    const first = await start();
    const secret = secretOf(first);
    const projectId = "proj_01K6AAAAAAAAAAAAAAAAAAAAAA";
    const put = await call(
      first,
      `/projects/${projectId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          schemaVersion: 1,
          projectId,
          name: "yaku",
          createdAt: "2026-09-28T00:00:00.000Z",
        }),
      },
      secret,
    );
    expect(put.status).toBeLessThan(300);
    const listed = (await (await call(first, "/projects", {}, secret)).json()) as {
      items: { orgId: string }[];
    };
    const orgId = listed.items[0]?.orgId;
    await first.close();
    instance = undefined;

    const second = await start();
    expect(secretOf(second)).toBe(secret);
    const again = (await (await call(second, "/projects", {}, secret)).json()) as {
      items: { name: string; orgId: string }[];
    };
    expect(again.items.map((p) => p.name)).toEqual(["yaku"]);
    expect(again.items[0]?.orgId).toBe(orgId);
  });

  it("serves the Studio at the root: files, config.json, and index.html for a page path", async () => {
    dir = mkdtempSync(join(tmpdir(), "nightshift-local-"));
    const studio = join(dir, "studio");
    mkdirSync(join(studio, "assets"), { recursive: true });
    writeFileSync(join(studio, "index.html"), "<!doctype html><title>Nightshift Studio</title>");
    writeFileSync(join(studio, "assets", "app.js"), "console.log(1)");
    const i = await start(studio);
    const origin = new URL(i.apiUrl).origin;
    const config = (await (await fetch(`${origin}/config.json`)).json()) as Record<string, unknown>;
    expect(config).toEqual({ stage: "local", apiEndpoint: i.apiUrl, auth: { kind: "token" } });
    expect(await (await fetch(`${origin}/projects/proj_x`)).text()).toContain("Nightshift Studio");
    expect((await fetch(`${origin}/assets/app.js`)).headers.get("content-type")).toContain(
      "javascript",
    );
    expect((await fetch(`${origin}/../../etc/passwd`)).status).toBe(200); // resolved inside: index.html
    // The API is under /api, so a page path is never an API route.
    expect((await fetch(`${origin}/api/projects`)).status).toBe(401);
  });
});
