/**
 * The dispatch's lifecycle, lease and fence (P10, D-P10-18, D-P10-19).
 */
import type {
  Dispatch,
  DispatchProgress,
  DispatchStatus,
  RunnerProgress,
} from "@nightshift/contracts";
import { DEFAULT_COMPUTE_CEILINGS } from "@nightshift/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "../errors.js";
import { createFixtures, makeDispatch } from "../testing/factories.js";
import {
  attemptsExhausted,
  beginReplacement,
  canTransitionDispatch,
  DISPATCH_STATUSES,
  DISPATCH_TERMINAL_STATUSES,
  DISPATCH_TRANSITION_EVENTS,
  DISPATCH_TRANSITIONS,
  type DispatchTransitionEvent,
  foldProgress,
  hasPendingIntent,
  isCurrentGeneration,
  isDispatchTerminal,
  LEASE_SECONDS,
  leaseExpiryFrom,
  leaseLost,
  mayDispatch,
  mayResume,
  nextDispatchStatus,
  nextGeneration,
  recordIntent,
  runHoursOf,
  runnerStopped,
  transitionDispatch,
} from "./dispatch.js";

const f = createFixtures();
const AT = "2026-10-01T12:00:00.000Z";
const LATER = "2026-10-01T12:05:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const at = (status: DispatchStatus, overrides: Partial<Record<keyof Dispatch, unknown>> = {}) =>
  makeDispatch(f, { status, ...overrides });

describe("the dispatch transition table (D-P10-18)", () => {
  it("covers every status the contract declares, and targets only those", () => {
    expect(Object.keys(DISPATCH_TRANSITIONS).sort()).toEqual([...DISPATCH_STATUSES].sort());
    for (const events of Object.values(DISPATCH_TRANSITIONS)) {
      for (const target of Object.values(events)) expect(DISPATCH_STATUSES).toContain(target);
    }
  });

  it("leaves the two settled statuses one way out: a human's resume", () => {
    for (const status of DISPATCH_TERMINAL_STATUSES) {
      expect(Object.keys(DISPATCH_TRANSITIONS[status])).toEqual(["resume"]);
      expect(isDispatchTerminal(status)).toBe(true);
    }
  });

  it("can stop or fail from every live status, so a cancel and a failure always land", () => {
    for (const status of DISPATCH_STATUSES.filter((s) => !isDispatchTerminal(s))) {
      if (status === "stopping") {
        expect(nextDispatchStatus(status, "fail")).toBe("failed");
        expect(nextDispatchStatus(status, "stopped")).toBe("stopped");
        continue;
      }
      expect(nextDispatchStatus(status, "stop")).toBe("stopping");
      expect(nextDispatchStatus(status, "fail")).toBe("failed");
    }
  });

  it("walks the happy path: requested → provisioning → ready → running → stopping → stopped", () => {
    const path: DispatchTransitionEvent[] = ["provision", "ready", "start", "stop", "stopped"];
    let status: DispatchStatus = "requested";
    for (const event of path) {
      const next = nextDispatchStatus(status, event);
      expect(next, `${status} on ${event}`).toBeDefined();
      status = next as DispatchStatus;
    }
    expect(status).toBe("stopped");
  });

  it("recovers a live machine back to provisioning and never a stopping or ended one", () => {
    expect(nextDispatchStatus("provisioning", "recover")).toBe("provisioning");
    expect(nextDispatchStatus("ready", "recover")).toBe("provisioning");
    expect(nextDispatchStatus("running", "recover")).toBe("provisioning");
    expect(nextDispatchStatus("requested", "recover")).toBeUndefined();
    expect(nextDispatchStatus("stopping", "recover")).toBeUndefined();
    expect(nextDispatchStatus("stopped", "recover")).toBeUndefined();
    expect(nextDispatchStatus("running", "resume")).toBeUndefined();
  });

  it("resumes a settled dispatch from its snapshot within retention, and refuses otherwise", () => {
    const nowMs = Date.parse(LATER);
    const day = 24 * 3600 * 1000;
    const settled = at("stopped", {
      cleanup: {
        snapshotId: "snap-1",
        snapshotTakenAt: new Date(nowMs - 6 * day).toISOString(),
        volumeDeleted: true,
        failures: [],
      },
      failure: { code: "recovery_exhausted", message: "three machines died" },
    });
    expect(mayResume(settled, nowMs)).toEqual({ ok: true });
    const resumed = beginReplacement(settled, "resume", LATER);
    expect(resumed.status).toBe("provisioning");
    expect(resumed.generation).toBe(2);
    expect(resumed.failure).toBeUndefined();
    expect(resumed.attempts.at(-1)?.reason).toBe("resume");
    expect(mayResume(at("running"), nowMs).ok).toBe(false);
    expect(mayResume(at("stopped"), nowMs).ok).toBe(false);
    expect(
      mayResume(
        at("stopped", {
          cleanup: {
            snapshotId: "snap-1",
            snapshotTakenAt: new Date(nowMs - 8 * day).toISOString(),
            volumeDeleted: true,
            failures: [],
          },
        }),
        nowMs,
      ).ok,
    ).toBe(false);
  });

  it("refuses every (status, event) pair outside the table", () => {
    for (const status of DISPATCH_STATUSES) {
      for (const event of DISPATCH_TRANSITION_EVENTS) {
        const legal = DISPATCH_TRANSITIONS[status][event] !== undefined;
        expect(canTransitionDispatch(status, event)).toBe(legal);
        if (legal) {
          expect(transitionDispatch(at(status), event, LATER).status).toBe(
            DISPATCH_TRANSITIONS[status][event],
          );
        } else {
          expect(() => transitionDispatch(at(status), event, LATER)).toThrow(
            IllegalTransitionError,
          );
        }
      }
    }
  });
});

describe("the lease", () => {
  const nowMs = Date.parse(AT);

  it("buys the heartbeat interval times the allowed misses", () => {
    expect(Date.parse(leaseExpiryFrom(nowMs)) - nowMs).toBe(LEASE_SECONDS * 1000);
  });

  it("is lost when it has expired on a live machine, and never otherwise", () => {
    const expired = new Date(nowMs - 1).toISOString();
    const live = new Date(nowMs + 1).toISOString();
    expect(leaseLost(at("running", { leaseExpiresAt: expired }), nowMs)).toBe(true);
    expect(leaseLost(at("ready", { leaseExpiresAt: expired }), nowMs)).toBe(true);
    expect(leaseLost(at("provisioning", { leaseExpiresAt: expired }), nowMs)).toBe(true);
    expect(leaseLost(at("running", { leaseExpiresAt: live }), nowMs)).toBe(false);
    // No lease yet, stopping, or ended: nothing to lose.
    expect(leaseLost(at("requested"), nowMs)).toBe(false);
    expect(leaseLost(at("running"), nowMs)).toBe(false);
    expect(leaseLost(at("stopping", { leaseExpiresAt: expired }), nowMs)).toBe(false);
    expect(leaseLost(at("stopped", { leaseExpiresAt: expired }), nowMs)).toBe(false);
    expect(leaseLost(at("failed", { leaseExpiresAt: expired }), nowMs)).toBe(false);
  });
});

describe("generations and attempts", () => {
  it("only ever moves the generation by one, and a replacement records why", () => {
    const first = at("running", { instanceId: "i-1", leaseExpiresAt: AT });
    const second = beginReplacement(first, "lease_lost", LATER);
    expect(second.generation).toBe(2);
    expect(second.status).toBe("provisioning");
    expect(second.instanceId).toBeUndefined();
    expect(second.leaseExpiresAt).toBeUndefined();
    expect(second.attempts).toHaveLength(2);
    expect(second.attempts[0]?.endedAt).toBe(LATER);
    expect(second.attempts[1]).toEqual({ generation: 2, reason: "lease_lost", startedAt: LATER });
    expect(nextGeneration(second)).toBe(3);
  });

  it("never decreases across any sequence of replacements (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("lease_lost", "resume"), { maxLength: 6 }),
        (reasons) => {
          let dispatch = at("running");
          let previous = dispatch.generation;
          for (const reason of reasons) {
            // A resume follows a settled dispatch; a recovery follows a live one.
            if (reason === "resume") dispatch = { ...dispatch, status: "stopped" };
            dispatch = beginReplacement(dispatch, reason as "lease_lost" | "resume", LATER);
            expect(dispatch.generation).toBe(previous + 1);
            previous = dispatch.generation;
          }
        },
      ),
    );
  });

  it("knows the current generation and nothing else", () => {
    const dispatch = at("running", { generation: 3 });
    expect(isCurrentGeneration(dispatch, 3)).toBe(true);
    expect(isCurrentGeneration(dispatch, 2)).toBe(false);
    expect(isCurrentGeneration(dispatch, 4)).toBe(false);
    expect(isCurrentGeneration(dispatch, undefined)).toBe(false);
  });

  it("is exhausted at the third machine (D-P10-05)", () => {
    let dispatch = at("running");
    expect(attemptsExhausted(dispatch)).toBe(false);
    dispatch = beginReplacement(dispatch, "lease_lost", LATER);
    expect(attemptsExhausted(dispatch)).toBe(false);
    dispatch = beginReplacement(dispatch, "lease_lost", LATER);
    expect(attemptsExhausted(dispatch)).toBe(true);
  });
});

describe("mayDispatch (D-P10-19)", () => {
  const ceilings = DEFAULT_COMPUTE_CEILINGS;
  const fine = {
    ceilings,
    tier: "better" as const,
    runHours: 8,
    estimatedUsd: 3,
    monthSpentUsd: 10,
    concurrentRuns: 0,
  };

  it("accepts a run within every ceiling", () => {
    expect(mayDispatch(fine)).toBeUndefined();
  });

  it("refuses a tier above the org's", () => {
    expect(mayDispatch({ ...fine, ceilings: { ...ceilings, maxTier: "good" } })?.reason).toBe(
      "tier_over_ceiling",
    );
  });

  it("refuses when the org's live runs are at the ceiling", () => {
    expect(mayDispatch({ ...fine, concurrentRuns: ceilings.maxConcurrentRuns })?.reason).toBe(
      "concurrency_over_ceiling",
    );
  });

  it("refuses a wall clock over the org's hours", () => {
    expect(mayDispatch({ ...fine, runHours: ceilings.maxRunHours + 1 })?.reason).toBe(
      "hours_over_ceiling",
    );
  });

  it("refuses a run whose estimate crosses the per-run cap", () => {
    expect(mayDispatch({ ...fine, estimatedUsd: ceilings.maxUsdPerRun + 0.01 })?.reason).toBe(
      "run_over_cap",
    );
  });

  it("refuses a run that would cross the month's cap", () => {
    expect(
      mayDispatch({ ...fine, monthSpentUsd: ceilings.maxUsdPerMonth - 1, estimatedUsd: 2 })?.reason,
    ).toBe("month_over_cap");
  });

  it("caps a contract's wall clock at the org's hours, and uses the org's when it has none", () => {
    expect(runHoursOf(undefined, ceilings)).toBe(ceilings.maxRunHours);
    expect(runHoursOf(3600 * 2, ceilings)).toBe(2);
    expect(runHoursOf(3600 * 100, ceilings)).toBe(ceilings.maxRunHours);
  });
});

describe("publication intents (D-P10-22)", () => {
  const intent = (head: string, predecessor: string) => ({
    head,
    expectedPredecessor: predecessor,
    bundleKey: `bundles/${head}.bundle`,
  });

  it("records a pending intent once per head", () => {
    const first = recordIntent(at("running"), intent(SHA_A, SHA_B), AT);
    expect(first.created).toBe(true);
    expect(hasPendingIntent(first.dispatch)).toBe(true);
    expect(first.dispatch.publication.lastIntentAt).toBe(AT);
    const again = recordIntent(first.dispatch, intent(SHA_A, SHA_B), LATER);
    expect(again.created).toBe(false);
    expect(again.dispatch).toBe(first.dispatch);
  });

  it("keeps the newest resolved intents and drops the rest", () => {
    let dispatch = at("running");
    for (let index = 0; index < 25; index += 1) {
      const head = index.toString(16).padStart(40, "0");
      dispatch = recordIntent(dispatch, intent(head, SHA_C), AT).dispatch;
      dispatch = {
        ...dispatch,
        publication: {
          ...dispatch.publication,
          intents: dispatch.publication.intents.map((candidate) =>
            candidate.head === head ? { ...candidate, status: "published" as const } : candidate,
          ),
        },
      };
    }
    const next = recordIntent(dispatch, intent(SHA_A, SHA_B), LATER).dispatch;
    const resolved = next.publication.intents.filter((candidate) => candidate.status !== "pending");
    expect(resolved).toHaveLength(20);
    expect(resolved.at(-1)?.head).toBe((24).toString(16).padStart(40, "0"));
    expect(next.publication.intents.at(-1)?.status).toBe("pending");
  });
});

describe("the runner's stopped (P16 SC-07)", () => {
  const setupFailed = { code: "setup_failed" as const, message: "`npm ci` exited 1" };
  const fault = { code: "environment_fault" as const, message: "test is red on the machine" };

  it("fails a provisioning dispatch with the setup failure and its cause", () => {
    const next = runnerStopped(at("provisioning"), setupFailed, LATER);
    expect(next.status).toBe("failed");
    expect(next.failure).toEqual(setupFailed);
    expect(next.updatedAt).toBe(LATER);
  });

  it("fails a ready or running dispatch with the failure reported", () => {
    for (const status of ["ready", "running"] as const) {
      const next = runnerStopped(at(status), fault, LATER);
      expect(next.status).toBe("failed");
      expect(next.failure).toEqual(fault);
    }
  });

  it("stops a dispatch as before when there is no failure", () => {
    for (const status of ["ready", "running", "stopping"] as const) {
      const next = runnerStopped(at(status), undefined, LATER);
      expect(next.status).toBe("stopped");
      expect(next.failure).toBeUndefined();
    }
    expect(runnerStopped(at("provisioning"), undefined, LATER).status).toBe("provisioning");
  });

  it("keeps the plane's reason on a dispatch it told to stop", () => {
    const cancelled = { code: "cancelled" as const, message: "cancelled by the operator" };
    const next = runnerStopped(at("stopping", { failure: cancelled }), setupFailed, LATER);
    expect(next.status).toBe("stopped");
    expect(next.failure).toEqual(cancelled);
  });

  it("changes nothing on a settled dispatch", () => {
    for (const status of ["stopped", "failed", "requested"] as const) {
      const dispatch = at(status);
      expect(runnerStopped(dispatch, setupFailed, LATER)).toBe(dispatch);
    }
  });
});

describe("foldProgress folds a heartbeat's reported progress into the dispatch (P16 S-03)", () => {
  const report = (overrides: Partial<RunnerProgress> = {}): RunnerProgress => ({
    stage: "toolchain",
    ...overrides,
  });

  it("starts a stage, with no previous progress, at `at`", () => {
    const next = foldProgress(undefined, report({ detail: "node 22.22.0" }), 1, AT);
    expect(next).toEqual({
      stage: "toolchain",
      detail: "node 22.22.0",
      generation: 1,
      stageStartedAt: AT,
      updatedAt: AT,
    });
  });

  it("keeps stageStartedAt when the stage and generation are unchanged", () => {
    const previous: DispatchProgress = {
      stage: "toolchain",
      generation: 1,
      stageStartedAt: AT,
      updatedAt: AT,
    };
    const next = foldProgress(previous, report({ detail: "python 3.12.8" }), 1, LATER);
    expect(next.stageStartedAt).toBe(AT);
    expect(next.updatedAt).toBe(LATER);
    expect(next.detail).toBe("python 3.12.8");
  });

  it("resets stageStartedAt to `at` when the stage changes", () => {
    const previous: DispatchProgress = {
      stage: "toolchain",
      generation: 1,
      stageStartedAt: AT,
      updatedAt: AT,
    };
    const next = foldProgress(previous, report({ stage: "setup" }), 1, LATER);
    expect(next.stage).toBe("setup");
    expect(next.stageStartedAt).toBe(LATER);
  });

  it("resets stageStartedAt to `at` when the generation changes, even at the same stage", () => {
    const previous: DispatchProgress = {
      stage: "toolchain",
      generation: 1,
      stageStartedAt: AT,
      updatedAt: AT,
    };
    const next = foldProgress(previous, report(), 2, LATER);
    expect(next.generation).toBe(2);
    expect(next.stageStartedAt).toBe(LATER);
  });

  it("drops a field the report does not carry, even if the previous progress had one", () => {
    const previous: DispatchProgress = {
      stage: "audit",
      detail: "running gate 3 of 6",
      gates: [{ id: "test", kind: "check", machine: "passed" }],
      verdict: "agrees",
      generation: 1,
      stageStartedAt: AT,
      updatedAt: AT,
    };
    const next = foldProgress(previous, report({ stage: "audit" }), 1, LATER);
    expect(next).toEqual({
      stage: "audit",
      generation: 1,
      stageStartedAt: AT,
      updatedAt: LATER,
    });
  });
});
