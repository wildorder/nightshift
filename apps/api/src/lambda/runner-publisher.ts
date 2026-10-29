/**
 * The publisher Lambda (P10, D-P10-22): invoked by the API when a publication
 * intent is recorded, it resolves the run's pending intents in order by pushing
 * the program branch at GitHub with a lease at the Git transport. The one
 * holder of the GitHub App's key with write; runs one at a time (reserved
 * concurrency), so no two pushes of one branch race.
 *
 * Composition only: the logic is `runner/publisher.ts`, held to the offline
 * suite over a local git server.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import { systemClock } from "@nightshift/core";
import { createAwsClients, createAwsStores } from "@nightshift/persistence/aws";
import { createDynamoPublishLock } from "../aws/publish-lock.js";
import { createS3BundleStore } from "../aws/s3-bundles.js";
import { loadConfig } from "../config.js";
import { createGitHubAppClient, type GitHubAppSecret } from "../github/app.js";
import type { ApiDeps } from "../http.js";
import { publishAll, publishLine } from "../runner/publisher.js";

const config = loadConfig(process.env);
const table = createAwsClients().table;
const stores = createAwsStores({ tableName: config.tableName, table });
const lock = createDynamoPublishLock(table, config.tableName);
const secretName = config.githubAppSecret;
if (secretName === undefined) {
  throw new Error("the publisher needs NIGHTSHIFT_GITHUB_APP_SECRET");
}
const githubSecret = (() => {
  let cached: Promise<GitHubAppSecret> | undefined;
  return (): Promise<GitHubAppSecret> => {
    cached ??= new SecretsManagerClient({})
      .send(new GetSecretValueCommand({ SecretId: secretName }))
      .then((found) => {
        const parsed = JSON.parse(found.SecretString ?? "{}") as Partial<GitHubAppSecret>;
        if (parsed.appId === undefined || parsed.privateKey === undefined) {
          throw new Error(`secret ${secretName} has no appId or privateKey`);
        }
        return { appId: String(parsed.appId), privateKey: parsed.privateKey };
      });
    return cached;
  };
})();
const github = createGitHubAppClient({ secret: githubSecret });
const bundles = createS3BundleStore(new S3Client({}), config.bucketName);

export interface RunPublishEvent {
  readonly projectId: string;
  readonly programId: string;
  readonly runId: string;
}

/** A run's intents (`RunPublishEvent`), or a line's push. */
export type PublishEvent =
  | RunPublishEvent
  | { readonly kind: "line"; readonly projectId: string; readonly branch: string };

const isLineEvent = (
  event: PublishEvent,
): event is Extract<PublishEvent, { readonly kind: "line" }> =>
  "kind" in event && event.kind === "line";

/**
 * The control plane's wiring a line run is started through (`startLineRun`):
 * the same admission as a dispatch, then the dispatch function invoked
 * asynchronously to provision it.
 */
const plane: ApiDeps = {
  stores,
  clock: systemClock,
  github,
  ...(config.runnerAmiVersion === undefined
    ? {}
    : { runner: { amiVersion: config.runnerAmiVersion } }),
  ...(config.dispatchFunctionArn === undefined
    ? {}
    : {
        dispatcher: {
          provision: async (scope) => {
            await new LambdaClient({}).send(
              new InvokeCommand({
                FunctionName: config.dispatchFunctionArn,
                InvocationType: "Event",
                Payload: Buffer.from(JSON.stringify(scope)),
              }),
            );
          },
        },
      }),
};

export const handler = async (event: PublishEvent): Promise<Record<string, number>> => {
  const deps = {
    stores,
    clock: systemClock,
    github,
    bundles,
    lock,
    plane,
    log: (line: string) => console.warn(`publisher: ${line}`),
  };
  if (isLineEvent(event)) {
    const step = await publishLine(deps, {
      projectId: ProjectIdSchema.parse(event.projectId),
      branch: event.branch,
    });
    console.warn(`publisher line ${event.branch}: ${step}`);
    return { [step]: 1 };
  }
  const scope = {
    projectId: ProjectIdSchema.parse(event.projectId),
    programId: ProgramIdSchema.parse(event.programId),
    runId: RunIdSchema.parse(event.runId),
  };
  const counts = await publishAll(deps, scope);
  console.warn(`publisher ${scope.runId}: ${JSON.stringify(counts)}`);
  return counts;
};
