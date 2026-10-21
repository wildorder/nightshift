/**
 * The exit seam keeps reasoning usage (P20 S-02, F-02). `RouteUsage` has no
 * reasoning field, so an exit that carried only `usage` made the recorder's
 * newer session-scoped terminal replace the snapshot and erase the reasoning
 * tokens. These tests replay the resumed fixture through the interpreter, build
 * the exit as the adapter does, and fold it as the recorder does.
 */
import { readFileSync } from "node:fs";
import type { MeasurementCounters, MeasurementObservation } from "@nightshift/contracts";
import { countersFromRouteUsage, createSteppingClock, reconcileSegment } from "@nightshift/core";
import {
  countersOfExit,
  type HarnessExit,
  recordingHookSink,
  recordingMeasurementSink,
  usageOfExit,
  usageScopeOfExit,
} from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import { createStreamInterpreter } from "./stream.js";

const RESUMED = readFileSync(
  new URL("./__fixtures__/stream/resumed.jsonl", import.meta.url),
  "utf8",
);

const T = "2026-09-15T12:00:00.000Z";

/** The interpreter's stream measures, shaped into an exit as the adapter's `measuresFor` does. */
const replay = () => {
  const measurements = recordingMeasurementSink();
  const interpreter = createStreamInterpreter({
    sink: recordingHookSink(),
    clock: createSteppingClock(Date.UTC(2026, 8, 15, 12, 0, 0), 1),
    measurements,
  });
  interpreter.write(new TextEncoder().encode(RESUMED));
  interpreter.end();
  const measures = interpreter.outcome.measures;
  const exit: HarnessExit = {
    kind: "completed",
    ...(measures.usage === undefined
      ? {}
      : {
          usage: measures.usage,
          usageScope: measures.usageScope,
          inclusion: measures.inclusion,
          ...(measures.counters === undefined ? {} : { counters: measures.counters }),
        }),
    coverage: "complete",
  };
  return { measurements, exit };
};

const stamp = (observation: Record<string, unknown>, n: number): MeasurementObservation =>
  ({
    schemaVersion: 1,
    projectId: "proj_1",
    programId: "prog_1",
    runId: "run_1",
    executionNodeId: "node_1",
    launch: { launchId: "launch_1", segment: 1 },
    receivedAt: T,
    ...observation,
    observationId: (observation.observationId as string | undefined) ?? `o${n}`,
  }) as unknown as MeasurementObservation;

/** The terminal the recorder's `exitObservation` builds from an exit. */
const terminalOf = (exit: HarnessExit): MeasurementObservation => {
  const usage = usageOfExit(exit);
  return stamp(
    {
      observationId: "exit:launch_1",
      source: "engine",
      provenance: { adapter: "execution" },
      inclusion: exit.inclusion ?? "self",
      kind: "terminal_summary",
      counters: countersOfExit(exit) ?? (usage === undefined ? {} : countersFromRouteUsage(usage)),
      counterScope: usageScopeOfExit(exit),
      exitKind: exit.kind,
      coverage: "complete",
      occurredAt: "2026-09-15T12:00:05.000Z",
    },
    99,
  );
};

const fold = (exit: HarnessExit) => {
  const { measurements } = replay();
  const snapshots = measurements.observations
    .filter((o) => o.kind === "cumulative_snapshot")
    .map((o, i) => stamp({ ...o }, i));
  expect(snapshots.length).toBeGreaterThan(0);
  return reconcileSegment([...snapshots, terminalOf(exit)], { resumedSession: false });
};

describe("exit measures keep reasoning usage", () => {
  it("carries the interpreter's session counters on the exit", () => {
    const { exit } = replay();
    expect(exit.usageScope).toBe("session");
    expect(exit.counters?.reasoningTokens).toBe(100);
  });

  it("keeps reasoningTokens through the reconciled counters and the resume baseline", () => {
    const { exit } = replay();
    const reconciled = fold(exit);
    const expected: MeasurementCounters = exit.counters ?? {};
    expect(reconciled.counters.reasoningTokens).toBe(100);
    expect(reconciled.counters).toMatchObject({
      inputTokens: expected.inputTokens,
      outputTokens: expected.outputTokens,
    });
    expect(reconciled.sessionCumulative?.counters.reasoningTokens).toBe(100);
    expect(reconciled.sessionCumulative?.counters).toMatchObject(expected);
  });

  it("loses the reasoning on the old RouteUsage-only path", () => {
    const { exit } = replay();
    const { counters: _dropped, ...withoutCounters } = exit;
    const reconciled = fold(withoutCounters as HarnessExit);
    expect(reconciled.counters.reasoningTokens).toBeUndefined();
    expect(reconciled.sessionCumulative?.counters.reasoningTokens).toBeUndefined();
  });
});
