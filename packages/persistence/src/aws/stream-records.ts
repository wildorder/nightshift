/**
 * Reading DynamoDB Streams records for the sequence materializer (T6).
 *
 * Only an `INSERT` of an event item needs numbering. Everything else on the
 * stream is ignored, and two of those are load-bearing: the counter item and the
 * idempotency marker are written to the same partition, and the stamp itself is a
 * `MODIFY` of the event. Reacting to any of them would make the consumer feed
 * itself.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  type EventId,
  EventIdSchema,
  ProgramIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@nightshift/contracts";
import type { RunScope } from "@nightshift/core";
import { EVENT_SORT_PREFIX } from "./keys.js";

/** The parts of a Lambda `DynamoDBRecord` this module reads. */
export interface StreamRecordLike {
  readonly eventName?: string;
  readonly dynamodb?: {
    readonly Keys?: Record<string, AttributeValue>;
    readonly NewImage?: Record<string, AttributeValue>;
    readonly SequenceNumber?: string;
  };
}

export type ParsedStreamRecord =
  | {
      readonly kind: "event";
      readonly recordId: string;
      readonly scope: RunScope;
      readonly eventId: EventId;
    }
  | { readonly kind: "ignored"; readonly recordId: string }
  | { readonly kind: "malformed"; readonly recordId: string; readonly reason: string };

export const parseStreamRecord = (record: StreamRecordLike): ParsedStreamRecord => {
  const recordId = record.dynamodb?.SequenceNumber ?? "";
  if (record.eventName !== "INSERT") return { kind: "ignored", recordId };

  const sortKey = record.dynamodb?.Keys?.SK?.S;
  if (sortKey === undefined || !sortKey.startsWith(EVENT_SORT_PREFIX)) {
    return { kind: "ignored", recordId };
  }

  const image = record.dynamodb?.NewImage;
  if (image === undefined) {
    return { kind: "malformed", recordId, reason: "event INSERT carries no new image" };
  }
  let plain: Record<string, unknown>;
  try {
    plain = unmarshall(image);
  } catch (error) {
    return { kind: "malformed", recordId, reason: `cannot unmarshall image: ${String(error)}` };
  }

  const projectId = ProjectIdSchema.safeParse(plain.projectId);
  const programId = ProgramIdSchema.safeParse(plain.programId);
  const runId = RunIdSchema.safeParse(plain.runId);
  const eventId = EventIdSchema.safeParse(plain.eventId);
  if (!projectId.success || !programId.success || !runId.success || !eventId.success) {
    return { kind: "malformed", recordId, reason: "event image lacks a valid ownership chain" };
  }
  return {
    kind: "event",
    recordId,
    scope: { projectId: projectId.data, programId: programId.data, runId: runId.data },
    eventId: eventId.data,
  };
};
