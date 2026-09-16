/**
 * Lambda entry point for the control-plane API. The only place the API handler
 * meets the AWS adapters (T4: only `apps/api`'s entry point imports
 * `@nightshift/persistence/aws`).
 *
 * Configuration is read and validated at cold start, so a missing variable fails
 * the first invocation loudly rather than a later request obscurely.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { systemClock } from "@nightshift/core";
import {
  createArtifactUploadSigner,
  createAwsClients,
  createAwsStores,
} from "@nightshift/persistence/aws";
import { loadConfig } from "../config.js";
import { createApiLambdaHandler } from "./api-handler.js";

const config = loadConfig(process.env);
const stores = createAwsStores({ tableName: config.tableName, table: createAwsClients().table });
/**
 * Signs presigned artifact uploads (T2). A separate S3 client from the one the
 * artifact body store would use, because this one only ever signs: the function
 * holds `s3:PutObject` and makes no S3 call at all.
 */
const uploads = createArtifactUploadSigner({
  bucketName: config.bucketName,
  s3: new S3Client({}),
});

export const handler = createApiLambdaHandler(() => ({ stores, clock: systemClock, uploads }));
