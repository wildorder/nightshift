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
import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import { systemClock } from "@nightshift/core";
import { createAwsClients, createAwsStores } from "@nightshift/persistence/aws";
import { createS3BundleStore } from "../aws/s3-bundles.js";
import { loadConfig } from "../config.js";
import { createGitHubAppClient, type GitHubAppSecret } from "../github/app.js";
import { publishAll } from "../runner/publisher.js";

const config = loadConfig(process.env);
const stores = createAwsStores({ tableName: config.tableName, table: createAwsClients().table });
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

export interface PublishEvent {
  readonly projectId: string;
  readonly programId: string;
  readonly runId: string;
}

export const handler = async (event: PublishEvent): Promise<Record<string, number>> => {
  const scope = {
    projectId: ProjectIdSchema.parse(event.projectId),
    programId: ProgramIdSchema.parse(event.programId),
    runId: RunIdSchema.parse(event.runId),
  };
  const counts = await publishAll(
    {
      stores,
      clock: systemClock,
      github,
      bundles,
      log: (line) => console.warn(`publisher: ${line}`),
    },
    scope,
  );
  console.warn(`publisher ${scope.runId}: ${JSON.stringify(counts)}`);
  return counts;
};
