/**
 * The local control plane (T2 deliverable 5).
 *
 * These tests are about the *fake* half — the injected principal and the in-memory
 * object store — because the real half is the production handler and every other
 * suite in this package already proves it. What matters here is that the fake is
 * faithful: an upload that lies about its type or its size is refused, exactly as
 * S3 would refuse it, so the http adapter cannot ship a mismatch that only
 * production would catch.
 */
import { createHash } from "node:crypto";
import {
  ArtifactUploadResponseSchema,
  type ProjectId,
  ProjectPageSchema,
} from "@nightshift/contracts";
import {
  createFixedClock,
  createFixtures,
  makeMembership,
  makeProgramContract,
  makeProject,
  makeRun,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, describe, expect, it } from "vitest";
import { type LocalControlPlane, startLocalControlPlane } from "./local-control-plane.js";

const NOW = "2026-09-15T12:00:00.000Z";

let plane: LocalControlPlane | undefined;

afterEach(async () => {
  await plane?.close();
  plane = undefined;
});

const start = async () => {
  const stores = createInMemoryStores();
  const f = createFixtures();
  const subject = nextUserId(f);
  const orgId = f.ids.next("org");
  await stores.memberships.put(makeMembership(subject, orgId));
  plane = await startLocalControlPlane({
    stores,
    principal: { kind: "user", userId: subject, activeOrg: orgId },
    clock: createFixedClock(Date.parse(NOW)),
  });
  return { plane, stores, f, orgId };
};

interface Result {
  readonly status: number;
  readonly body: unknown;
}

const send = async (
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Result> => {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body:
      text === ""
        ? undefined
        : ((): unknown => {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          })(),
  };
};

/** A project, a program and a run, so the upload route has something to sign for. */
const seed = async (local: LocalControlPlane, f: ReturnType<typeof createFixtures>) => {
  const project = `${local.url}/projects/${f.scope.projectId}`;
  const program = `${project}/programs/${f.scope.programId}`;
  const run = `${program}/runs/${f.scope.runId}`;
  const { orgId: _orgId, ...projectBody } = makeProject(f);
  expect((await send(project, "PUT", projectBody)).status).toBe(201);
  expect((await send(program, "PUT", makeProgramContract(f))).status).toBe(201);
  expect((await send(run, "PUT", makeRun(f))).status).toBe(201);
  return { project, program, run };
};

describe("the local control plane", () => {
  it("listens on loopback and nowhere else", async () => {
    const { plane: local } = await start();
    expect(local.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("runs the production handler, routing and all", async () => {
    const { plane: local } = await start();
    expect((await send(`${local.url}/nowhere`, "GET")).status).toBe(404);
    expect(
      (await send(`${local.url}/projects/not-an-id`, "GET")).status,
      "the real path parser is in the loop",
    ).toBe(400);
  });

  it("injects the configured principal, so org resolution behaves as it would in AWS", async () => {
    const { plane: local, f } = await start();
    const { orgId: _orgId, ...projectBody } = makeProject(f);
    expect(
      (await send(`${local.url}/projects/${f.scope.projectId}`, "PUT", projectBody)).status,
    ).toBe(201);
    const listed = await send(`${local.url}/projects`, "GET");
    expect(ProjectPageSchema.parse(listed.body).items.map((p) => p.projectId)).toEqual([
      f.scope.projectId as ProjectId,
    ]);
  });

  it("ignores the Authorization header entirely: the gateway is what authenticates", async () => {
    const { plane: local } = await start();
    for (const authorization of ["Bearer nonsense", "", "Basic zzz"]) {
      const result = await send(`${local.url}/projects`, "GET", undefined, { authorization });
      expect(result.status, authorization).toBe(200);
    }
  });

  it("refuses a body that is not JSON before the handler sees it", async () => {
    const { plane: local } = await start();
    const response = await fetch(`${local.url}/projects/proj_00000000000000000000000001`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  describe("presigned uploads, served by the plane itself", () => {
    const signFor = async (run: string, artifactId: string, size: number) => {
      const signed = await send(`${run}/artifacts/${artifactId}/upload-url`, "POST", {
        kind: "verification-log",
        contentType: "text/plain",
        sizeBytes: size,
      });
      expect(signed.status).toBe(200);
      return ArtifactUploadResponseSchema.parse(signed.body);
    };

    it("signs to its own loopback address and holds the bytes it is given", async () => {
      const { plane: local, f } = await start();
      const { run } = await seed(local, f);
      const artifactId = f.ids.next("art");
      const body = "step 1: node --test\nok\n";

      const target = await signFor(run, artifactId, Buffer.byteLength(body));
      expect(target.uploadUrl.startsWith(`${local.url}/`)).toBe(true);

      const uploaded = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body,
      });
      expect(uploaded.status).toBe(200);
      expect(local.bodies.text(target.key)).toBe(body);
      expect(local.bodies.get(target.key)?.contentType).toBe("text/plain");
    });

    it("refuses a URL it never signed", async () => {
      const { plane: local } = await start();
      const response = await fetch(`${local.url}/__local-upload/never-issued`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "x",
      });
      expect(response.status).toBe(403);
    });

    it("refuses a content type that disagrees with the signature", async () => {
      const { plane: local, f } = await start();
      const { run } = await seed(local, f);
      const target = await signFor(run, f.ids.next("art"), 1);
      const response = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "x",
      });
      expect(response.status).toBe(400);
      expect(local.bodies.get(target.key)).toBeUndefined();
    });

    it("refuses a body whose length disagrees with the declared size", async () => {
      const { plane: local, f } = await start();
      const { run } = await seed(local, f);
      const target = await signFor(run, f.ids.next("art"), 3);
      const response = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "far longer than three bytes",
      });
      expect(response.status).toBe(400);
      expect(local.bodies.get(target.key)).toBeUndefined();
    });

    it("refuses anything but a PUT to an upload URL", async () => {
      const { plane: local, f } = await start();
      const { run } = await seed(local, f);
      const target = await signFor(run, f.ids.next("art"), 1);
      expect((await fetch(target.uploadUrl, { method: "GET" })).status).toBe(405);
    });

    it("computes the digest of what it stored, as S3 would", async () => {
      const { plane: local, f } = await start();
      const { run } = await seed(local, f);
      const body = "hello log";
      const target = await signFor(run, f.ids.next("art"), Buffer.byteLength(body));
      await fetch(target.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body,
      });
      expect(local.bodies.get(target.key)?.sha256).toBe(
        createHash("sha256").update(body).digest("hex"),
      );
    });
  });

  it("stops listening once closed", async () => {
    const { plane: local } = await start();
    const url = local.url;
    await local.close();
    plane = undefined;
    await expect(send(`${url}/projects`, "GET")).rejects.toThrow();
  });
});
