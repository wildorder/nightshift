/**
 * What a repair job is made of, shared by the root's `delegate` and the line
 * (P15 D-P15-04, S-02 D-02): the decision it records, and the words it appends
 * to its objective.
 */
import {
  type DecisionId,
  ExecutionNodeIdSchema,
  type Repair,
  type RepairCause,
  type Reversibility,
  ReversibilitySchema,
} from "@nightshift/contracts";
import { nowIso } from "@nightshift/core";
import type { EventOutbox, RunSession } from "@nightshift/execution";
import { z } from "zod";
import type { Runtime } from "./compose.js";
import { ToolRefusal } from "./results.js";

/** What a decision says, as `decision.record` takes it and a repair carries it. */
export const DECISION_FIELDS = {
  context: z.string().min(1),
  alternatives: z
    .array(z.object({ summary: z.string().min(1), rejectedBecause: z.string().optional() }))
    .min(1),
  choice: z.string().min(1),
  rationale: z.string().min(1),
  reversibility: ReversibilitySchema,
};

export interface DecisionInput {
  readonly context: string;
  readonly alternatives: readonly {
    readonly summary: string;
    readonly rejectedBecause?: string | undefined;
  }[];
  readonly choice: string;
  readonly rationale: string;
  readonly reversibility: Reversibility;
  readonly affectedNodes?: readonly string[] | undefined;
}

/**
 * Records a decision of the root's, as `decision.record` always has: the same
 * store, the same event. Nothing is written when the run has no checkpoint.
 */
export const recordDecision = async (
  state: { readonly runtime: Pick<Runtime, "stores" | "clock"> },
  attached: { readonly session: RunSession; readonly outbox: Pick<EventOutbox, "emit"> },
  input: DecisionInput,
  decisionId: DecisionId,
): Promise<{ readonly decisionId: DecisionId; readonly checkpointBefore: string }> => {
  const { stores, clock } = state.runtime;
  const scope = attached.session.scope;
  const checkpoints = await stores.checkpoints.listByRun(scope);
  const latest = checkpoints.items.at(-1);
  if (latest === undefined) {
    throw new ToolRefusal(
      "not_found",
      "this run has no checkpoint yet, and a decision must point at the state it was made " +
        "from. That should not happen: `nightshift run` creates one.",
    );
  }

  await stores.decisions.put({
    schemaVersion: 1,
    ...scope,
    decisionId,
    executionNodeId: attached.session.rootNodeId,
    agentId: attached.session.orchestratorAgentId,
    context: input.context,
    alternatives: input.alternatives.map((alternative) =>
      alternative.rejectedBecause === undefined
        ? { summary: alternative.summary }
        : { summary: alternative.summary, rejectedBecause: alternative.rejectedBecause },
    ),
    choice: input.choice,
    rationale: input.rationale,
    reversibility: input.reversibility,
    checkpointBefore: latest.checkpointId,
    affectedNodes: (input.affectedNodes ?? []).map((id) => ExecutionNodeIdSchema.parse(id)),
    authority: "agent",
    supersedesDecisionId: null,
    createdAt: nowIso(clock),
  });
  attached.outbox.emit({
    type: "decision.recorded",
    source: "mcp",
    payload: { decisionId, choice: input.choice, reversibility: input.reversibility },
    executionNodeId: attached.session.rootNodeId,
    agentId: attached.session.orchestratorAgentId,
  });
  return { decisionId, checkpointBefore: latest.checkpointId };
};

export const CAUSE_SENTENCE: Readonly<Record<RepairCause, string>> = {
  red_base:
    "These gates were red on the base this run started from. Fix them without weakening required verification.",
  flaky:
    "These gates failed and then passed when verification reran them on the same commit: they " +
    "are flaky. The work that met the flake landed; this repair runs off the blocking path.",
  line_conflict:
    "A range published to the project line conflicted with the line. Resolve it without weakening required verification.",
  line_red:
    "The project line was red once a range was composed onto it. Fix the gates without weakening required verification.",
};

/** The paragraph Nightshift appends to every repair's objective, and the decision behind it. */
export const repairObjective = (
  objective: string,
  repair: Repair,
  decision: DecisionInput,
): string =>
  [
    objective.trim(),
    "",
    `REPAIR (${repair.cause}) — the gates: ${repair.gates.join(", ")}.`,
    `${CAUSE_SENTENCE[repair.cause]} The gate standard holds: the fix must keep each gate at ` +
      "least as strong as it was. Weakening a gate (a retry wrapper, a looser assertion, a " +
      "deleted or skipped test, a removed check) is a blocking finding unless the decision below " +
      "says why. A repair may change anything it needs to, setup and gate commands included " +
      "(nightshift.config.json, the contract's setup and verification); a changed gate definition " +
      "applies to verifications after the repair lands. It is examined at high risk.",
    "",
    `THE DECISION RECORDED WITH THIS REPAIR (${repair.decisionId})`,
    `Context: ${decision.context}`,
    `Choice: ${decision.choice}`,
    `Rationale: ${decision.rationale}`,
    ...decision.alternatives.map(
      (alternative) =>
        `Rejected: ${alternative.summary}` +
        (alternative.rejectedBecause === undefined ? "" : ` — ${alternative.rejectedBecause}`),
    ),
    `Reversibility: ${decision.reversibility}`,
  ].join("\n");
