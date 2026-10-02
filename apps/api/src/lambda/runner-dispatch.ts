/**
 * The dispatch Lambda (P10, D-P10-18): invoked by the API when a dispatch is
 * accepted or resumed, and by the reconciler for a replacement. Takes the
 * dispatch from `requested` (or a fresh `provisioning`) to a machine with its
 * workspace volume, a first token in SSM, and a record that names them.
 *
 * Composition only: the logic is `runner/provision.ts`, held to the offline
 * suite over fakes.
 */
import { EC2Client } from "@aws-sdk/client-ec2";
import { KMSClient } from "@aws-sdk/client-kms";
import { SSMClient } from "@aws-sdk/client-ssm";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import { systemClock } from "@nightshift/core";
import { createAwsClients, createAwsStores } from "@nightshift/persistence/aws";
import { createEc2Compute, createSsmFirstTokens } from "../aws/ec2-compute.js";
import { loadConfig, loadRunnerConfig, loadTokenConfig } from "../config.js";
import { type ProvisionOutcome, provisionDispatch } from "../runner/provision.js";
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
const tokens = createSsmFirstTokens(new SSMClient({}));
const signer = createKmsExecutionTokenSigner({
  kms: new KMSClient({}),
  keyId: tokenConfig.executionTokenKeyId,
});

export interface DispatchEvent {
  readonly projectId: string;
  readonly programId: string;
  readonly runId: string;
}

export const handler = async (event: DispatchEvent): Promise<ProvisionOutcome> => {
  const scope = {
    projectId: ProjectIdSchema.parse(event.projectId),
    programId: ProgramIdSchema.parse(event.programId),
    runId: RunIdSchema.parse(event.runId),
  };
  const outcome = await provisionDispatch(
    {
      stores,
      compute,
      tokens,
      signer,
      clock: systemClock,
      stage: config.stage,
      apiEndpoint: runner.apiEndpoint,
      issuer: tokenConfig.tokenIssuer,
      imageVersion: runner.imageVersion,
      subnetIds: runner.subnetIds,
    },
    scope,
  );
  console.warn(
    `dispatch ${scope.runId}: ${outcome.kind}${"reason" in outcome ? ` (${outcome.reason})` : ""}`,
  );
  return outcome;
};
