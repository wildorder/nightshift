/**
 * The reconciler (P10, D-P10-18, D-P10-15): every minute, for every dispatch
 * that owes it something.
 *
 * T3: a `requested` dispatch the API's invocation never reached is provisioned;
 * a `stopping` one whose runner went quiet is terminated; a `stopped` one has
 * its volume snapshotted into the project's warm cache and deleted. T6 adds the
 * lease, the ceilings, the replacement and the orphan sweep.
 *
 * Composition only: the rules are `runner/provision.ts` and `runner/cleanup.ts`.
 */
import { EC2Client } from "@aws-sdk/client-ec2";
import { KMSClient } from "@aws-sdk/client-kms";
import { SSMClient } from "@aws-sdk/client-ssm";
import { systemClock } from "@nightshift/core";
import { createAwsClients, createAwsStores } from "@nightshift/persistence/aws";
import { createEc2Compute, createSsmFirstTokens } from "../aws/ec2-compute.js";
import { loadConfig, loadRunnerConfig, loadTokenConfig } from "../config.js";
import { cleanupStopped, enforceStop } from "../runner/cleanup.js";
import { provisionDispatch } from "../runner/provision.js";
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
const cleanup = { stores, compute, clock: systemClock, stage: config.stage };
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
};

/** A `requested` dispatch older than this was not picked up by the API's invocation. */
const REQUESTED_GRACE_MS = 2 * 60_000;

export const handler = async (): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  const count = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const live = await stores.dispatches.listByStatus([
    "requested",
    "provisioning",
    "stopping",
    "stopped",
    "failed",
  ]);
  for (const dispatch of live) {
    const scope = {
      projectId: dispatch.projectId,
      programId: dispatch.programId,
      runId: dispatch.runId,
    };
    try {
      if (
        (dispatch.status === "requested" &&
          Date.now() - Date.parse(dispatch.updatedAt) > REQUESTED_GRACE_MS) ||
        (dispatch.status === "provisioning" && dispatch.instanceId === undefined)
      ) {
        count(`provision:${(await provisionDispatch(provision, scope)).kind}`);
      } else if (dispatch.status === "stopping") {
        count(`stop:${await enforceStop(cleanup, dispatch)}`);
      } else if (dispatch.status === "stopped" || dispatch.status === "failed") {
        if (!dispatch.cleanup.volumeDeleted)
          count(`cleanup:${await cleanupStopped(cleanup, dispatch)}`);
      }
    } catch (error) {
      count("error");
      console.error(`reconciler: ${dispatch.runId}:`, error);
    }
  }
  console.warn(`reconciler: ${JSON.stringify(counts)}`);
  return counts;
};
