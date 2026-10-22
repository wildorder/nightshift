import { describe, expect, it } from "vitest";
import { DispatchSchema } from "./dispatch.js";
import { type Event, EventSchema } from "./event.js";
import { ExaminationFindingSchema, FindingResolvedBySchema } from "./examination.js";
import { AGGREGATE_EXAMPLES, EXAMPLE_IDS } from "./examples.js";
import {
  LIFECYCLE_PHASES,
  LIFECYCLE_START_REASONS,
  lifecycleObservationsOf,
  lifecycleOf,
  lifecycleOperationId,
} from "./lifecycle.js";
import { LifecycleObservationSchema, MeasurementObservationSchema } from "./measurement.js";
import { AttemptCauseSchema, RoutingDecisionSchema } from "./routing-decision.js";

const T = "2026-10-20T10:00:00Z";
const scope = {
  schemaVersion: 1,
  projectId: EXAMPLE_IDS.projectId,
  programId: EXAMPLE_IDS.programId,
  runId: EXAMPLE_IDS.runId,
};

const observation = (over: Record<string, unknown> = {}) => ({
  ...scope,
  observationId: "obs-1",
  kind: "lifecycle",
  executionNodeId: EXAMPLE_IDS.jobNodeId,
  source: "engine",
  provenance: { adapter: "engine" },
  receivedAt: T,
  inclusion: "self",
  operationId: lifecycleOperationId("work", EXAMPLE_IDS.jobNodeId),
  phase: "work",
  transition: "start",
  blockers: [],
  ...over,
});

let counter = 0;
const event = (payload: Record<string, unknown>, over: Record<string, unknown> = {}): Event =>
  EventSchema.parse({
    ...scope,
    eventId: EXAMPLE_IDS.eventId,
    idempotencyKey: `k${++counter}`,
    sequence: counter,
    type: "lifecycle.observed",
    source: "control-plane",
    executionNodeId: null,
    agentId: null,
    payload,
    occurredAt: T,
    recordedAt: T,
    ...over,
  });

describe("lifecycle.observed events", () => {
  it("carries a lifecycle observation that lifecycleOf returns", () => {
    const payload = observation();
    expect(MeasurementObservationSchema.safeParse(payload).success).toBe(true);
    expect(lifecycleOf(event(payload))?.operationId).toBe(`work:${EXAMPLE_IDS.jobNodeId}`);
  });

  it("returns undefined for another event type or a non-lifecycle payload", () => {
    expect(lifecycleOf(event(observation(), { type: "node.progress" }))).toBeUndefined();
    expect(lifecycleOf(event({ message: "hello" }))).toBeUndefined();
    const request = observation({ kind: "request", counters: {} });
    expect(lifecycleOf(event(request))).toBeUndefined();
  });

  it("deduplicates by observationId, keeping the earliest receivedAt, in event order", () => {
    const events = [
      event(observation({ observationId: "a", receivedAt: "2026-10-20T10:00:05Z" })),
      event(observation({ observationId: "b" })),
      event(observation({ observationId: "a", receivedAt: "2026-10-20T10:00:01Z" })),
      event(observation({ observationId: "c" }), { type: "node.progress" }),
    ];
    const result = lifecycleObservationsOf(events);
    expect(result.map((o) => o.observationId)).toEqual(["a", "b"]);
    expect(result[0]?.receivedAt).toBe("2026-10-20T10:00:01Z");
  });

  it("builds operation ids", () => {
    expect(lifecycleOperationId("wait", "node_x")).toBe("wait:node_x");
    expect(lifecycleOperationId("wait", "node_x", "slot")).toBe("wait:node_x:slot");
    expect(LIFECYCLE_PHASES).toContain("integration");
    expect(LIFECYCLE_START_REASONS).toEqual(["recovered", "readmitted"]);
  });
});

describe("lifecycle observation refs", () => {
  it("accepts causal refs and refuses too many or an oversize observation", () => {
    const refs = [{ kind: "commit", ref: "abc" }];
    expect(LifecycleObservationSchema.safeParse(observation({ refs })).success).toBe(true);
    expect(LifecycleObservationSchema.safeParse(observation()).success).toBe(true);
    const many = Array.from({ length: 33 }, (_, i) => ({ kind: "node", ref: `n${i}` }));
    expect(LifecycleObservationSchema.safeParse(observation({ refs: many })).success).toBe(false);
    const big = Array.from({ length: 32 }, (_, i) => ({ kind: "node", ref: `${i}`.repeat(150) }));
    expect(MeasurementObservationSchema.safeParse(observation({ refs: big })).success).toBe(false);
  });
});

describe("routing decision causes and concerning", () => {
  const route = () =>
    structuredClone(AGGREGATE_EXAMPLES.RoutingDecision) as Record<string, unknown>;
  it("refuses causes on attempt 1 and accepts them on attempt 2", () => {
    const causes = [{ kind: "verification_failed", verificationId: EXAMPLE_IDS.verificationId }];
    expect(RoutingDecisionSchema.safeParse({ ...route(), attempt: 1, causes }).success).toBe(false);
    expect(
      RoutingDecisionSchema.safeParse({
        ...route(),
        attempt: 2,
        previousRouteId: EXAMPLE_IDS.routingDecisionId,
        causes,
      }).success,
    ).toBe(true);
    expect(AttemptCauseSchema.safeParse({ kind: "bogus" }).success).toBe(false);
  });

  it("parses both concerning variants", () => {
    for (const concerning of [
      { kind: "examination", examinationId: EXAMPLE_IDS.examinationId, findingId: "f1" },
      { kind: "plan_review", decisionId: EXAMPLE_IDS.decisionId },
      { kind: "plan_review" },
    ]) {
      expect(RoutingDecisionSchema.safeParse({ ...route(), concerning }).success).toBe(true);
    }
    expect(
      RoutingDecisionSchema.safeParse({ ...route(), concerning: { kind: "examination" } }).success,
    ).toBe(false);
  });
});

describe("examination repeats and fixing examination", () => {
  it("parses a finding that repeats an earlier one and a fix naming its examination", () => {
    const base = (AGGREGATE_EXAMPLES.Examination as { findings: Record<string, unknown>[] })
      .findings[0] as Record<string, unknown>;
    const repeats = { examinationId: EXAMPLE_IDS.examinationId, findingId: "f-1" };
    expect(ExaminationFindingSchema.safeParse({ ...base, repeats }).success).toBe(true);
    expect(
      ExaminationFindingSchema.safeParse({ ...base, repeats: { examinationId: "x" } }).success,
    ).toBe(false);
    expect(
      FindingResolvedBySchema.safeParse({
        authority: "agent",
        examinationId: EXAMPLE_IDS.examinationId,
        at: T,
      }).success,
    ).toBe(true);
  });
});

describe("dispatch measurement fields", () => {
  it("parses attempt milestones, price basis, stages and cleanup timestamps", () => {
    const dispatch = structuredClone(AGGREGATE_EXAMPLES.Dispatch) as {
      attempts: Record<string, unknown>[];
      cleanup: Record<string, unknown>;
      [key: string]: unknown;
    };
    dispatch.attempts[0] = {
      ...dispatch.attempts[0],
      readyAt: T,
      runningAt: T,
      endReason: "lease_lost",
    };
    dispatch.priceBasis = {
      usdPerHour: 0.44,
      volumeUsdPerHour: 0.01,
      source: "ec2 list price",
      asOf: "2026-10-01",
      region: "us-east-1",
    };
    dispatch.stages = [{ generation: 1, stage: "setup", startedAt: T }];
    dispatch.cleanup = { ...dispatch.cleanup, terminatedAt: T, volumeDeletedAt: T };
    expect(DispatchSchema.safeParse(dispatch).success).toBe(true);
    dispatch.attempts[0] = { ...dispatch.attempts[0], endReason: "exploded" };
    expect(DispatchSchema.safeParse(dispatch).success).toBe(false);
  });
});
