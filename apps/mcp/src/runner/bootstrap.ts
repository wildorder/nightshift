/**
 * How a machine learns which run it is, and gets its first token (P10, T2,
 * D-P10-18, D-P10-20).
 *
 * The dispatch Lambda tags the instance with the run's chain, the generation,
 * the stage and the control plane's address, and writes the first engine token
 * to an SSM parameter under the dispatch prefix. The runner reads the tags from
 * the instance metadata (IMDSv2, tokens required; the firewall lets only
 * `engine` reach it), reads the parameter once through the AWS CLI the image
 * carries, deletes it, and holds the token in memory. Nothing of this is on
 * disk afterwards.
 */
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import type { Machine } from "./machine.js";

export const IMDS = "http://169.254.169.254";

/** The tags the dispatch Lambda sets, as the instance metadata spells them. */
export const RUNNER_TAGS = {
  project: "nightshift-project",
  program: "nightshift-program",
  run: "nightshift-run",
  generation: "nightshift-generation",
  stage: "nightshift-stage",
  api: "nightshift-api",
} as const;

export interface RunnerIdentity {
  readonly scope: RunScope;
  readonly generation: number;
  readonly stage: string;
  readonly apiEndpoint: string;
  readonly instanceId: string;
}

/** The parameter the first engine token waits in (the runner stack's `dispatchParameterPrefix`). */
export const firstTokenParameter = (identity: RunnerIdentity): string =>
  `/nightshift/${identity.stage}/dispatch/${identity.scope.runId}/${identity.generation}`;

export class BootstrapError extends Error {
  override readonly name = "BootstrapError";
}

const imdsToken = async (machine: Machine): Promise<string> => {
  const response = await machine.http("PUT", `${IMDS}/latest/api/token`, {
    "X-aws-ec2-metadata-token-ttl-seconds": "300",
  });
  if (response.status !== 200) {
    throw new BootstrapError(`IMDSv2 refused a token: HTTP ${response.status}`);
  }
  return response.text.trim();
};

const metadata = async (machine: Machine, token: string, path: string): Promise<string> => {
  const response = await machine.http("GET", `${IMDS}/latest/meta-data/${path}`, {
    "X-aws-ec2-metadata-token": token,
  });
  if (response.status !== 200) {
    throw new BootstrapError(`instance metadata has no ${path}: HTTP ${response.status}`);
  }
  return response.text.trim();
};

/** Who this machine is, from the tags the dispatch Lambda set. */
export const readIdentity = async (machine: Machine): Promise<RunnerIdentity> => {
  const token = await imdsToken(machine);
  const tag = (name: string) => metadata(machine, token, `tags/instance/${name}`);
  const generation = Number.parseInt(await tag(RUNNER_TAGS.generation), 10);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new BootstrapError("the generation tag is not a positive integer");
  }
  return {
    scope: {
      projectId: ProjectIdSchema.parse(await tag(RUNNER_TAGS.project)),
      programId: ProgramIdSchema.parse(await tag(RUNNER_TAGS.program)),
      runId: RunIdSchema.parse(await tag(RUNNER_TAGS.run)),
    },
    generation,
    stage: await tag(RUNNER_TAGS.stage),
    apiEndpoint: await tag(RUNNER_TAGS.api),
    instanceId: await metadata(machine, token, "instance-id"),
  };
};

/**
 * The first engine token: read once, deleted at once. A machine that boots
 * again (a reboot, not a replacement) finds no parameter and must not start:
 * the reconciler will have replaced it, and a second engine for one run is the
 * one thing D-P10-18 forbids.
 */
export const takeFirstToken = async (
  machine: Machine,
  identity: RunnerIdentity,
): Promise<string> => {
  const name = firstTokenParameter(identity);
  const read = await machine.exec("aws", [
    "ssm",
    "get-parameter",
    "--name",
    name,
    "--with-decryption",
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ]);
  if (read.exitCode !== 0) {
    throw new BootstrapError(
      `no first token at ${name}: ${read.stderr.trim() || `aws exited ${read.exitCode}`}. ` +
        "A machine that finds none has been replaced, or was never dispatched, and does not start.",
    );
  }
  const token = read.stdout.trim();
  if (token.length === 0) throw new BootstrapError(`the parameter at ${name} is empty`);
  const deleted = await machine.exec("aws", ["ssm", "delete-parameter", "--name", name]);
  if (deleted.exitCode !== 0) {
    throw new BootstrapError(
      `could not delete the first token at ${name}: ${deleted.stderr.trim()}. ` +
        "A token that stays readable is one a second process could take; the runner stops.",
    );
  }
  return token;
};
