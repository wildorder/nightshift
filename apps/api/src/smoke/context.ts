/**
 * Where the smoke suite runs, and as whom (T7).
 *
 * Everything is discovered from the deployed stacks rather than configured. The
 * discovery itself moved to `../aws/stack-outputs.ts` in P3 (T2) so the operator
 * bootstrap reads the same outputs through the same code; this module keeps the
 * suite's own vocabulary and the token handling.
 */
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  EXPECTED_ACCOUNT,
  loadStackEnvironment,
  REGION,
  type StackEnvironment,
} from "../aws/stack-outputs.js";

export { EXPECTED_ACCOUNT, REGION };

/** The smoke suite's view of the environment. Every field the P2 suite named. */
export type SmokeContext = StackEnvironment;

export const loadSmokeContext = (stage?: string): Promise<SmokeContext> =>
  stage === undefined ? loadStackEnvironment() : loadStackEnvironment(stage);

/**
 * A client-credentials access token for a machine app client (T9).
 *
 * Never an interactive login: an interactive user cannot obtain a token without
 * a browser (P3 §13.4), which is the whole reason D-P4-07 adds a **second**
 * machine client — a live isolation proof needs two principals and a human
 * typing two passwords is not a suite.
 */
export const fetchMachineToken = async (
  context: SmokeContext,
  clientId: string = context.machineClientId,
): Promise<string> => {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const described = await cognito.send(
    new DescribeUserPoolClientCommand({
      UserPoolId: context.userPoolId,
      ClientId: clientId,
    }),
  );
  const secret = described.UserPoolClient?.ClientSecret;
  if (secret === undefined) throw new Error(`app client ${clientId} has no secret`);

  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
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
