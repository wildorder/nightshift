/**
 * The sequence materializer's logic (T6, A-22), separate from the Lambda event
 * shape so it is testable without a DynamoDB Streams event.
 *
 * ## The property
 *
 * Within a run, numbering is dense from zero, gap-free, and follows the order the
 * stream delivers records. The `SequenceLedger` makes each stamp atomic, so a
 * crash causes redelivery rather than a burned number. This module's job is to
 * preserve order across a batch:
 *
 * - Records are processed strictly in delivery order, one at a time. Nothing
 *   within a run is parallelised.
 * - Once a record fails, no later record **of the same run** is numbered in this
 *   batch, because numbering it would put a later event ahead of an earlier one.
 *   Those records are reported as failed too. Other runs carry on.
 * - A record that cannot be attributed to a run blocks the rest of the batch, for
 *   the same reason: it might belong to any run.
 *
 * Failed records go back to Lambda as `batchItemFailures`, so everything before
 * the first failure commits and the rest is redelivered. After the event source's
 * retries are exhausted a record goes to the dead-letter queue and the shard moves
 * on, so one poison record delays a run's numbering but cannot stall it forever.
 */
import type { EventId } from "@nightshift/contracts";
import type { RunScope, SequenceLedger } from "@nightshift/core";

/** One stream record, already read out of the Lambda event. */
export type MaterializerRecord =
  | {
      readonly kind: "event";
      readonly recordId: string;
      readonly scope: RunScope;
      readonly eventId: EventId;
    }
  | { readonly kind: "ignored"; readonly recordId: string }
  | { readonly kind: "malformed"; readonly recordId: string; readonly reason: string };

type EventRecord = Extract<MaterializerRecord, { kind: "event" }>;

interface Tally {
  stamped: number;
  alreadyNumbered: number;
  missing: number;
  ignored: number;
}

export interface MaterializeResult extends Readonly<Tally> {
  /** The Lambda partial-batch response: every record not committed in this batch. */
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

export interface MaterializerLog {
  error(message: string, detail?: Readonly<Record<string, unknown>>): void;
}

const silent: MaterializerLog = { error: () => undefined };

const runKey = (scope: RunScope): string => `${scope.projectId}/${scope.programId}/${scope.runId}`;

/** Numbers one event, reporting a failure instead of throwing it. */
const stampRecord = async (
  ledger: SequenceLedger,
  record: EventRecord,
  log: MaterializerLog,
): Promise<Exclude<keyof Tally, "ignored"> | "failed"> => {
  try {
    const outcome = await ledger.stamp(record.scope, record.eventId);
    if (outcome.kind === "stamped") return "stamped";
    return outcome.kind === "already_numbered" ? "alreadyNumbered" : "missing";
  } catch (error) {
    log.error("could not number event; it will be redelivered", {
      recordId: record.recordId,
      eventId: record.eventId,
      run: runKey(record.scope),
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
};

export const materializeBatch = async (
  ledger: SequenceLedger,
  records: readonly MaterializerRecord[],
  log: MaterializerLog = silent,
): Promise<MaterializeResult> => {
  const failures: { itemIdentifier: string }[] = [];
  const tally: Tally = { stamped: 0, alreadyNumbered: 0, missing: 0, ignored: 0 };
  const blockedRuns = new Set<string>();
  let blockedAll = false;

  for (const record of records) {
    if (record.kind === "ignored") {
      tally.ignored += 1;
      continue;
    }

    if (record.kind === "malformed") {
      log.error("stream record cannot be attributed to a run", {
        recordId: record.recordId,
        reason: record.reason,
      });
      failures.push({ itemIdentifier: record.recordId });
      blockedAll = true;
      continue;
    }

    const run = runKey(record.scope);
    if (blockedAll || blockedRuns.has(run)) {
      // An earlier record of this run failed; numbering this one would reorder them.
      failures.push({ itemIdentifier: record.recordId });
      continue;
    }

    const result = await stampRecord(ledger, record, log);
    if (result === "failed") {
      failures.push({ itemIdentifier: record.recordId });
      blockedRuns.add(run);
    } else {
      tally[result] += 1;
    }
  }

  return { batchItemFailures: failures, ...tally };
};
