import type { IsoTimestamp, RunStatus } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { isNeverStartedRun, NEVER_STARTED_GRACE } from "./run-liveness.js";

const at = (ms: number): IsoTimestamp =>
  new Date(Date.parse("2026-01-01T00:00:00.000Z") + ms).toISOString() as IsoTimestamp;
const holder = (status: RunStatus) => ({ status, startedAt: at(0) });

describe("isNeverStartedRun", () => {
  it("is true for a pending run past the grace with no dispatch", () => {
    expect(
      isNeverStartedRun(holder("pending"), { hasDispatch: false, at: at(NEVER_STARTED_GRACE + 1) }),
    ).toBe(true);
  });
  it("is false within the grace, exactly at it", () => {
    expect(
      isNeverStartedRun(holder("pending"), { hasDispatch: false, at: at(NEVER_STARTED_GRACE) }),
    ).toBe(false);
    expect(isNeverStartedRun(holder("pending"), { hasDispatch: false, at: at(1000) })).toBe(false);
  });
  it("is false when a dispatch exists", () => {
    expect(
      isNeverStartedRun(holder("pending"), { hasDispatch: true, at: at(NEVER_STARTED_GRACE * 2) }),
    ).toBe(false);
  });
  it.each(["running", "succeeded", "failed", "cancelled", "interrupted"] as const)(
    "is false for %s",
    (status) => {
      expect(
        isNeverStartedRun(holder(status), { hasDispatch: false, at: at(NEVER_STARTED_GRACE * 2) }),
      ).toBe(false);
    },
  );
  it("honours a given grace", () => {
    expect(
      isNeverStartedRun(holder("pending"), { hasDispatch: false, at: at(11), grace: 10 }),
    ).toBe(true);
  });
});
