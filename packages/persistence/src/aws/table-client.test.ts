import { describe, expect, it } from "vitest";
import {
  isTransactionConflict,
  TRANSACTION_CONFLICT_ATTEMPTS,
  withConflictRetries,
} from "./table-client.js";

const cancelled = (...codes: string[]): Error =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const noWait = async (): Promise<void> => undefined;

describe("a transaction cancelled by a concurrent one", () => {
  it("is a conflict only when no condition failed", () => {
    expect(isTransactionConflict(cancelled("None", "TransactionConflict"))).toBe(true);
    expect(isTransactionConflict(cancelled("ConditionalCheckFailed", "TransactionConflict"))).toBe(
      false,
    );
    expect(isTransactionConflict(cancelled("ConditionalCheckFailed", "None"))).toBe(false);
    expect(isTransactionConflict(new Error("TransactionConflict"))).toBe(false);
  });

  it("is sent again until it is decided, and a failed condition is never retried", async () => {
    const outcomes = [
      cancelled("TransactionConflict"),
      cancelled("None", "TransactionConflict"),
      cancelled("ConditionalCheckFailed", "None"),
    ];
    let sent = 0;
    const result = withConflictRetries(async () => {
      const outcome = outcomes[sent];
      sent += 1;
      if (outcome !== undefined) throw outcome;
      return "written";
    }, noWait);
    await expect(result).rejects.toBe(outcomes[2]);
    expect(sent).toBe(3);
  });

  it("answers the outcome once the conflict clears", async () => {
    let sent = 0;
    const result = await withConflictRetries(async () => {
      sent += 1;
      if (sent < 3) throw cancelled("TransactionConflict");
      return "written";
    }, noWait);
    expect(result).toBe("written");
  });

  it("throws the last conflict when it never clears", async () => {
    let sent = 0;
    const last = cancelled("TransactionConflict");
    await expect(
      withConflictRetries(async () => {
        sent += 1;
        throw last;
      }, noWait),
    ).rejects.toBe(last);
    expect(sent).toBe(TRANSACTION_CONFLICT_ATTEMPTS);
  });
});
