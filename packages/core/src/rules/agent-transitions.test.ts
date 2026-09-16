import type { Agent, AgentStatus } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { IllegalTransitionError, OutcomeReasonRequiredError } from "../errors.js";
import { createFixtures, FIXTURE_TIMESTAMP, makeAgent } from "../testing/factories.js";
import {
  AGENT_STATUSES,
  AGENT_TERMINAL_STATUSES,
  AGENT_TRANSITION_EVENTS,
  AGENT_TRANSITIONS,
  agentEventFor,
  canTransitionAgent,
  explainAgentEnding,
  explainAgentUpdate,
  isAgentTerminal,
  legalAgentEventsFrom,
  nextAgentStatus,
  transitionAgent,
} from "./agent-transitions.js";

const f = createFixtures();
const AT = "2026-02-02T00:00:00.000Z";
const agentAt = (
  status: AgentStatus,
  overrides: Partial<Record<keyof Agent, unknown>> = {},
): Agent => makeAgent(f, f.rootNodeId, { status, ...overrides });

describe("agent transition table", () => {
  it("covers every status declared by the contract", () => {
    expect(Object.keys(AGENT_TRANSITIONS).sort()).toEqual([...AGENT_STATUSES].sort());
  });

  it("only ever targets a declared status", () => {
    for (const events of Object.values(AGENT_TRANSITIONS)) {
      for (const target of Object.values(events)) expect(AGENT_STATUSES).toContain(target);
    }
  });

  it("leaves terminal statuses with no outgoing transition", () => {
    for (const status of AGENT_TERMINAL_STATUSES) {
      expect(Object.keys(AGENT_TRANSITIONS[status])).toEqual([]);
      expect(isAgentTerminal(status)).toBe(true);
    }
  });

  it("lets a created agent be cancelled, because shutdown can land before start", () => {
    expect(nextAgentStatus("created", "cancel")).toBe("cancelled");
  });

  it("refuses to complete, fail or interrupt an agent that never started", () => {
    for (const event of ["complete", "fail", "interrupt"] as const) {
      expect(canTransitionAgent("created", event)).toBe(false);
    }
  });

  it("lets a started agent reach every terminal status", () => {
    expect([...legalAgentEventsFrom("started")].sort()).toEqual(
      ["cancel", "complete", "fail", "interrupt"].sort(),
    );
  });

  it("refuses every (status, event) pair outside the table", () => {
    for (const status of AGENT_STATUSES) {
      for (const event of AGENT_TRANSITION_EVENTS) {
        const legal = AGENT_TRANSITIONS[status][event] !== undefined;
        const startedAt = status === "created" ? undefined : FIXTURE_TIMESTAMP;
        const attempt = () =>
          transitionAgent(agentAt(status, startedAt === undefined ? {} : { startedAt }), event, {
            at: AT,
            outcomeReason: "because",
          });
        if (legal) expect(attempt, `${status} + ${event}`).not.toThrow();
        else expect(attempt, `${status} + ${event}`).toThrow(IllegalTransitionError);
      }
    }
  });

  it("names exactly one event per reachable target", () => {
    for (const from of AGENT_STATUSES) {
      for (const to of AGENT_STATUSES) {
        const events = AGENT_TRANSITION_EVENTS.filter(
          (event) => nextAgentStatus(from, event) === to,
        );
        expect(events.length, `${from} -> ${to}`).toBeLessThanOrEqual(1);
        expect(agentEventFor(from, to)).toBe(events[0]);
      }
    }
  });
});

describe("transitionAgent", () => {
  it("stamps startedAt on start and leaves the ending fields alone", () => {
    const moved = transitionAgent(agentAt("created"), "start", { at: AT });
    expect(moved).toMatchObject({ status: "started", startedAt: AT });
    expect(moved.endedAt).toBeUndefined();
  });

  it("stamps endedAt on completion and records no reason", () => {
    const moved = transitionAgent(
      agentAt("started", { startedAt: FIXTURE_TIMESTAMP }),
      "complete",
      {
        at: AT,
      },
    );
    expect(moved).toMatchObject({ status: "completed", endedAt: AT });
    expect(moved.outcomeReason).toBeUndefined();
  });

  it("refuses to end an agent in silence", () => {
    for (const event of ["fail", "cancel", "interrupt"] as const) {
      expect(() =>
        transitionAgent(agentAt("started", { startedAt: FIXTURE_TIMESTAMP }), event, { at: AT }),
      ).toThrow(OutcomeReasonRequiredError);
    }
  });

  it("records the exit code when the adapter exposed one", () => {
    const moved = transitionAgent(agentAt("started", { startedAt: FIXTURE_TIMESTAMP }), "fail", {
      at: AT,
      outcomeReason: "the worker process exited 2",
      exitCode: 2,
    });
    expect(moved).toMatchObject({ status: "failed", exitCode: 2, endedAt: AT });
  });

  it("is pure: the input is unchanged", () => {
    const before = agentAt("created");
    const snapshot = { ...before };
    transitionAgent(before, "start", { at: AT });
    expect(before).toEqual(snapshot);
  });
});

describe("explainAgentUpdate", () => {
  it("accepts a status move", () => {
    const existing = agentAt("created");
    expect(explainAgentUpdate(existing, { ...existing, status: "started", startedAt: AT })).toEqual(
      [],
    );
  });

  it("refuses to rewrite what routing chose", () => {
    const existing = agentAt("started", { startedAt: FIXTURE_TIMESTAMP });
    for (const field of ["harness", "provider", "model"] as const) {
      expect(explainAgentUpdate(existing, { ...existing, [field]: "something-else" })).toEqual([
        `${field} cannot change once an agent exists`,
      ]);
    }
    expect(
      explainAgentUpdate(existing, { ...existing, executionNodeId: f.ids.next("node") }),
    ).toEqual(["executionNodeId cannot change once an agent exists"]);
    expect(explainAgentUpdate(existing, { ...existing, role: "examiner" })).toEqual([
      "role cannot change once an agent exists",
    ]);
  });

  it("refuses to move a timestamp once it is set", () => {
    const started = agentAt("started", { startedAt: FIXTURE_TIMESTAMP });
    expect(explainAgentUpdate(started, { ...started, startedAt: AT })).toEqual([
      "startedAt cannot change once it is set",
    ]);
    const ended = agentAt("completed", {
      startedAt: FIXTURE_TIMESTAMP,
      endedAt: FIXTURE_TIMESTAMP,
    });
    expect(explainAgentUpdate(ended, { ...ended, endedAt: AT })).toEqual([
      "endedAt cannot change once it is set",
    ]);
  });
});

describe("explainAgentEnding", () => {
  it("accepts each status carrying exactly what it needs", () => {
    expect(explainAgentEnding(agentAt("created"))).toEqual([]);
    expect(explainAgentEnding(agentAt("started", { startedAt: AT }))).toEqual([]);
    expect(explainAgentEnding(agentAt("completed", { startedAt: AT, endedAt: AT }))).toEqual([]);
    expect(
      explainAgentEnding(
        agentAt("failed", { startedAt: AT, endedAt: AT, outcomeReason: "exited 2" }),
      ),
    ).toEqual([]);
  });

  it("requires endedAt on every ending and rejects it before one", () => {
    expect(explainAgentEnding(agentAt("completed", { startedAt: AT }))).toEqual([
      "a completed agent must carry endedAt",
    ]);
    expect(explainAgentEnding(agentAt("started", { startedAt: AT, endedAt: AT }))).toEqual([
      "a started agent has not ended, so it must not carry endedAt",
    ]);
  });

  it("requires a reason on every ending but completion", () => {
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      expect(explainAgentEnding(agentAt(status, { startedAt: AT, endedAt: AT }))).toEqual([
        `a ${status} agent must carry outcomeReason`,
      ]);
    }
  });

  it("refuses a created agent that claims a start time, and any other status with none", () => {
    expect(explainAgentEnding(agentAt("created", { startedAt: AT }))).toEqual([
      "a created agent has not started, so it must not carry startedAt",
    ]);
    expect(explainAgentEnding(agentAt("started"))).toEqual([
      "a started agent must carry startedAt",
    ]);
  });
});
