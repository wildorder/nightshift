import { createHash } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import { createFixtures, lineBundleObjectKey } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  createArtifactBodyStore,
  createArtifactDownloadSigner,
  createArtifactUploadSigner,
  createPlanDocumentStore,
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
} from "./artifact-bodies.js";
import { FakeObjectStore } from "./testing/fake-objects.js";

describe("artifact bodies (A-08, D-P2-08)", () => {
  it("stores a body under its project, program and run, and reports its digest", async () => {
    const objects = new FakeObjectStore("bucket");
    const store = createArtifactBodyStore({ bucketName: "bucket", objects });
    const f = createFixtures();
    const artifactId = f.ids.next("art");

    const stored = await store.put(f.scope, artifactId, "hello log", "text/plain");

    const key = `${f.scope.projectId}/${f.scope.programId}/${f.scope.runId}/${artifactId}`;
    expect(stored).toEqual({
      uri: `s3://bucket/${key}`,
      key,
      sizeBytes: 9,
      sha256: createHash("sha256").update("hello log").digest("hex"),
    });
    expect(objects.objects.get(key)?.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(await store.get(f.scope, artifactId))).toBe("hello log");
  });

  it("keeps two projects' objects under disjoint prefixes", async () => {
    const store = createArtifactBodyStore({
      bucketName: "bucket",
      objects: new FakeObjectStore("bucket"),
    });
    const a = createFixtures();
    const b = createFixtures();
    const artifactId = a.ids.next("art");
    const inA = await store.put(a.scope, artifactId, "a", "text/plain");
    const inB = await store.put(b.scope, artifactId, "b", "text/plain");

    expect(inA.key.startsWith(`${a.scope.projectId}/`)).toBe(true);
    expect(inB.key.startsWith(`${b.scope.projectId}/`)).toBe(true);
    expect(await store.get(a.scope, a.ids.next("art"))).toBeUndefined();
  });
});

describe("plan documents (P7, D-P7-02)", () => {
  const sha = "c".repeat(64);

  it("signs a program-scoped upload under plans/, with the type and size in the signature", async () => {
    const f = createFixtures();
    const asked: unknown[] = [];
    const store = createPlanDocumentStore({
      bucketName: "bucket",
      s3: {} as S3Client,
      objects: new FakeObjectStore("bucket"),
      sign: async (input) => {
        asked.push(input);
        return "https://signed.invalid/upload";
      },
      now: () => Date.parse("2026-09-21T10:00:00.000Z"),
    });
    const scope = { projectId: f.scope.projectId, programId: f.scope.programId };
    const key = `plans/${scope.projectId}/${scope.programId}/${sha}.md`;

    const target = await store.signUpload({
      scope,
      sha256: sha,
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
    });
    expect(target).toEqual({
      uri: `s3://bucket/${key}`,
      uploadUrl: "https://signed.invalid/upload",
      key,
      contentType: "text/markdown; charset=utf-8",
      expiresAt: "2026-09-21T10:15:00.000Z",
    });
    expect(asked).toEqual([
      {
        bucket: "bucket",
        key,
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 42,
        expiresIn: 900,
      },
    ]);
  });

  it("reads a stored document back with its uri, and nothing when there is none", async () => {
    const f = createFixtures();
    const objects = new FakeObjectStore("bucket");
    const store = createPlanDocumentStore({ bucketName: "bucket", s3: {} as S3Client, objects });
    const scope = { projectId: f.scope.projectId, programId: f.scope.programId };
    expect(await store.get(scope, sha)).toBeUndefined();

    const body = new TextEncoder().encode("# Plan\n");
    const key = `plans/${scope.projectId}/${scope.programId}/${sha}.md`;
    await objects.putObject({
      Bucket: "bucket",
      Key: key,
      Body: body,
      ContentType: "text/markdown; charset=utf-8",
      ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
    });
    expect(await store.get(scope, sha)).toEqual({ uri: `s3://bucket/${key}`, body });
  });

  it("puts a document the plane made under its key, held to its digest", async () => {
    const f = createFixtures();
    const objects = new FakeObjectStore("bucket");
    const store = createPlanDocumentStore({ bucketName: "bucket", s3: {} as S3Client, objects });
    const scope = { projectId: f.scope.projectId, programId: f.scope.programId };
    const body = new TextEncoder().encode("{}\n");
    const digest = createHash("sha256").update(body).digest("hex");
    const key = `plans/${scope.projectId}/${scope.programId}/${digest}.md`;

    expect(await store.put(scope, digest, body, "text/markdown; charset=utf-8")).toEqual({
      uri: `s3://bucket/${key}`,
      body,
    });
    expect(await store.get(scope, digest)).toEqual({ uri: `s3://bucket/${key}`, body });
    await expect(store.put(scope, sha, body, "text/markdown; charset=utf-8")).rejects.toThrow(
      /hashes to/,
    );
  });

  it("reads S3's AccessDenied for a missing key as absent, and rethrows anything else", async () => {
    const f = createFixtures();
    const scope = { projectId: f.scope.projectId, programId: f.scope.programId };
    const failing = (name: string) =>
      createPlanDocumentStore({
        bucketName: "bucket",
        s3: {} as S3Client,
        objects: {
          putObject: async () => undefined,
          getObject: async () => {
            throw Object.assign(new Error(name), { name });
          },
        },
      });
    // Without s3:ListBucket, S3 will not say NoSuchKey.
    expect(await failing("AccessDenied").get(scope, sha)).toBeUndefined();
    await expect(failing("SlowDown").get(scope, sha)).rejects.toThrow("SlowDown");
  });
});

describe("signed downloads (P11, D-P11-06)", () => {
  it("signs a GET of the artifact's own key, for the upload's fifteen minutes", async () => {
    const f = createFixtures();
    const artifactId = f.ids.next("art");
    const asked: unknown[] = [];
    const signer = createArtifactDownloadSigner({
      bucketName: "bucket",
      s3: {} as S3Client,
      sign: async (input) => {
        asked.push(input);
        return "https://signed.invalid/download";
      },
      now: () => Date.parse("2026-09-28T10:00:00.000Z"),
    });

    const target = await signer.sign({ scope: f.scope, artifactId });
    expect(target).toEqual({
      url: "https://signed.invalid/download",
      expiresAt: "2026-09-28T10:15:00.000Z",
    });
    // The key comes from the run scope, never from anything a caller could
    // spell, so a signature can name no object outside the run.
    expect(asked).toEqual([
      {
        bucket: "bucket",
        key: `${f.scope.projectId}/${f.scope.programId}/${f.scope.runId}/${artifactId}`,
        expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      },
    ]);
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(UPLOAD_URL_TTL_SECONDS);
  });
});

describe("signed uploads to a key the caller names (Pipkin M1b)", () => {
  it("signs a line bundle's key with its content type, and no declared size", async () => {
    const f = createFixtures();
    const signed: unknown[] = [];
    const signer = createArtifactUploadSigner({
      bucketName: "bucket",
      s3: {} as S3Client,
      now: () => Date.parse("2026-10-27T10:00:00.000Z"),
      sign: async (input) => {
        signed.push(input);
        return "https://signed.invalid/line";
      },
    });
    const key = lineBundleObjectKey(f.scope.projectId, "nightshift/develop", 3, "pack-1");
    expect(key).toBe(`${f.scope.projectId}/line/nightshift%2Fdevelop/3/pack-1.pack`);
    const target = await signer.signKey?.(key, "application/octet-stream");
    expect(target).toEqual({
      uri: `s3://bucket/${key}`,
      uploadUrl: "https://signed.invalid/line",
      key,
      contentType: "application/octet-stream",
      expiresAt: new Date(
        Date.parse("2026-10-27T10:00:00.000Z") + UPLOAD_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    });
    expect(signed).toEqual([
      {
        bucket: "bucket",
        key,
        contentType: "application/octet-stream",
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      },
    ]);
  });

  it("presigns a real URL that signs the content type and not a length", async () => {
    const signer = createArtifactUploadSigner({
      bucketName: "bucket",
      s3: new (await import("@aws-sdk/client-s3")).S3Client({
        region: "eu-west-1",
        credentials: { accessKeyId: "AKIAFAKE", secretAccessKey: "secret" },
      }),
    });
    const target = await signer.signKey?.("proj/line/b/1/p.pack", "application/octet-stream");
    const url = new URL(target?.uploadUrl ?? "");
    expect(url.pathname).toBe("/proj/line/b/1/p.pack");
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signedHeaders.split(";")).toContain("content-type");
    expect(signedHeaders.split(";")).not.toContain("content-length");
  });
});
