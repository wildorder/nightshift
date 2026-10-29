/**
 * The reconciler (P10, D-P10-18, D-P10-15): every minute, for every dispatch
 * that owes it something.
 *
 * T3: a `requested` dispatch the API's invocation never reached is provisioned;
 * a `stopping` one whose runner went quiet is terminated; a `stopped` one has
 * its volume snapshotted into the project's warm cache and deleted. T6: a live
 * one whose lease lapsed is terminated and replaced on its volume, generation
 * plus one, until the attempts run out. And any dispatch, live or settled,
 * that still holds a pending publication intent has the publisher asked again:
 * a push that failed for a passing reason is retried, and the last landing of a
 * run is never left waiting for a next one that will not come (2026-10-14).
 * Lines with work and no live run have one started (Pipkin).
 *
 * Composition only: the rules are `runner/reconcile.ts`.
 */
import { EC2Client } from "@aws-sdk/client-ec2";
import { KMSClient } from "@aws-sdk/client-kms";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { systemClock } from "@nightshift/core";
import { createAwsClients, createAwsStores } from "@nightshift/persistence/aws";
import { createEc2Compute, createSsmFirstTokens } from "../aws/ec2-compute.js";
import { loadConfig, loadRunnerConfig, loadTokenConfig } from "../config.js";
import { createGitHubAppClient, type GitHubAppSecret } from "../github/app.js";
import type { ApiDeps } from "../http.js";
import { provisionDispatch } from "../runner/provision.js";
import { type PublisherRequest, reconcile } from "../runner/reconcile.js";
import { createKmsExecutionTokenSigner } from "../tokens/kms.js";

const config = loadConfig(process.env);
const tokenConfig = loadTokenConfig(process.env);
const runner = loadRunnerConfig(process.env);
const stores = createAwsStores({ tableName: config.tableName, table: createAwsClients().table });
const compute = createEc2Compute({
  ec2: new EC2Client({}),
  launchTemplateId: runner.launchTemplateId,
  imageVersionTag: "nightshift:amiVersion",
});
const provision = {
  stores,
  compute,
  tokens: createSsmFirstTokens(new SSMClient({})),
  signer: createKmsExecutionTokenSigner({
    kms: new KMSClient({}),
    keyId: tokenConfig.executionTokenKeyId,
  }),
  clock: systemClock,
  stage: config.stage,
  apiEndpoint: runner.apiEndpoint,
  issuer: tokenConfig.tokenIssuer,
  imageVersion: runner.imageVersion,
  subnetIds: runner.subnetIds,
  subnetZones: runner.subnetZones,
};

const publisherFunctionArn = config.publisherFunctionArn;
const lambda = new LambdaClient({});
/** The publisher, asked asynchronously, as the API asks it when an intent is recorded. */
const askPublisher = async (request: PublisherRequest): Promise<void> => {
  if (publisherFunctionArn === undefined) return;
  await lambda.send(
    new InvokeCommand({
      FunctionName: publisherFunctionArn,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(request)),
    }),
  );
};

/**
 * What a line run is started through (`startLineRun`): the same admission as a
 * dispatch. It needs the GitHub App to verify the line's base, which this
 * function reads only where the secret is named; without it the start is
 * refused as `github_unavailable` and counted as an error.
 */
const githubSecretName = config.githubAppSecret;
const github =
  githubSecretName === undefined
    ? undefined
    : createGitHubAppClient({
        secret: async (): Promise<GitHubAppSecret> => {
          const found = await new SecretsManagerClient({}).send(
            new GetSecretValueCommand({ SecretId: githubSecretName }),
          );
          const parsed = JSON.parse(found.SecretString ?? "{}") as Partial<GitHubAppSecret>;
          if (parsed.appId === undefined || parsed.privateKey === undefined) {
            throw new Error(`secret ${githubSecretName} has no appId or privateKey`);
          }
          return { appId: String(parsed.appId), privateKey: parsed.privateKey };
        },
      });
const plane: ApiDeps = {
  stores,
  clock: systemClock,
  ...(github === undefined ? {} : { github }),
  runner: { amiVersion: runner.imageVersion },
  // The reconciler holds what provisioning needs, so it provisions the run it starts itself.
  dispatcher: {
    provision: async (scope) => {
      await provisionDispatch(provision, scope);
    },
  },
};

export const handler = async (): Promise<Record<string, number>> => {
  const counts = await reconcile({
    provision,
    plane,
    askPublisher,
  });
  console.warn(`reconciler: ${JSON.stringify(counts)}`);
  return counts;
};
