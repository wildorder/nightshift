/**
 * Who may examine, who may arbitrate, and what may change on an examination
 * once it is written (P8, D-P8-10, D-P8-12, D-P8-13).
 *
 * The independence rules are checked twice: by the execution layer when it
 * chooses an examiner or an arbiter, and again by the API when either writes its
 * verdict, against the agents the control plane holds. An examiner or arbiter
 * that should not have been chosen therefore cannot record anything, whatever it
 * says about itself (SC-P8-10).
 */
import {
  blockingFindings,
  type Examination,
  type ExaminationRequirement,
  type FindingResolution,
} from "@nightshift/contracts";

/** Enough of an agent to judge independence: which agent, and what it ran on. */
export interface AgentRoute {
  readonly agentId: string;
  readonly provider: string;
  readonly model: string;
}

export type IndependenceRefusal = "same_agent" | "same_model" | "same_provider";

export interface IndependenceProblem {
  readonly reason: IndependenceRefusal;
  readonly detail: string;
}

/**
 * Why `examiner` may not examine `implementer`'s work under `requirement`. Empty
 * when it may. Self-examination is always refused; a shared model or provider
 * only when the requirement asks for a difference.
 */
export const mayExamine = (
  requirement: Pick<ExaminationRequirement, "mustDifferModel" | "mustDifferProvider">,
  implementer: AgentRoute,
  examiner: AgentRoute,
): readonly IndependenceProblem[] => {
  const problems: IndependenceProblem[] = [];
  if (implementer.agentId === examiner.agentId) {
    problems.push({ reason: "same_agent", detail: "an agent may not examine its own work" });
  }
  if (requirement.mustDifferModel && implementer.model === examiner.model) {
    problems.push({
      reason: "same_model",
      detail: `the policy requires a different model, and both ran ${implementer.model}`,
    });
  }
  if (requirement.mustDifferProvider && implementer.provider === examiner.provider) {
    problems.push({
      reason: "same_provider",
      detail: `the policy requires a different provider, and both are ${implementer.provider}`,
    });
  }
  return problems;
};

/**
 * Why `arbiter` may not rule between `implementer` and `examiner` (D-P8-13).
 * It may be neither of them. It may share a model with one, as a fresh
 * invocation, when the highest tier has nothing else (as amended 2026-09-26):
 * a weaker judge was the worse trade, and the report counts how often such an
 * arbiter agrees with its sibling.
 */
export const mayArbitrate = (
  implementer: AgentRoute,
  examiner: AgentRoute,
  arbiter: AgentRoute,
): readonly IndependenceProblem[] => {
  const problems: IndependenceProblem[] = [];
  if (arbiter.agentId === implementer.agentId || arbiter.agentId === examiner.agentId) {
    problems.push({
      reason: "same_agent",
      detail: "an arbiter may not be either side of the dispute",
    });
  }
  return problems;
};

/**
 * Where a finding's resolution may go from where it stands. Forward only:
 * `unresolved` to anything but itself; `disputed` to a ruling or a human's
 * acceptance; every other resolution is an ending.
 */
export const FINDING_RESOLUTION_MOVES: Readonly<
  Record<FindingResolution, readonly FindingResolution[]>
> = {
  unresolved: ["fixed", "disputed", "risk_accepted"],
  disputed: ["overturned", "upheld", "risk_accepted"],
  fixed: [],
  overturned: [],
  upheld: [],
  risk_accepted: [],
};

/** Every field of an examination but its findings' resolutions. */
const IMMUTABLE_EXAMINATION_FIELDS = [
  "schemaVersion",
  "projectId",
  "programId",
  "runId",
  "examinationId",
  "executionNodeId",
  "verificationId",
  "commitSha",
  "patchId",
  "implementerAgentId",
  "examinerAgentId",
  "examinerRoute",
  "requiredByRisk",
  "blocking",
  "fixAttempt",
  "questions",
  "followsRulings",
  "outcome",
  "reportArtifactId",
  "createdAt",
] as const satisfies readonly (keyof Examination)[];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type Finding = Examination["findings"][number];

/** Why `after` may not replace `before`: only the resolution moves, forward, and says who moved it. */
const explainFindingUpdate = (before: Finding, after: Finding): readonly string[] => {
  const { resolution: _a, resolvedBy: _b, ...beforeRest } = before;
  const { resolution: _c, resolvedBy: _d, ...afterRest } = after;
  if (!same(beforeRest, afterRest)) return [`finding ${before.id} may change only its resolution`];
  if (before.resolution === after.resolution) {
    return same(before.resolvedBy, after.resolvedBy)
      ? []
      : [`finding ${before.id}'s resolution is already recorded`];
  }
  const problems: string[] = [];
  if (!FINDING_RESOLUTION_MOVES[before.resolution].includes(after.resolution)) {
    problems.push(
      `finding ${before.id} may not move from ${before.resolution} to ${after.resolution}`,
    );
  }
  if (after.resolvedBy === undefined) {
    problems.push(`finding ${before.id}'s new resolution must say who moved it`);
  }
  if (after.resolution === "risk_accepted" && after.resolvedBy?.authority !== "human") {
    problems.push(`only a human may accept the risk of finding ${before.id}`);
  }
  const ruled = after.resolution === "overturned" || after.resolution === "upheld";
  if (ruled && after.resolvedBy?.decisionId === undefined) {
    problems.push(`an arbiter's ruling on finding ${before.id} must name its decision`);
  }
  return problems;
};

/**
 * Why `next` may not replace `existing` (D-P8-13). Empty when it may, including
 * when the two are identical. The verdict and its evidence never change; a
 * finding's resolution moves forward along {@link FINDING_RESOLUTION_MOVES},
 * and only a human may accept a risk.
 */
export const explainExaminationUpdate = (
  existing: Examination,
  next: Examination,
): readonly string[] => {
  const problems: string[] = [];
  for (const field of IMMUTABLE_EXAMINATION_FIELDS) {
    if (!same(existing[field], next[field]))
      problems.push(`${field} is immutable once an examination is recorded`);
  }
  if (existing.findings.length !== next.findings.length) {
    problems.push("findings may not be added or removed once an examination is recorded");
    return problems;
  }
  existing.findings.forEach((before, index) => {
    const after = next.findings[index];
    if (after !== undefined) problems.push(...explainFindingUpdate(before, after));
  });
  return problems;
};

/**
 * Whether an examination stops its work landing (D-P8-13): a blocking policy
 * and a material finding that still stands, about the ruling when the attempt
 * carried one out.
 */
export const examinationBlocks = (
  examination: Pick<Examination, "blocking" | "findings" | "followsRulings">,
): boolean => blockingFindings(examination).length > 0;
