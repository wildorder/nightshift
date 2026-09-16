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
] as const;
export type DataExportKey = (typeof DATA_EXPORT_KEYS)[number];
export const dataExportName = (stage: string, key: DataExportKey): string =>
  `nightshift-${stage}-data-${key}`;
