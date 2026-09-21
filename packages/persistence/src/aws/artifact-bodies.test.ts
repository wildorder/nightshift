import { createHash } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import { createFixtures } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { createArtifactBodyStore, createPlanDocumentStore } from "./artifact-bodies.js";
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
});
