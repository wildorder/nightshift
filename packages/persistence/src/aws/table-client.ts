/**
 * The seam between the adapter and DynamoDB.
 *
 * The adapter speaks to this interface rather than to `DynamoDBDocumentClient`
 * directly, so the same code runs against the real client in the Lambda and
 * against `FakeTable` in `npm test`. The inputs and outputs are the SDK's own
 * document-client types, which keeps the fake honest about field names.
 */
import {
  DeleteCommand,
  type DeleteCommandInput,
  type DeleteCommandOutput,
  type DynamoDBDocumentClient,
  GetCommand,
  type GetCommandInput,
  type GetCommandOutput,
  PutCommand,
  type PutCommandInput,
  type PutCommandOutput,
  QueryCommand,
  type QueryCommandInput,
  type QueryCommandOutput,
  ScanCommand,
  type ScanCommandInput,
  type ScanCommandOutput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type TransactWriteCommandOutput,
  UpdateCommand,
  type UpdateCommandInput,
  type UpdateCommandOutput,
} from "@aws-sdk/lib-dynamodb";

export interface TableClient {
  get(input: GetCommandInput): Promise<GetCommandOutput>;
  put(input: PutCommandInput): Promise<PutCommandOutput>;
  update(input: UpdateCommandInput): Promise<UpdateCommandOutput>;
  delete(input: DeleteCommandInput): Promise<DeleteCommandOutput>;
  query(input: QueryCommandInput): Promise<QueryCommandOutput>;
  scan(input: ScanCommandInput): Promise<ScanCommandOutput>;
  transactWrite(input: TransactWriteCommandInput): Promise<TransactWriteCommandOutput>;
}

export const documentTableClient = (client: DynamoDBDocumentClient): TableClient => ({
  get: (input) => client.send(new GetCommand(input)),
  put: (input) => client.send(new PutCommand(input)),
  update: (input) => client.send(new UpdateCommand(input)),
  delete: (input) => client.send(new DeleteCommand(input)),
  query: (input) => client.send(new QueryCommand(input)),
  scan: (input) => client.send(new ScanCommand(input)),
  transactWrite: (input) => client.send(new TransactWriteCommand(input)),
});

/** The `name` DynamoDB gives a failed condition on a single write. */
export const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";

/** The `name` DynamoDB gives a transaction refused as a whole. */
export const TRANSACTION_CANCELED = "TransactionCanceledException";

interface CancellationReason {
  readonly Code?: string;
}

/**
 * For a cancelled transaction, which of its operations failed their condition,
 * by position. `undefined` when `error` is not a cancelled transaction at all, so
 * callers rethrow anything they did not expect.
 */
export const conditionFailures = (error: unknown): readonly boolean[] | undefined => {
  if (!(error instanceof Error) || error.name !== TRANSACTION_CANCELED) return undefined;
  const reasons = (error as Error & { CancellationReasons?: readonly CancellationReason[] })
    .CancellationReasons;
  if (reasons === undefined) return undefined;
  return reasons.map((reason) => reason.Code === "ConditionalCheckFailed");
};

export const isConditionalCheckFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === CONDITIONAL_CHECK_FAILED;
