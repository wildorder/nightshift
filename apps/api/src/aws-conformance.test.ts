/**
 * The DynamoDB adapter against the shared conformance suite, offline (T3, SC-P2-12).
 *
 * Wired here rather than in `test/` because this is the one package allowed to
 * import `@nightshift/persistence/aws` (AR-4, contract §9). `FakeTable` stands in
 * for the table, with a small page cap so every list follows DynamoDB-style
 * pagination, and `settle` drains the fake stream through the real materializer
 * and ledger — the same path events take in AWS. The smoke suite wires the same
 * suite to the deployed table.
 */
import type { NightshiftStores } from "@nightshift/core";
import {
  createAwsStores,
  createDynamoSequenceLedger,
  parseStreamRecord,
} from "@nightshift/persistence/aws";
import { FakeTable, toStreamRecord } from "@nightshift/persistence/aws/testing";
import { describePortConformance } from "@nightshift/test/conformance";
import { materializeBatch } from "./materializer/materialize.js";

const tableName = "nightshift-conformance";

interface FakeBackedStores extends NightshiftStores {
  readonly table: FakeTable;
}

describePortConformance<FakeBackedStores>(
  "DynamoDB adapter on FakeTable",
  () => {
    const table = new FakeTable({ tableName, pageItemCap: 3 });
    return { ...createAwsStores({ tableName, table }), table };
  },
  {
    settle: async ({ table }) => {
      const ledger = createDynamoSequenceLedger({ tableName, table });
      // Stamping writes stream records of its own (all ignored), so drain until quiet.
      for (let batch = table.drainStream(); batch.length > 0; batch = table.drainStream()) {
        const records = batch.map((record) => parseStreamRecord(toStreamRecord(record)));
        const result = await materializeBatch(ledger, records);
        if (result.batchItemFailures.length > 0) {
          throw new Error(`materializer failed ${result.batchItemFailures.length} records`);
        }
      }
    },
  },
);
