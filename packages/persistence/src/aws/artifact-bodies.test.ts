import { createHash } from "node:crypto";
import { createFixtures } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { createArtifactBodyStore } from "./artifact-bodies.js";
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
