/**
 * The data stack's CloudFormation exports.
 *
 * The API stack consumes these by export name rather than by construct reference
 * (T1, T5), so the two stacks deploy and replace independently. Each output's
 * construct id equals its key, so the smoke suite can read `OutputKey` from
 * DescribeStacks with the same vocabulary.
 */
export const DATA_EXPORT_KEYS = [
  "TableName",
  "TableArn",
  "TableStreamArn",
  "BucketName",
  "BucketArn",
  "UserPoolId",
  "UserPoolArn",
  "InteractiveClientId",
  "MachineClientId",
  "TokenEndpoint",
  "MachineScope",
  // P3 (T2, T7): the CLI's interactive login needs the hosted domain, and the
  // operator bootstrap needs the sign-in URL that goes in the invite template.
  "AuthDomain",
  "HostedSignInUrl",
  // P4 (T2): the asymmetric key that signs execution tokens. The API function
  // signs with it, the authorizer reads its public half, and the smoke suite
  // verifies a minted token against it.
  "ExecutionTokenKeyId",
  "ExecutionTokenKeyArn",
  // P4 (T5, D-P4-07): the smoke suite's second principal, so the deployed
  // isolation matrix has two callers in two organisations.
  "TestPrincipalClientId",
  // P11 (T2, D-P11-04): the Studio's own app client. The authorizer lists it
  // among its audiences and the studio stack writes it into `config.json`.
  "StudioClientId",
  // P10 (T2, D-P10-23): an org's provider keys live in a table of their own,
  // sealed under a dedicated symmetric key. The API function alone reads either.
  "CredentialsTableName",
  "CredentialsTableArn",
  "CredentialsKeyId",
  "CredentialsKeyArn",
] as const;
export type DataExportKey = (typeof DATA_EXPORT_KEYS)[number];
export const dataExportName = (stage: string, key: DataExportKey): string =>
  `nightshift-${stage}-data-${key}`;
