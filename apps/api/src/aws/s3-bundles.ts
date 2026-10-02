/**
 * The packs the engine uploaded, read back by the publisher (P10, D-P10-22).
 */
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { BundleStore } from "../runner/publisher.js";

export const createS3BundleStore = (s3: S3Client, bucket: string): BundleStore => ({
  get: async (key) => {
    const found = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (found.Body === undefined) throw new Error(`bundle ${key} has no body`);
    return new Uint8Array(await found.Body.transformToByteArray());
  },
});
