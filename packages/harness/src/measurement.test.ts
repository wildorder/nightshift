import { describe, expect, it } from "vitest";
import {
  coverageOfExit,
  type HarnessExit,
  inclusionOfExit,
  usageOfExit,
  usageScopeOfExit,
} from "./harness.js";
import { type HarnessObservation, recordingMeasurementSink } from "./measurement.js";

const usage = { inputTokens: 3, outputTokens: 4 };

describe("usageOfExit", () => {
  it("reads usage from all four variants", () => {
    const exits: HarnessExit[] = [
      { kind: "completed", usage },
      { kind: "failed", exitCode: 1, usage },
      { kind: "interrupted", signal: "SIGKILL", usage },
      { kind: "cancelled", usage },
    ];
    for (const exit of exits) expect(usageOfExit(exit)).toEqual(usage);
    expect(usageOfExit({ kind: "cancelled" })).toBeUndefined();
  });
});

describe("exit defaults", () => {
  it("coverage is unknown and scope is launch when absent", () => {
    expect(coverageOfExit({ kind: "completed" })).toBe("unknown");
    expect(usageScopeOfExit({ kind: "cancelled" })).toBe("launch");
  });
  it("returns what the adapter said", () => {
    const exit: HarnessExit = {
      kind: "interrupted",
      signal: "SIGTERM",
      coverage: "partial",
      usageScope: "session",
    };
    expect(coverageOfExit(exit)).toBe("partial");
    expect(usageScopeOfExit(exit)).toBe("session");
  });
});

describe("inclusionOfExit", () => {
  it("is self when absent and what the adapter said otherwise", () => {
    expect(inclusionOfExit({ kind: "completed" })).toBe("self");
    expect(inclusionOfExit({ kind: "completed", inclusion: "includes_children" })).toBe(
      "includes_children",
    );
    expect(inclusionOfExit({ kind: "cancelled", inclusion: "unknown" })).toBe("unknown");
  });
});

describe("recordingMeasurementSink", () => {
  it("records in order", () => {
    const sink = recordingMeasurementSink();
    const make = (observationId: string): HarnessObservation => ({
      kind: "request",
      schemaVersion: 1,
      observationId,
      source: "harness",
      provenance: { adapter: "t" },
      inclusion: "self",
      counters: {},
    });
    sink.observe(make("a"));
    sink.observe(make("b"));
    expect(sink.observations.map((o) => o.observationId)).toEqual(["a", "b"]);
  });
});

describe("HarnessObservation type", () => {
  it("rejects stamped fields and accepts each kind", () => {
    const base = {
      schemaVersion: 1,
      observationId: "x",
      source: "harness",
      provenance: { adapter: "t" },
      inclusion: "self",
    } as const;
    const ok: HarnessObservation[] = [
      { ...base, kind: "request", counters: {} },
      { ...base, kind: "cumulative_snapshot", counters: {}, counterScope: "launch" },
      {
        ...base,
        kind: "terminal_summary",
        counters: {},
        counterScope: "session",
        exitKind: "completed",
        coverage: "unknown",
      },
      {
        ...base,
        kind: "lifecycle",
        operationId: "o",
        phase: "p",
        transition: "start",
        blockers: [],
      },
    ];
    expect(ok).toHaveLength(4);
    const accept = (observation: HarnessObservation) => observation;
    accept({
      ...base,
      kind: "request",
      counters: {},
      // @ts-expect-error receivedAt is stamped by the execution layer
      receivedAt: "2026-01-01T00:00:00Z",
    });
    accept({
      ...base,
      kind: "request",
      counters: {},
      // @ts-expect-error runId is stamped by the execution layer
      runId: "r",
    });
  });
});
