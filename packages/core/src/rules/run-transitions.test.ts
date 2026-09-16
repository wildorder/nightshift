import type { Run, RunStatus } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { IllegalTransitionError, OutcomeReasonRequiredError } from "../errors.js";
import { createFixtures, FIXTURE_TIMESTAMP, makeRun } from "../testing/factories.js";
import {
  canTransitionRun,
  explainRunEnding,
  explainRunUpdate,
  isRunTerminal,
  legalRunEventsFrom,
  nextRunStatus,
  RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  RUN_TRANSITION_EVENTS,
  RUN_TRANSITIONS,
  type RunTransitionEvent,
  runEventFor,
  transitionRun,
} from "./run-transitions.js";

const f = createFixtures();
const ENDED = "2026-02-02T00:00:00.000Z";
const runAt = (status: RunStatus, overrides: Partial<Record<keyof Run, unknown>> = {}): Run =>
  makeRun(f, { status, ...overrides });

describe("run transition table", () => {
  it("covers every status declared by the contract", () => {
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...RUN_STATUSES].sort());
  });

  it("only ever targets a declared status", () => {
    for (const events of Object.values(RUN_TRANSITIONS)) {
      for (const target of Object.values(events)) expect(RUN_STATUSES).toContain(target);
    }
  });

  it("leaves terminal statuses with no outgoing transition", () => {
    for (const status of RUN_TERMINAL_STATUSES) {
      expect(Object.keys(RUN_TRANSITIONS[status])).toEqual([]);
      expect(isRunTerminal(status)).toBe(true);
    }
  });

  it("moves pending to running and nowhere else on start", () => {
    expect(nextRunStatus("pending", "start")).toBe("running");
    for (const status of RUN_STATUSES) {
      if (status === "pending") continue;
      expect(canTransitionRun(status, "start")).toBe(false);
    }
  });

  it("lets a running run reach every terminal status", () => {
    expect([...legalRunEventsFrom("running")].sort()).toEqual(
      ["cancel", "fail", "interrupt", "succeed"].sort(),
    );
  });

  it("lets a pending run be cancelled or interrupted without ever running", () => {
    expect(nextRunStatus("pending", "cancel")).toBe("cancelled");
    expect(nextRunStatus("pending", "interrupt")).toBe("interrupted");
    expect(canTransitionRun("pending", "succeed")).toBe(false);
    expect(canTransitionRun("pending", "fail")).toBe(false);
  });

  /**
   * The whole cartesian product, not a sample: an illegal pair that happened not
   * to be sampled is exactly the defect this guards against.
   */
  it("refuses every (status, event) pair outside the table", () => {
    for (const status of RUN_STATUSES) {
      for (const event of RUN_TRANSITION_EVENTS) {
        const legal = RUN_TRANSITIONS[status][event] !== undefined;
        const attempt = () =>
          transitionRun(runAt(status), event, { endedAt: ENDED, outcomeReason: "because" });
        if (legal) expect(attempt, `${status} + ${event}`).not.toThrow();
        else expect(attempt, `${status} + ${event}`).toThrow(IllegalTransitionError);
      }
    }
  });

  it("names exactly one event per reachable target", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        const events = RUN_TRANSITION_EVENTS.filter((event) => nextRunStatus(from, event) === to);
        expect(events.length, `${from} -> ${to}`).toBeLessThanOrEqual(1);
        expect(runEventFor(from, to)).toBe(events[0]);
      }
    }
  });
});

describe("transitionRun", () => {
  it("does not touch the ending fields on a non-terminal transition", () => {
    const moved = transitionRun(runAt("pending"), "start", { endedAt: ENDED });
    expect(moved.status).toBe("running");
    expect(moved.endedAt).toBeUndefined();
    expect(moved.outcomeReason).toBeUndefined();
  });

  it("stamps endedAt on a success and records no reason", () => {
    const moved = transitionRun(runAt("running"), "succeed", { endedAt: ENDED });
    expect(moved).toMatchObject({ status: "succeeded", endedAt: ENDED });
    expect(moved.outcomeReason).toBeUndefined();
  });

  it("refuses to end a run in silence", () => {
    for (const event of ["fail", "cancel", "interrupt"] as const satisfies RunTransitionEvent[]) {
      expect(() => transitionRun(runAt("running"), event, { endedAt: ENDED })).toThrow(
        OutcomeReasonRequiredError,
      );
    }
  });

  it("keeps the reason it was given", () => {
    const moved = transitionRun(runAt("running"), "interrupt", {
      endedAt: ENDED,
      outcomeReason: "the MCP server shut down with a worker running",
    });
    expect(moved.status).toBe("interrupted");
    expect(moved.outcomeReason).toContain("shut down");
  });

  it("is pure: the input is unchanged", () => {
    const before = runAt("running");
    const snapshot = { ...before };
    transitionRun(before, "succeed", { endedAt: ENDED });
    expect(before).toEqual(snapshot);
  });
});

describe("explainRunUpdate", () => {
  it("accepts a status move that leaves the fixed fields alone", () => {
    const existing = runAt("pending", { startedAt: FIXTURE_TIMESTAMP });
    expect(explainRunUpdate(existing, { ...existing, status: "running" })).toEqual([]);
  });

  it("refuses a change to the root node, the location or the start time", () => {
    const existing = runAt("running");
    expect(explainRunUpdate(existing, { ...existing, rootNodeId: f.ids.next("node") })).toEqual([
      "rootNodeId cannot change once a run exists",
    ]);
    expect(explainRunUpdate(existing, { ...existing, location: "remote" })).toEqual([
      "location cannot change once a run exists",
    ]);
    expect(explainRunUpdate(existing, { ...existing, startedAt: ENDED })).toEqual([
      "startedAt cannot change once a run exists",
    ]);
  });

  it("reports every immutability problem at once rather than the first", () => {
    const existing = runAt("running");
    expect(
      explainRunUpdate(existing, {
        ...existing,
        location: "remote",
        rootNodeId: f.ids.next("node"),
      }),
    ).toHaveLength(2);
  });
});

describe("explainRunEnding", () => {
  it("accepts a live run with neither ending field", () => {
    expect(explainRunEnding(runAt("running"))).toEqual([]);
    expect(explainRunEnding(runAt("pending"))).toEqual([]);
  });

  it("accepts a terminal run that carries what its status demands", () => {
    expect(explainRunEnding(runAt("succeeded", { endedAt: ENDED }))).toEqual([]);
    expect(
      explainRunEnding(runAt("failed", { endedAt: ENDED, outcomeReason: "a job failed" })),
    ).toEqual([]);
  });

  it("requires endedAt on every terminal status", () => {
    expect(explainRunEnding(runAt("succeeded"))).toEqual(["a succeeded run must carry endedAt"]);
  });

  it("requires a reason on every terminal status but succeeded", () => {
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      expect(explainRunEnding(runAt(status, { endedAt: ENDED }))).toEqual([
        `a ${status} run must carry outcomeReason`,
      ]);
    }
  });

  it("refuses ending fields on a run that has not ended", () => {
    expect(explainRunEnding(runAt("running", { endedAt: ENDED }))).toEqual([
      "a running run has not ended, so it must not carry endedAt",
    ]);
    expect(explainRunEnding(runAt("pending", { outcomeReason: "early" }))).toEqual([
      "a pending run has not ended, so it must not carry outcomeReason",
    ]);
  });
});
