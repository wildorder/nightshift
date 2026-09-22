/**
 * Lambda entry point for the control-plane API. The only place the API handler
 * meets the AWS adapters (T4: only `apps/api`'s entry point imports
 * `@nightshift/persistence/aws`).
 *
 * Configuration is read and validated at cold start, so a missing variable fails
 * the first invocation loudly rather than a later request obscurely.
 */
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { systemClock } from "@nightshift/core";
import {
  createArtifactUploadSigner,
  createAwsClients,
  createAwsStores,
  createPlanDocumentStore,
} from "@nightshift/persistence/aws";
import { loadConfig, loadTokenConfig } from "../config.js";
import { createKmsExecutionTokenSigner } from "../tokens/kms.js";
import { createApiLambdaHandler } from "./api-handler.js";

const config = loadConfig(process.env);
/**
 * Read separately from {@link loadConfig}, because only this function signs.
 * The materializer shares `loadConfig` and has neither variable.
 */
const tokenConfig = loadTokenConfig(process.env);
const stores = createAwsStores({ tableName: config.tableName, table: createAwsClients().table });
/**
 * Signs presigned artifact uploads (T2). A separate S3 client from the one the
 * artifact body store would use, because this one only ever signs: the function
 * holds `s3:PutObject` and makes no S3 call for an artifact at all.
 */
const s3 = new S3Client({});
const uploads = createArtifactUploadSigner({ bucketName: config.bucketName, s3 });

/**
 * Ratified plan documents (P7, D-P7-02). The one place this function reads S3:
 * ratification hashes the stored plan rather than trusting the digest it was
 * sent. The role's `s3:GetObject` covers the `plans/` prefix and nothing else.
 */
const plans = createPlanDocumentStore({ bucketName: config.bucketName, s3 });

/**
 * Mints execution tokens (P4, T2, D-P4-03). The function holds `kms:Sign` on one
 * key and the private half never leaves KMS, so this client can sign and can do
 * nothing else with it.
 */
const tokens = {
  signer: createKmsExecutionTokenSigner({
    kms: new KMSClient({}),
    keyId: tokenConfig.executionTokenKeyId,
  }),
  issuer: tokenConfig.tokenIssuer,
};

export const handler = createApiLambdaHandler(() => ({
  stores,
  clock: systemClock,
  uploads,
  plans,
  tokens,
}));
