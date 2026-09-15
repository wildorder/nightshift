/**
 * Lambda entry point for the sequence materializer: DynamoDB Streams in, partial
 * batch response out (T6, T5). The event source mapping must enable
 * `ReportBatchItemFailures`, or Lambda ignores the response and retries whole
 * batches.
 */
import {
  createAwsClients,
  createDynamoSequenceLedger,
  parseStreamRecord,
  type StreamRecordLike,
} from "@nightshift/persistence/aws";
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { loadConfig } from "../config.js";
import { materializeBatch } from "../materializer/materialize.js";

const config = loadConfig(process.env);
const ledger = createDynamoSequenceLedger({
  tableName: config.tableName,
  table: createAwsClients().table,
});

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  // The Lambda record type and the SDK's AttributeValue differ only in optional
  // members; the parser reads nothing beyond the shape it declares.
  const records = event.Records.map((record) =>
    parseStreamRecord(record as unknown as StreamRecordLike),
  );
  const result = await materializeBatch(ledger, records, {
    error: (message, detail) => console.error(message, detail),
  });
  return { batchItemFailures: [...result.batchItemFailures] };
};
