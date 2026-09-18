/**
 * Where the deployed control plane is, discovered rather than configured.
 *
 * Every endpoint, table, bucket and client id comes from CloudFormation outputs,
 * so no script carries a copy of a value that CDK generated. Shared by the smoke
 * suite and the operator bootstrap; both also re-assert the account, because the
 * `npm` script's guard protects the script and this protects the SDK calls
 * (A-17).
 *
 * Nothing here reads a secret. The machine client's secret is fetched separately,
 * held for one token request, and never stored.
 */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/** The one account v1 may touch (A-17). */
export const EXPECTED_ACCOUNT = "755348349819";
export const REGION = "us-west-2";

export interface StackEnvironment {
  readonly stage: string;
  readonly callerArn: string;
  readonly apiEndpoint: string;
  /**
   * `https://api.<stage>.nightshift.wildorder.dev` (D-P3-18), the hostname a CLI
   * stores. `undefined` when the API stack was deployed in `zone-only` mode.
   */
  readonly apiCustomEndpoint: string | undefined;
  readonly tableName: string;
  readonly bucketName: string;
  readonly userPoolId: string;
  readonly interactiveClientId: string;
  readonly machineClientId: string;
  readonly tokenEndpoint: string;
  readonly machineScope: string;
  /** The Cognito hosted domain, without a scheme: `<prefix>.auth.<region>.amazoncognito.com`. */
  readonly authDomain: string;
  /** The complete hosted sign-in URL, client id included (D-P3-16). */
  readonly hostedSignInUrl: string;
  /**
   * The KMS key that signs execution tokens (P4, D-P4-03). The id is enough to
   * call `kms:GetPublicKey`, which is how the smoke suite verifies a minted
   * token against the deployed key's public half.
   */
  readonly executionTokenKeyId: string;
}

interface OutputReader {
  (key: string): string;
  /** The output's value, or `undefined` when the stack has no such output. */
  readonly optional: (key: string) => string | undefined;
}

const stackOutputs = async (
  cfn: CloudFormationClient,
  stackName: string,
): Promise<OutputReader> => {
  const described = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = described.Stacks?.[0];
  if (stack === undefined) {
    throw new Error(`stack ${stackName} does not exist; deploy first with npm run deploy`);
  }
  const outputs = new Map<string, string>();
  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
      outputs.set(output.OutputKey, output.OutputValue);
    }
  }
  const read = (key: string): string => {
    const value = outputs.get(key);
    if (value === undefined) {
      throw new Error(`stack ${stackName} has no output ${key}; was it deployed from this branch?`);
    }
    return value;
  };
  return Object.assign(read, { optional: (key: string) => outputs.get(key) });
};

/** Refuses to continue against any account but the one v1 owns. Returns the caller's ARN. */
export const assertExpectedAccount = async (): Promise<string> => {
  const identity = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== EXPECTED_ACCOUNT) {
    throw new Error(
      `credentials resolve to account ${identity.Account}, not ${EXPECTED_ACCOUNT}; ` +
        "refusing to touch any other account (A-17)",
    );
  }
  return identity.Arn ?? "unknown";
};

export const loadStackEnvironment = async (
  stage = process.env.NIGHTSHIFT_STAGE ?? "dev",
): Promise<StackEnvironment> => {
  const callerArn = await assertExpectedAccount();
  const cfn = new CloudFormationClient({ region: REGION });
  const data = await stackOutputs(cfn, `nightshift-${stage}-data`);
  const api = await stackOutputs(cfn, `nightshift-${stage}-api`);
  return {
    stage,
    callerArn,
    apiEndpoint: api("ApiEndpoint"),
    apiCustomEndpoint: api.optional("ApiCustomEndpoint"),
    tableName: data("TableName"),
    bucketName: data("BucketName"),
    userPoolId: data("UserPoolId"),
    interactiveClientId: data("InteractiveClientId"),
    machineClientId: data("MachineClientId"),
    tokenEndpoint: data("TokenEndpoint"),
    machineScope: data("MachineScope"),
    authDomain: data("AuthDomain"),
    hostedSignInUrl: data("HostedSignInUrl"),
    executionTokenKeyId: data("ExecutionTokenKeyId"),
  };
};
