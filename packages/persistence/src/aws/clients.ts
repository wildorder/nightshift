/**
 * Real AWS clients, built once by an application and injected into the adapters.
 *
 * Credentials come from the SDK's default provider chain: the Lambda execution
 * role in AWS, `AWS_PROFILE` on a developer machine. Nothing here reads the
 * environment itself (T3 deliverable 1).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type ObjectClient, s3ObjectClient } from "./artifact-bodies.js";
import { documentTableClient, type TableClient } from "./table-client.js";

export interface AwsClients {
  readonly table: TableClient;
  readonly objects: ObjectClient;
}

export interface AwsClientOptions {
  /** Defaults to the SDK's resolution, which is `AWS_REGION` inside Lambda. */
  readonly region?: string;
}

export const createAwsClients = (options: AwsClientOptions = {}): AwsClients => {
  const base = options.region === undefined ? {} : { region: options.region };
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient(base), {
    // Optional contract fields are absent rather than undefined in a stored item.
    marshallOptions: { removeUndefinedValues: true },
  });
  return { table: documentTableClient(documents), objects: s3ObjectClient(new S3Client(base)) };
};
