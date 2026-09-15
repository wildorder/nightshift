/**
 * `@nightshift/persistence/aws/testing` — offline stand-ins for the table and the
 * bucket, **for tests only**. Under the `aws` subpath deliberately, so the same
 * architecture rule that guards the real adapters keeps these out of anything
 * but an app's tests.
 */
import { marshall } from "@aws-sdk/util-dynamodb";
import type { StreamRecordLike } from "../stream-records.js";
import type { FakeStreamRecord } from "./fake-table.js";

export * from "./fake-objects.js";
export * from "./fake-table.js";

/** A fake stream record in the marshalled shape Lambda delivers. */
export const toStreamRecord = (record: FakeStreamRecord): StreamRecordLike => ({
  eventName: record.eventName,
  dynamodb: {
    SequenceNumber: record.sequenceNumber,
    Keys: marshall(record.keys),
    ...(record.newImage === undefined
      ? {}
      : { NewImage: marshall(record.newImage, { removeUndefinedValues: true }) }),
  },
});
