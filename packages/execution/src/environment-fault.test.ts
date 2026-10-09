/**
 * The `environment.fault` event's inline tails (P16 S-02, D-07): both outputs
 * of every faulted gate, bounded so the event fits, and never all dropped while
 * there is room for them.
 */
import {
  type ArtifactId,
  type CommitSha,
  type EnvironmentFaultPayload,
  EnvironmentFaultPayloadSchema,
  type Event,
  EventSchema,
  type ExecutionNodeId,
  inlinePayloadBytes,
  MAX_INLINE_PAYLOAD_BYTES,
} from "@nightshift/contracts";
import {
  type ArtifactBodyStore,
  createCountingIdGenerator,
  createFixtures,
  createSteppingClock,
} from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  boundEnvironmentFault,
  MIN_ENVIRONMENT_FAULT_TAIL_CHARS,
  recordEnvironmentFault,
  splitEnvironmentFault,
} from "./environment-fault.js";
import type { AuditedGate } from "./gate-audit.js";
import type { ComparedGate } from "./gate-comparison.js";

const BASE = "b".repeat(40) as CommitSha;
const art = (n: number): ArtifactId =>
  `art_01M4${String(n).padStart(22, "0")}`.replace(/[ILOU]/g, "0") as ArtifactId;

/** A long output whose last line names the gate, so its tail is recognisably its own. */
const longOutput = (gate: string, where: string): string =>
  `${Array.from({ length: 400 }, (_, i) => `${where} ${gate} line ${i}: \u001b[32mok\u001b[0m`).join("\n")}\n` +
  `${where} ${gate}: the last thing it said\n\n`;

const longOutputs = (count: number) =>
  new Map(
    Array.from({ length: count }, (_, i) => [
      `gate-${i}`,
      { reference: longOutput(`gate-${i}`, "laptop"), machine: longOutput(`gate-${i}`, "machine") },
    ]),
  );

const faultOf = (count: number): EnvironmentFaultPayload =>
  EnvironmentFaultPayloadSchema.parse({
    baseCommit: BASE,
    gates: Array.from({ length: count }, (_, i) => ({
      id: `gate-${i}`,
      command: `npm run check:${i}`,
      kind: "check",
      reference: "passed",
      machine: "failed",
      referenceOutputArtifactId: art(2 * i + 1),
      machineOutputArtifactId: art(2 * i + 2),
    })),
    referenceNode: "24.4.1",
    machineNode: "18.20.4",
  });

describe("boundEnvironmentFault", () => {
  it("keeps both tails whole when they fit", () => {
    const payload = boundEnvironmentFault(
      faultOf(1),
      new Map([["gate-0", { reference: "12 passed\n", machine: "\u001b[31m1 failed\u001b[0m" }]]),
    );
    expect(payload.gates[0]).toMatchObject({ referenceTail: "12 passed", machineTail: "1 failed" });
  });

  it("never drops every tail of a 25-gate fault while the event has room: the shared length is the largest that fits", () => {
    const outputs = longOutputs(25);
    const payload = boundEnvironmentFault(faultOf(25), outputs);
    expect(inlinePayloadBytes(payload)).toBeLessThanOrEqual(MAX_INLINE_PAYLOAD_BYTES);
    const length = payload.gates[0]?.machineTail?.length ?? 0;
    expect(length).toBeGreaterThan(0);
    for (const gate of payload.gates) {
      expect(gate.referenceTail?.length).toBe(length);
      expect(gate.machineTail?.length).toBe(length);
    }
    // One character more each would not fit.
    const whole = boundEnvironmentFault(faultOf(25), outputs, Number.POSITIVE_INFINITY);
    const grown = {
      ...whole,
      gates: whole.gates.map((gate) => ({
        ...gate,
        referenceTail: gate.referenceTail?.slice(-(length + 1)),
        machineTail: gate.machineTail?.slice(-(length + 1)),
      })),
    };
    expect(inlinePayloadBytes(grown)).toBeGreaterThan(MAX_INLINE_PAYLOAD_BYTES);
  });

  it("leaves a short output's room to the long ones", () => {
    const outputs = new Map(
      Array.from({ length: 25 }, (_, i) => [
        `gate-${i}`,
        i === 0
          ? { reference: longOutput("gate-0", "laptop"), machine: longOutput("gate-0", "machine") }
          : { reference: "ok", machine: "exit 1" },
      ]),
    );
    const payload = boundEnvironmentFault(faultOf(25), outputs);
    expect(inlinePayloadBytes(payload)).toBeLessThanOrEqual(MAX_INLINE_PAYLOAD_BYTES);
    expect(payload.gates[1]).toMatchObject({ referenceTail: "ok", machineTail: "exit 1" });
    expect(payload.gates[0]?.machineTail?.length).toBeGreaterThan(400);
  });

  it("omits only what is missing, and stays parseable as an older event", () => {
    const payload = boundEnvironmentFault(faultOf(2), new Map([["gate-0", { machine: "boom" }]]));
    expect(payload.gates[0]?.machineTail).toBe("boom");
    expect(payload.gates[0]?.referenceTail).toBeUndefined();
    expect(payload.gates[1]).not.toHaveProperty("machineTail");
    const { referenceTail: _r, machineTail: _m, ...older } = payload.gates[0] ?? {};
    expect(EnvironmentFaultPayloadSchema.safeParse({ ...payload, gates: [older] }).success).toBe(
      true,
    );
  });
});

describe("splitEnvironmentFault", () => {
  it("writes a fault that fits as one event, with no parts", () => {
    const parts = splitEnvironmentFault(faultOf(3), longOutputs(3));
    expect(parts).toHaveLength(1);
    expect(parts[0]).not.toHaveProperty("part");
    expect(parts[0]?.gates.map((gate) => gate.machineTail?.length)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(parts[0]?.gates[0]?.machineTail?.length).toBeGreaterThanOrEqual(
      MIN_ENVIRONMENT_FAULT_TAIL_CHARS,
    );
  });

  it.each([25, 30, 40, 60])(
    "keeps a tail of at least %i gates' both outputs of the floor's length, every event within the limit",
    (count) => {
      const parts = splitEnvironmentFault(faultOf(count), longOutputs(count));
      expect(parts.length).toBeGreaterThan(1);
      parts.forEach((part, index) => {
        expect(EnvironmentFaultPayloadSchema.parse(part)).toEqual(part);
        expect(inlinePayloadBytes(part)).toBeLessThanOrEqual(MAX_INLINE_PAYLOAD_BYTES);
        expect(part).toMatchObject({ part: index + 1, parts: parts.length });
        expect(part).toMatchObject({ referenceNode: "24.4.1", machineNode: "18.20.4" });
      });
      const gates = parts.flatMap((part) => part.gates);
      expect(gates.map((gate) => gate.id)).toEqual(
        Array.from({ length: count }, (_, i) => `gate-${i}`),
      );
      for (const gate of gates) {
        expect(gate.referenceTail?.length).toBeGreaterThanOrEqual(MIN_ENVIRONMENT_FAULT_TAIL_CHARS);
        expect(gate.machineTail?.length).toBeGreaterThanOrEqual(MIN_ENVIRONMENT_FAULT_TAIL_CHARS);
        expect(gate.referenceTail).toMatch(
          new RegExp(`laptop ${gate.id}: the last thing it said$`),
        );
        expect(gate.machineTail).toMatch(new RegExp(`machine ${gate.id}: the last thing it said$`));
      }
    },
  );

  it("packs gates with short outputs into one event, whole", () => {
    const outputs = new Map(
      Array.from({ length: 25 }, (_, i) => [`gate-${i}`, { reference: "ok", machine: "exit 1" }]),
    );
    const parts = splitEnvironmentFault(faultOf(25), outputs);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.gates.every((gate) => gate.machineTail === "exit 1")).toBe(true);
  });
});

/** The slice of an execution environment `recordEnvironmentFault` writes through, in memory. */
const environmentWith = (get: ArtifactBodyStore["get"]) => {
  const appended: Event[] = [];
  const bodies: ArtifactBodyStore = {
    put: async (_scope, _artifactId, body) => ({
      uri: "s3://bodies/x",
      key: "x",
      sizeBytes: typeof body === "string" ? body.length : body.length,
      sha256: "0".repeat(64),
    }),
    get,
  };
  return {
    appended,
    environment: {
      stores: {
        events: {
          append: async (event: Event) => {
            appended.push(EventSchema.parse(event));
            return { stored: true, event };
          },
          listByRun: async () => ({ items: appended }),
          nextSequence: async () => appended.length,
        },
        artifacts: { put: async () => undefined },
      } as never,
      bodies,
      clock: createSteppingClock(1_760_000_000_000),
      ids: createCountingIdGenerator(),
    },
  };
};

const auditedGate = (id: string, output: string): AuditedGate => ({
  id,
  command: `npm run ${id}`,
  kind: "check",
  verdict: "failed",
  waitingOn: [],
  result: {
    stepId: id,
    command: `npm run ${id}`,
    exitCode: 1,
    durationMs: 1,
    output: new TextEncoder().encode(output),
    timedOut: false,
  },
});

const fault = (id: string, extra: Partial<ComparedGate> = {}): ComparedGate => ({
  id,
  command: `npm run ${id}`,
  kind: "check",
  reference: "passed",
  machine: "failed",
  outcome: "fault",
  ...extra,
});

describe("recordEnvironmentFault", () => {
  const f = createFixtures();
  const nodeId = f.ids.next("node") as ExecutionNodeId;

  it("takes the laptop's tail from the reference, never reading a body a machine cannot read", async () => {
    let reads = 0;
    const { environment, appended } = environmentWith(async () => {
      reads += 1;
      throw new Error("artifact_read_unavailable");
    });
    const payload = await recordEnvironmentFault(environment, {
      scope: f.scope,
      nodeId,
      audit: { base: BASE, gates: [auditedGate("unit", "1 failed: node 18 has no fetch")] },
      comparison: {
        faults: [
          fault("unit", { referenceOutputArtifactId: art(1), referenceOutputTail: "12 passed" }),
        ],
      },
      referenceNode: "24.4.1",
      machineNode: "18.20.4",
      writerId: "test",
    });
    expect(reads).toBe(0);
    expect(payload.gates[0]).toMatchObject({
      referenceTail: "12 passed",
      machineTail: "1 failed: node 18 has no fetch",
    });
    expect(appended.filter((event) => event.type === "environment.fault")).toHaveLength(1);
  });

  it("reads an older reference's artifact where it can, and records the fault anyway where it cannot", async () => {
    const readable = environmentWith(async () => new TextEncoder().encode("all green here"));
    const read = await recordEnvironmentFault(readable.environment, {
      scope: f.scope,
      nodeId,
      audit: { base: BASE, gates: [auditedGate("unit", "red")] },
      comparison: { faults: [fault("unit", { referenceOutputArtifactId: art(1) })] },
      writerId: "test",
    });
    expect(read.gates[0]?.referenceTail).toBe("all green here");

    const unreadable = environmentWith(async () => {
      throw new Error("artifact_read_unavailable");
    });
    const unread = await recordEnvironmentFault(unreadable.environment, {
      scope: f.scope,
      nodeId,
      audit: { base: BASE, gates: [auditedGate("unit", "red")] },
      comparison: { faults: [fault("unit", { referenceOutputArtifactId: art(1) })] },
      writerId: "test",
    });
    expect(unread.gates[0]?.referenceTail).toBeUndefined();
    expect(unread.gates[0]?.machineTail).toBe("red");
    expect(unreadable.appended.some((event) => event.type === "environment.fault")).toBe(true);
  });

  it("writes a 25-gate fault with long outputs in parts within the limit, every gate with both tails", async () => {
    const { environment, appended } = environmentWith(async () => undefined);
    const ids = Array.from({ length: 25 }, (_, i) => `gate-${i}`);
    const payload = await recordEnvironmentFault(environment, {
      scope: f.scope,
      nodeId,
      audit: { base: BASE, gates: ids.map((id) => auditedGate(id, longOutput(id, "machine"))) },
      comparison: {
        faults: ids.map((id, i) =>
          fault(id, {
            referenceOutputArtifactId: art(i + 1),
            referenceOutputTail: longOutput(id, "laptop").slice(-2000),
          }),
        ),
      },
      referenceNode: "24.4.1",
      machineNode: "18.20.4",
      writerId: "test",
    });
    const events = appended.filter((candidate) => candidate.type === "environment.fault");
    expect(events.length).toBeGreaterThan(1);
    // Each part within the limit (EventSchema refuses one over it), each under its own key.
    for (const event of events) {
      expect(inlinePayloadBytes(event.payload)).toBeLessThanOrEqual(MAX_INLINE_PAYLOAD_BYTES);
    }
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(events.length);
    expect(events.flatMap((event) => event.payload.gates as unknown[])).toEqual(payload.gates);
    expect(payload.gates).toHaveLength(25);
    for (const gate of payload.gates) {
      expect(gate.machineTail?.length).toBeGreaterThanOrEqual(MIN_ENVIRONMENT_FAULT_TAIL_CHARS);
      expect(gate.referenceTail).toMatch(/laptop gate-\d+: the last thing it said$/);
      expect(gate.machineTail).toMatch(/machine gate-\d+: the last thing it said$/);
    }
  });
});
