/**
 * An in-process stand-in for the artifact bucket, **for tests only**. It checks
 * the SHA-256 checksum the way S3 does, so a body and the digest recorded for it
 * cannot disagree here either.
 */
import { createHash } from "node:crypto";
import type { ObjectClient } from "../artifact-bodies.js";

export interface FakeObject {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export class FakeObjectStore implements ObjectClient {
  readonly objects = new Map<string, FakeObject>();

  constructor(private readonly bucketName: string) {}

  async putObject(input: Parameters<ObjectClient["putObject"]>[0]): Promise<void> {
    this.assertBucket(input.Bucket);
    const digest = createHash("sha256").update(input.Body).digest("base64");
    if (digest !== input.ChecksumSHA256) {
      throw Object.assign(new Error("checksum mismatch"), { name: "BadDigest" });
    }
    this.objects.set(input.Key, { body: input.Body.slice(), contentType: input.ContentType });
  }

  async getObject(
    input: Parameters<ObjectClient["getObject"]>[0],
  ): Promise<Uint8Array | undefined> {
    this.assertBucket(input.Bucket);
    return this.objects.get(input.Key)?.body.slice();
  }

  private assertBucket(bucket: string): void {
    if (bucket !== this.bucketName) {
      throw Object.assign(new Error(`no bucket ${bucket}`), { name: "NoSuchBucket" });
    }
  }
}
