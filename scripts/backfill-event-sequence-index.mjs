#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Puts every already-numbered event into the event-sequence index (2026-10-22),
 * from a developer machine only:
 *
 *   AWS_PROFILE=nightshift node scripts/backfill-event-sequence-index.mjs [--stage dev]
 *
 * The materializer gives an event the index's keys (`SEQPK`, `SEQ`) when it
 * numbers it; events numbered before that have none, so a read through the
 * index would not see them. This scans the table once for numbered events
 * without the keys and sets them, each write conditional on the event still
 * being numbered and still keyless, so it is safe to run again and safe beside
 * a live materializer. Run it after the data stack has the index and before
 * readers use it; running it again after the API is deployed catches events
 * numbered by the old materializer in between. Refuses to start outside the v1
 * account.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { assertNightshiftAccount, EXPECTED_REGION } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
const stageFlag = process.argv.indexOf("--stage");
const stage = stageFlag === -1 ? "dev" : process.argv[stageFlag + 1];
const tableName = execFileSync(
  "aws",
  [
    "cloudformation",
    "describe-stack-resources",
    "--stack-name",
    `nightshift-${stage}-data`,
    "--region",
    EXPECTED_REGION,
    "--query",
    "StackResources[?ResourceType=='AWS::DynamoDB::Table' && starts_with(LogicalResourceId, 'Table')].PhysicalResourceId",
    "--output",
    "text",
  ],
  { encoding: "utf8" },
).trim();
if (tableName === "" || tableName.includes("\t")) {
  console.error(`could not identify the ${stage} data table: "${tableName}"`);
  process.exit(1);
}
console.log(`Backfilling ${tableName} as ${identity.arn}.`);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: EXPECTED_REGION }));
let scanned = 0;
let updated = 0;
let raced = 0;
let startKey;
do {
  const page = await client.send(
    new ScanCommand({
      TableName: tableName,
      ProjectionExpression: "PK, SK, #sequence",
      FilterExpression:
        "begins_with(PK, :evt) AND begins_with(SK, :ulid) AND attribute_type(#sequence, :n) AND attribute_not_exists(SEQ)",
      ExpressionAttributeNames: { "#sequence": "sequence" },
      ExpressionAttributeValues: { ":evt": "EVT#", ":ulid": "ULID#", ":n": "N" },
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    }),
  );
  scanned += page.ScannedCount ?? 0;
  const items = page.Items ?? [];
  for (let i = 0; i < items.length; i += 25) {
    await Promise.all(
      items.slice(i, i + 25).map(async (item) => {
        try {
          await client.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: item.PK, SK: item.SK },
              UpdateExpression: "SET SEQPK = PK, SEQ = #sequence",
              ConditionExpression: "attribute_type(#sequence, :n) AND attribute_not_exists(SEQ)",
              ExpressionAttributeNames: { "#sequence": "sequence" },
              ExpressionAttributeValues: { ":n": "N" },
            }),
          );
          updated += 1;
        } catch (error) {
          if (error?.name !== "ConditionalCheckFailedException") throw error;
          raced += 1;
        }
      }),
    );
  }
  startKey = page.LastEvaluatedKey;
  process.stdout.write(`\r  scanned ${scanned}, indexed ${updated}, already done ${raced}`);
} while (startKey !== undefined);
console.log(`\nDone: ${updated} events put in the event-sequence index.`);
