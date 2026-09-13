import type { ExecutionNodeStatus } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "../errors.js";
import { createFixtures, FIXTURE_TIMESTAMP, makeRootNode } from "../testing/factories.js";
import {
  canTransition,
  EXECUTION_NODE_STATUSES,
  isPostVerification,
  isTerminal,
  legalEventsFrom,
  MAY_INTEGRATE,
  nextStatus,
  OCCUPIES_CONCURRENCY_SLOT,
  RETRYABLE_STATUSES,
  TERMINAL_STATUSES,
  TRANSITION_EVENTS,
  TRANSITIONS,
  type TransitionEvent,
  transition,
} from "./transitions.js";

const f = createFixtures();
const nodeAt = (status: ExecutionNodeStatus) => makeRootNode(f, { status });

describe("transition table", () => {
  it("covers every status declared by the contract", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...EXECUTION_NODE_STATUSES].sort());
  });

  it("only ever targets a declared status", () => {
    for (const [, events] of Object.entries(TRANSITIONS)) {
      for (const target of Object.values(events)) {
        expect(EXECUTION_NODE_STATUSES).toContain(target);
      }
    }
  });

  it("leaves terminal statuses with no outgoing transition", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(Object.keys(TRANSITIONS[status])).toEqual([]);
      expect(isTerminal(status)).toBe(true);
    }
  });

  it("allows cancel from every non-terminal status", () => {
    for (const status of EXECUTION_NODE_STATUSES) {
      if (isTerminal(status)) continue;
      expect(canTransition(status, "cancel"), `${status} should be cancellable`).toBe(true);
    }
  });

  it("allows retry from exactly the retryable statuses", () => {
    for (const status of EXECUTION_NODE_STATUSES) {
      expect(canTransition(status, "retry"), `retry from ${status}`).toBe(
        RETRYABLE_STATUSES.includes(status),
      );
    }
  });
});

// SC-P1-15 — the full cartesian product, not a sample.
describe("illegal transitions", () => {
  const pairs: [ExecutionNodeStatus, TransitionEvent][] = EXECUTION_NODE_STATUSES.flatMap(
    (status) =>
      TRANSITION_EVENTS.map((event) => [status, event] as [ExecutionNodeStatus, TransitionEvent]),
  );

  it("enumerates every status and event pair", () => {
    expect(pairs).toHaveLength(EXECUTION_NODE_STATUSES.length * TRANSITION_EVENTS.length);
  });

  it.each(pairs)("%s on %s behaves per the table", (status, event) => {
    const expected = nextStatus(status, event);
    const node = nodeAt(status);

    if (expected === undefined) {
      expect(() => transition(node, event, FIXTURE_TIMESTAMP)).toThrow(IllegalTransitionError);
    } else {
      const result = transition(node, event, FIXTURE_TIMESTAMP);
      expect(result.status).toBe(expected);
    }
  });

  it("names the state and event it refused", () => {
    try {
      transition(nodeAt("implemented"), "integrate", FIXTURE_TIMESTAMP);
      expect.unreachable("should have thrown");
    } catch (error) {
      const illegal = error as IllegalTransitionError;
      expect(illegal.from).toBe("implemented");
      expect(illegal.event).toBe("integrate");
      expect(illegal.code).toBe("illegal_transition");
    }
  });
});

// SC-P1-13 — implemented never becomes sealed or integrated on its own (A-05).
describe("implemented is not verified", () => {
  it("cannot seal directly from implemented", () => {
    expect(() => transition(nodeAt("implemented"), "seal", FIXTURE_TIMESTAMP)).toThrow(
      IllegalTransitionError,
    );
  });

  it("cannot integrate from implemented", () => {
    expect(() => transition(nodeAt("implemented"), "integrate", FIXTURE_TIMESTAMP)).toThrow(
      IllegalTransitionError,
    );
  });

  it("reaches sealed only from verified or examining", () => {
    const sources = EXECUTION_NODE_STATUSES.filter(
      (status) =>
        nextStatus(status, "seal") === "sealed" ||
        nextStatus(status, "examination_passed") === "sealed",
    );
    expect([...sources].sort()).toEqual(["examining", "verified"]);
  });

  it("reaches integrated only from sealed", () => {
    const sources = EXECUTION_NODE_STATUSES.filter((status) =>
      Object.values(TRANSITIONS[status]).includes("integrated"),
    );
    expect(sources).toEqual(["sealed"]);
    expect(MAY_INTEGRATE).toBe("sealed");
  });

  it("reaches examining only from verified", () => {
    const sources = EXECUTION_NODE_STATUSES.filter((status) =>
      Object.values(TRANSITIONS[status]).includes("examining"),
    );
    expect(sources).toEqual(["verified"]);
  });
});

describe("transition", () => {
  it("returns a new node rather than mutating", () => {
    const node = nodeAt("validated");
    const next = transition(node, "enqueue", "2026-02-02T00:00:00.000Z");
    expect(node.status).toBe("validated");
    expect(next.status).toBe("queued");
    expect(next).not.toBe(node);
  });

  it("stamps the supplied timestamp rather than reading a clock", () => {
    const at = "2026-03-03T03:03:03.000Z";
    expect(transition(nodeAt("validated"), "enqueue", at).updatedAt).toBe(at);
  });

  it("preserves every other field", () => {
    const node = nodeAt("validated");
    const next = transition(node, "enqueue", FIXTURE_TIMESTAMP);
    expect({ ...next, status: node.status, updatedAt: node.updatedAt }).toEqual(node);
  });
});

describe("status classifications", () => {
  it("marks post-verification statuses", () => {
    for (const status of [
      "verified",
      "examining",
      "examination_failed",
      "sealed",
      "integrated",
    ] as const) {
      expect(isPostVerification(status)).toBe(true);
    }
    for (const status of ["validated", "queued", "running", "implemented", "verifying"] as const) {
      expect(isPostVerification(status)).toBe(false);
    }
  });

  it("does not count queued as occupying a concurrency slot", () => {
    expect(OCCUPIES_CONCURRENCY_SLOT).not.toContain("queued");
    expect(OCCUPIES_CONCURRENCY_SLOT).toContain("running");
  });

  it("lists legal events from a status", () => {
    expect([...legalEventsFrom("verified")].sort()).toEqual(
      ["begin_examination", "cancel", "seal"].sort(),
    );
    expect(legalEventsFrom("integrated")).toEqual([]);
  });
});
