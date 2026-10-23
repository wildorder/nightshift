#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Puts every already-written event into the indexes it now belongs to
 * (2026-10-22): a numbered event into the event-sequence index, and an event
 * on a node into the node index. From a developer machine only:
 *
 *   AWS_PROFILE=nightshift node scripts/backfill-event-indexes.mjs [--stage dev]
 *
 * The materializer gives an event the sequence index's keys (`SEQPK`, `SEQ`)
 * when it numbers it, and an append gives an event on a node the node index's
 * (`GSI1PK`, `GSI1SK` = `EVT#<type>#<eventId>`); events written before either
 * have none, so a read through the index would not see them. This scans the
 * table once for events missing keys they should have and sets them, each
 * write conditional on the keys still being absent, so it is safe to run again
 * and safe beside a live control plane. Run it after the data stack has the index and before
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

// Adaptive retries with room to wait: a burst of index writes is throttled
// while the index absorbs it, and the default three attempts gave up mid-scan
// on both first runs (2026-10-22).
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: EXPECTED_REGION, maxAttempts: 12, retryMode: "adaptive" }),
);
let scanned = 0;
let updated = 0;
let nodeIndexed = 0;
let raced = 0;
let startKey;
do {
  const page = await client.send(
    new ScanCommand({
      TableName: tableName,
      ProjectionExpression: "PK, SK, #sequence, executionNodeId, #type, eventId, SEQ, GSI1PK",
      FilterExpression:
        "begins_with(PK, :evt) AND begins_with(SK, :ulid) AND ((attribute_type(#sequence, :n) AND attribute_not_exists(SEQ)) OR (attribute_type(executionNodeId, :s) AND attribute_not_exists(GSI1PK)))",
      ExpressionAttributeNames: { "#sequence": "sequence", "#type": "type" },
      ExpressionAttributeValues: { ":evt": "EVT#", ":ulid": "ULID#", ":n": "N", ":s": "S" },
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    }),
  );
  scanned += page.ScannedCount ?? 0;
  const items = page.Items ?? [];
  for (let i = 0; i < items.length; i += 25) {
    await Promise.all(
      items.slice(i, i + 25).map(async (item) => {
        try {
          if (typeof item.sequence === "number" && item.SEQ === undefined) {
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
          }
          if (typeof item.executionNodeId === "string" && item.GSI1PK === undefined) {
            // `EVT#<project>#<program>#<run>` is the run chain the node index keys by.
            const chain = String(item.PK).slice("EVT#".length);
            await client.send(
              new UpdateCommand({
                TableName: tableName,
                Key: { PK: item.PK, SK: item.SK },
                UpdateExpression: "SET GSI1PK = :gpk, GSI1SK = :gsk",
                ConditionExpression: "attribute_not_exists(GSI1PK)",
                ExpressionAttributeValues: {
                  ":gpk": `NODE#${chain}#${item.executionNodeId}`,
                  ":gsk": `EVT#${item.type}#${item.eventId}`,
                },
              }),
            );
            nodeIndexed += 1;
          }
        } catch (error) {
          if (error?.name !== "ConditionalCheckFailedException") throw error;
          raced += 1;
        }
      }),
    );
  }
  startKey = page.LastEvaluatedKey;
  process.stdout.write(
    `\r  scanned ${scanned}, by sequence ${updated}, by node ${nodeIndexed}, already done ${raced}`,
  );
} while (startKey !== undefined);
console.log(
  `\nDone: ${updated} events put in the event-sequence index, ${nodeIndexed} in the node index.`,
);
