/**
 * Lambda entry point for the control-plane API. The only place the API handler
 * meets the AWS adapters (T4: only `apps/api`'s entry point imports
 * `@nightshift/persistence/aws`).
 *
 * Configuration is read and validated at cold start, so a missing variable fails
 * the first invocation loudly rather than a later request obscurely.
 */
import { KMSClient } from "@aws-sdk/client-kms";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { type RunScope, systemClock } from "@nightshift/core";
import {
  createArtifactDownloadSigner,
  createArtifactUploadSigner,
  createAwsClients,
  createAwsStores,
  createPlanDocumentStore,
} from "@nightshift/persistence/aws";
import { createKmsEnvelope } from "../aws/kms-envelope.js";
import { loadConfig, loadTokenConfig } from "../config.js";
import { createGitHubAppClient, type GitHubAppSecret } from "../github/app.js";
import type { Dispatcher } from "../http.js";
import { createKmsExecutionTokenSigner } from "../tokens/kms.js";
import { createApiLambdaHandler } from "./api-handler.js";

const config = loadConfig(process.env);
/**
 * Read separately from {@link loadConfig}, because only this function signs.
 * The materializer shares `loadConfig` and has neither variable.
 */
const tokenConfig = loadTokenConfig(process.env);
const stores = createAwsStores({
  tableName: config.tableName,
  table: createAwsClients().table,
  ...(config.credentialsTableName === undefined
    ? {}
    : { credentialsTableName: config.credentialsTableName }),
});
/**
 * Signs presigned artifact uploads (T2). A separate S3 client from the one the
 * artifact body store would use, because this one only ever signs: the function
 * holds `s3:PutObject` and makes no S3 call for an artifact at all.
 */
const s3 = new S3Client({});
const uploads = createArtifactUploadSigner({ bucketName: config.bucketName, s3 });
/**
 * Signs presigned artifact downloads (P11, D-P11-06), the same way: a local
 * computation over the role's credentials, no S3 call. The role's `s3:GetObject`
 * on the artifact bodies' prefix is what the signature conveys, and nothing else.
 */
const downloads = createArtifactDownloadSigner({ bucketName: config.bucketName, s3 });

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

/**
 * Seals an org's provider keys (P10, D-P10-23): data keys from `CredentialsKey`
 * with the org and the provider as the context, the one KMS key this function
 * may `GenerateDataKey` and `Decrypt` under. Absent until T2 deploys the key.
 */
const envelope =
  config.credentialsKeyId === undefined
    ? undefined
    : createKmsEnvelope({ kms: new KMSClient({}), keyId: config.credentialsKeyId });

/**
 * The Nightshift GitHub App (P10, D-P10-02): the API verifies an installation,
 * a branch head and mints a machine's read token with it. The secret is read
 * once per cold start and held in memory.
 */
const githubSecret = (() => {
  let cached: Promise<GitHubAppSecret> | undefined;
  return (): Promise<GitHubAppSecret> => {
    cached ??= new SecretsManagerClient({})
      .send(new GetSecretValueCommand({ SecretId: config.githubAppSecret }))
      .then((found) => {
        const parsed = JSON.parse(found.SecretString ?? "{}") as Partial<GitHubAppSecret>;
        if (parsed.appId === undefined || parsed.privateKey === undefined) {
          throw new Error(`secret ${config.githubAppSecret} has no appId or privateKey`);
        }
        return { appId: String(parsed.appId), privateKey: parsed.privateKey };
      });
    return cached;
  };
})();
const github =
  config.githubAppSecret === undefined
    ? undefined
    : createGitHubAppClient({ secret: githubSecret });

/** The dispatch Lambda (D-P10-18), invoked asynchronously: the API records, the function provisions. */
const invoke = async (functionArn: string, payload: unknown): Promise<void> => {
  await new LambdaClient({}).send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
};
const dispatchFunctionArn = config.dispatchFunctionArn;
const publisherFunctionArn = config.publisherFunctionArn;
const dispatcher: Dispatcher | undefined =
  dispatchFunctionArn === undefined
    ? undefined
    : {
        provision: (scope) => invoke(dispatchFunctionArn, scope),
        // The publisher (D-P10-22), when the runner stack exports one.
        ...(publisherFunctionArn === undefined
          ? {}
          : { publish: (scope: RunScope) => invoke(publisherFunctionArn, scope) }),
      };

export const handler = createApiLambdaHandler(() => ({
  stores,
  clock: systemClock,
  uploads,
  downloads,
  plans,
  tokens,
  ...(envelope === undefined ? {} : { envelope }),
  ...(github === undefined ? {} : { github }),
  ...(dispatcher === undefined ? {} : { dispatcher }),
  ...(config.runnerAmiVersion === undefined
    ? {}
    : { runner: { amiVersion: config.runnerAmiVersion } }),
}));
