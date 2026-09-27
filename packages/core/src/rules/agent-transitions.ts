/**
 * Agent state transitions (T2, D-P3-13).
 *
 * An `Agent` is one harness invocation. It exists as `created` before the harness
 * process starts (A-04), which is why `created` is a status rather than the
 * record simply appearing at `started`.
 *
 * `created → cancelled` is legal and load-bearing: the execution layer persists
 * the identity, then creates a worktree, then starts a process, and a shutdown in
 * that window must still leave the agent somewhere terminal.
 *
 * Everything about an agent but its status and its ending is immutable. The
 * harness, provider and model are what routing chose; rewriting them after the
 * fact would make the `RoutingDecision` a lie.
 */
import type { Agent, AgentStatus, IsoTimestamp } from "@nightshift/contracts";
import { IllegalTransitionError, OutcomeReasonRequiredError } from "../errors.js";

export type AgentTransitionEvent = "start" | "complete" | "fail" | "cancel" | "interrupt";

export const AGENT_TRANSITION_EVENTS: readonly AgentTransitionEvent[] = [
  "start",
  "complete",
  "fail",
  "cancel",
  "interrupt",
];

export const AGENT_STATUSES: readonly AgentStatus[] = [
  "created",
  "started",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export const AGENT_TERMINAL_STATUSES: readonly AgentStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export const isAgentTerminal = (status: AgentStatus): boolean =>
  AGENT_TERMINAL_STATUSES.includes(status);

type AgentTransitionTable = {
  readonly [S in AgentStatus]: Readonly<Partial<Record<AgentTransitionEvent, AgentStatus>>>;
};

/**
 * The complete table.
 *
 * Note what `created` cannot do: it cannot complete, fail or be interrupted. A
 * process that never started cannot have completed, and an adapter reporting
 * otherwise is a defect worth a loud refusal.
 */
export const AGENT_TRANSITIONS: AgentTransitionTable = {
  created: { start: "started", cancel: "cancelled" },
  started: {
    complete: "completed",
    fail: "failed",
    cancel: "cancelled",
    interrupt: "interrupted",
  },
  completed: {},
  failed: {},
  cancelled: {},
  interrupted: {},
};

export const nextAgentStatus = (
  from: AgentStatus,
  event: AgentTransitionEvent,
): AgentStatus | undefined => AGENT_TRANSITIONS[from][event];

export const canTransitionAgent = (from: AgentStatus, event: AgentTransitionEvent): boolean =>
  nextAgentStatus(from, event) !== undefined;

export const legalAgentEventsFrom = (from: AgentStatus): readonly AgentTransitionEvent[] =>
  AGENT_TRANSITION_EVENTS.filter((event) => canTransitionAgent(from, event));

/** The one event that moves an agent from `from` to `to`, if any does. */
export const agentEventFor = (
  from: AgentStatus,
  to: AgentStatus,
): AgentTransitionEvent | undefined =>
  legalAgentEventsFrom(from).find((event) => nextAgentStatus(from, event) === to);

export interface AgentOutcome {
  readonly at: IsoTimestamp;
  /** Required for every terminal status but `completed`. */
  readonly outcomeReason?: string;
  /** The harness process exit code, where the adapter exposes one. */
  readonly exitCode?: number;
}

/**
 * Applies `event` to `agent`, returning a new agent.
 *
 * `start` stamps `startedAt`; every ending stamps `endedAt`. Both are required
 * rather than optional at those points: an agent that ran at no particular time
 * cannot be placed in a run's history.
 */
export const transitionAgent = (
  agent: Agent,
  event: AgentTransitionEvent,
  outcome: AgentOutcome,
): Agent => {
  const next = nextAgentStatus(agent.status, event);
  if (next === undefined) throw new IllegalTransitionError(agent.status, event);

  if (next === "started") return { ...agent, status: next, startedAt: outcome.at };

  if (next !== "completed" && outcome.outcomeReason === undefined) {
    throw new OutcomeReasonRequiredError("agent", next);
  }
  return {
    ...agent,
    status: next,
    endedAt: outcome.at,
    ...(outcome.outcomeReason === undefined ? {} : { outcomeReason: outcome.outcomeReason }),
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
  };
};

/** Fixed when the identity is created. Rewriting any of them rewrites history. */
export const IMMUTABLE_AGENT_FIELDS = [
  "executionNodeId",
  "role",
  "harness",
  "provider",
  "model",
  "createdAt",
] as const;

/** Immutability violations in moving `existing` to `next`, ignoring the status. */
export const explainAgentUpdate = (existing: Agent, next: Agent): readonly string[] => {
  const reasons = IMMUTABLE_AGENT_FIELDS.filter((field) => existing[field] !== next[field]).map(
    (field) => `${field} cannot change once an agent exists`,
  );
  if (existing.startedAt !== undefined && next.startedAt !== existing.startedAt) {
    reasons.push("startedAt cannot change once it is set");
  }
  if (existing.endedAt !== undefined && next.endedAt !== existing.endedAt) {
    reasons.push("endedAt cannot change once it is set");
  }
  if (existing.sessionId !== undefined && next.sessionId !== existing.sessionId) {
    reasons.push("sessionId cannot change once it is set");
  }
  return reasons;
};

/**
 * Every way `agent`'s timing fields disagree with its status.
 *
 * Applies to a freshly created agent as much as to an updated one: an agent
 * created as `started` with no `startedAt` is the same defect as an update that
 * forgets it.
 */
export const explainAgentEnding = (agent: Agent): readonly string[] => {
  const reasons: string[] = [];
  if (isAgentTerminal(agent.status)) {
    if (agent.endedAt === undefined) reasons.push(`a ${agent.status} agent must carry endedAt`);
    if (agent.status !== "completed" && agent.outcomeReason === undefined) {
      reasons.push(`a ${agent.status} agent must carry outcomeReason`);
    }
  } else if (agent.endedAt !== undefined) {
    reasons.push(`a ${agent.status} agent has not ended, so it must not carry endedAt`);
  }
  if (agent.status === "created" && agent.startedAt !== undefined) {
    reasons.push("a created agent has not started, so it must not carry startedAt");
  }
  if (agent.status !== "created" && agent.startedAt === undefined) {
    reasons.push(`a ${agent.status} agent must carry startedAt`);
  }
  return reasons;
};
