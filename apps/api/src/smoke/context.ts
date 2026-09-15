/**
 * Where the smoke suite runs, and as whom (T7).
 *
 * Everything is discovered from the deployed stacks rather than configured: the
 * API endpoint, table, bucket and user pool come from CloudFormation outputs, and
 * the machine client's secret is read from Cognito at run time. Nothing secret is
 * stored, printed or passed on — the secret lives in memory for one token request.
 */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/** The one account v1 may touch (A-17). Checked again here, not only in the npm script. */
export const EXPECTED_ACCOUNT = "755348349819";
export const REGION = "us-west-2";

export interface SmokeContext {
  readonly stage: string;
  readonly callerArn: string;
  readonly apiEndpoint: string;
  readonly tableName: string;
  readonly bucketName: string;
  readonly userPoolId: string;
  readonly machineClientId: string;
  readonly tokenEndpoint: string;
  readonly machineScope: string;
}

type OutputReader = (key: string) => string;

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
  return (key) => {
    const value = outputs.get(key);
    if (value === undefined) {
      throw new Error(`stack ${stackName} has no output ${key}; was it deployed from this branch?`);
    }
    return value;
  };
};

export const loadSmokeContext = async (
  stage = process.env.NIGHTSHIFT_STAGE ?? "dev",
): Promise<SmokeContext> => {
  const identity = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== EXPECTED_ACCOUNT) {
    throw new Error(
      `credentials resolve to account ${identity.Account}, not ${EXPECTED_ACCOUNT}; ` +
        "refusing to smoke any other account (A-17)",
    );
  }

  const cfn = new CloudFormationClient({ region: REGION });
  const data = await stackOutputs(cfn, `nightshift-${stage}-data`);
  const api = await stackOutputs(cfn, `nightshift-${stage}-api`);
  return {
    stage,
    callerArn: identity.Arn ?? "unknown",
    apiEndpoint: api("ApiEndpoint"),
    tableName: data("TableName"),
    bucketName: data("BucketName"),
    userPoolId: data("UserPoolId"),
    machineClientId: data("MachineClientId"),
    tokenEndpoint: data("TokenEndpoint"),
    machineScope: data("MachineScope"),
  };
};

/**
 * A client-credentials access token for the machine app client (T9). Never an
 * interactive login: that lands with the CLI in P3.
 */
export const fetchMachineToken = async (context: SmokeContext): Promise<string> => {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const described = await cognito.send(
    new DescribeUserPoolClientCommand({
      UserPoolId: context.userPoolId,
      ClientId: context.machineClientId,
    }),
  );
  const secret = described.UserPoolClient?.ClientSecret;
  if (secret === undefined) throw new Error("the machine app client has no secret");

  const basic = Buffer.from(`${context.machineClientId}:${secret}`).toString("base64");
  const response = await fetch(context.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: context.machineScope }),
  });
  if (!response.ok) {
    throw new Error(`the token endpoint answered ${response.status}: ${await response.text()}`);
  }
  const token = ((await response.json()) as { access_token?: unknown }).access_token;
  if (typeof token !== "string") throw new Error("the token endpoint returned no access_token");
  return token;
};

/**
 * A JWT's `sub`, read without verifying the signature. The gateway verifies; the
 * suite only needs to know which principal it is acting as.
 */
export const subjectOf = (token: string): string => {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("not a JWT");
  const sub = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown })
    .sub;
  if (typeof sub !== "string") throw new Error("the token carries no sub claim");
  return sub;
};

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A structurally valid JWT that names the right issuer and client but expired an
 * hour ago and was signed by nothing. The gateway must refuse it; accepting it
 * would mean the authorizer checks shape rather than signature and expiry.
 */
export const forgedExpiredToken = (context: SmokeContext): string => {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: "RS256", kid: "smoke-forged", typ: "JWT" }),
    base64url({
      iss: `https://cognito-idp.${REGION}.amazonaws.com/${context.userPoolId}`,
      sub: context.machineClientId,
      client_id: context.machineClientId,
      token_use: "access",
      scope: context.machineScope,
      iat: now - 7200,
      exp: now - 3600,
    }),
    Buffer.from("not a signature").toString("base64url"),
  ].join(".");
};
