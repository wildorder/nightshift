/**
 * Whether a plan is executable, and what the engine schedules by (P7; D-P7-04,
 * D-P7-07, SC-P7-03, SC-P7-07, SC-P7-08).
 *
 * Ratifying a plan is a judgement and a human's. Whether a plan *can be run* is
 * not, and no model decides it: everything here is a pure function of the
 * contract and the text of the plan document, handed in. This module reads
 * nothing.
 *
 * ## Scope overlap is conservative
 *
 * Two strands with no dependency path between them will be run at once by the
 * engine, so overlapping scopes between them is P6's likeliest failure found at
 * the level where a human can fix it by moving a boundary. Deciding whether two
 * arbitrary globs share a path is answered segment-wise, and **a possible
 * overlap is an overlap**: a false alarm costs a `dependsOn` or a narrower
 * scope, either of which is a better plan, while a missed one costs a night.
 */
import type {
  ExecutionNode,
  ExecutionNodeStatus,
  PlannedDecision,
  Prerequisite,
  ProgramContract,
  Story,
  Strand,
  StrandScope,
} from "@nightshift/contracts";
import { humanSaid, type KeptConversation } from "./conversation.js";
import { buildTree, descendantsOf } from "./execution-tree.js";
import { explainWidening, globContains, singleSegmentMatches } from "./scope.js";

// --- the planned part of a contract, absent meaning empty ---------------------

export const strandsOf = (contract: ProgramContract): readonly Strand[] => contract.strands ?? [];

export const prerequisitesOf = (contract: ProgramContract): readonly Prerequisite[] =>
  contract.prerequisites ?? [];

/** A contract with strands is a planned program; one without runs as programs always have. */
export const programStories = (contract: ProgramContract): readonly Story[] =>
  contract.stories ?? [];

/** Whether the planning conversation is kept for this program (D-P14-06): on unless turned off. */
export const keepsConversation = (contract: ProgramContract): boolean =>
  contract.keepConversation !== false;

export const isPlanned = (contract: ProgramContract): boolean => strandsOf(contract).length > 0;

/**
 * Whether a run of this contract may start (D-P7-02). A contract with no strands
 * is not gated; a planned one runs only once a human has ratified it.
 */
export const mayRunContract = (contract: ProgramContract): boolean =>
  !isPlanned(contract) || contract.status === "ratified";

// --- glob overlap -------------------------------------------------------------

const segments = (glob: string): readonly string[] => glob.split("/").filter((s) => s.length > 0);

const hasWildcard = (segment: string): boolean => segment.includes("*") || segment.includes("?");

/** The literal text before a segment pattern's first wildcard, and after its last. */
const literalEnds = (pattern: string): { readonly prefix: string; readonly suffix: string } => {
  const first = pattern.search(/[*?]/);
  const last = Math.max(pattern.lastIndexOf("*"), pattern.lastIndexOf("?"));
  return { prefix: pattern.slice(0, first), suffix: pattern.slice(last + 1) };
};

/**
 * Whether some single path segment could match both patterns.
 *
 * Exact when either side is literal. With wildcards on both sides it compares
 * only the literal ends: a segment matching both starts with both prefixes and
 * ends with both suffixes, so incompatible ends prove there is none (`*.ts`
 * against `*.md`); anything else is called an overlap.
 */
const segmentsMayOverlap = (a: string, b: string): boolean => {
  if (!hasWildcard(a)) return singleSegmentMatches(b, a);
  if (!hasWildcard(b)) return singleSegmentMatches(a, b);
  const ends = [literalEnds(a), literalEnds(b)] as const;
  const [x, y] = ends;
  const prefixesAgree = x.prefix.startsWith(y.prefix) || y.prefix.startsWith(x.prefix);
  const suffixesAgree = x.suffix.endsWith(y.suffix) || y.suffix.endsWith(x.suffix);
  return prefixesAgree && suffixesAgree;
};

const overlapFrom = (
  a: readonly string[],
  ai: number,
  b: readonly string[],
  bi: number,
): boolean => {
  const headA = a[ai];
  const headB = b[bi];
  if (headA === undefined && headB === undefined) return true;
  // `**` stands for no segment, or for one more of the other side's.
  if (headA === "**") {
    return overlapFrom(a, ai + 1, b, bi) || (headB !== undefined && overlapFrom(a, ai, b, bi + 1));
  }
  if (headB === "**") {
    return overlapFrom(a, ai, b, bi + 1) || (headA !== undefined && overlapFrom(a, ai + 1, b, bi));
  }
  if (headA === undefined || headB === undefined) return false;
  return segmentsMayOverlap(headA, headB) && overlapFrom(a, ai + 1, b, bi + 1);
};

/** Whether some repository path could match both globs. Symmetric, and conservative. */
export const globsMayOverlap = (a: string, b: string): boolean =>
  overlapFrom(segments(a), 0, segments(b), 0);

/** Two include globs, one from each scope, that may share a path no exclude removes. */
export interface GlobIntersection {
  readonly a: string;
  readonly b: string;
}

/**
 * Every pair of includes, one from each scope, that may share a path.
 *
 * An exclude clears a pair when it provably covers one of the two includes
 * whole (`globContains`), because what the pair shares lies inside both. An
 * exclude that only *might* cover the intersection clears nothing.
 */
export const scopeIntersections = (a: StrandScope, b: StrandScope): readonly GlobIntersection[] => {
  const excludes = [...a.excludes, ...b.excludes];
  const removed = (glob: string): boolean =>
    excludes.some((exclude) => globContains(exclude, glob));
  const found: GlobIntersection[] = [];
  for (const includeA of a.includes) {
    for (const includeB of b.includes) {
      if (!globsMayOverlap(includeA, includeB)) continue;
      if (removed(includeA) || removed(includeB)) continue;
      found.push({ a: includeA, b: includeB });
    }
  }
  return found;
};

export const scopesOverlap = (a: StrandScope, b: StrandScope): boolean =>
  scopeIntersections(a, b).length > 0;

// --- the dependency graph -----------------------------------------------------

/** Strand id → the ids it depends on that exist. An unknown `dependsOn` is a reason, not an edge. */
const dependencyEdges = (strands: readonly Strand[]): ReadonlyMap<string, readonly string[]> => {
  const known = new Set(strands.map((strand) => strand.id));
  return new Map(
    strands.map((strand) => [strand.id, strand.dependsOn.filter((id) => known.has(id))]),
  );
};

/** Everything reachable from `id` along `edges`, not including `id` unless it is on a cycle. */
const reachableFrom = (
  edges: ReadonlyMap<string, readonly string[]>,
  id: string,
): ReadonlySet<string> => {
  const seen = new Set<string>();
  const stack = [...(edges.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return seen;
};

/** One dependency cycle as the ids along it, first repeated last; `undefined` when acyclic. */
export const findDependencyCycle = (strands: readonly Strand[]): readonly string[] | undefined => {
  const edges = dependencyEdges(strands);
  const done = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): readonly string[] | undefined => {
    const at = path.indexOf(id);
    if (at >= 0) return [...path.slice(at), id];
    if (done.has(id)) return undefined;
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    done.add(id);
    return undefined;
  };

  for (const strand of strands) {
    const cycle = visit(strand.id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
};

export interface StrandOverlap {
  readonly a: Strand;
  readonly b: Strand;
  readonly intersections: readonly GlobIntersection[];
}

/**
 * Pairs of strands the engine may run at once whose scopes overlap: no
 * dependency path between them in either direction, and at least one
 * intersection. A `dependsOn` in either direction, however long the path,
 * clears a pair, because the engine then never runs the two together.
 */
export const independentOverlaps = (strands: readonly Strand[]): readonly StrandOverlap[] => {
  const edges = dependencyEdges(strands);
  const upstream = new Map(strands.map((strand) => [strand.id, reachableFrom(edges, strand.id)]));
  const found: StrandOverlap[] = [];
  for (const [index, a] of strands.entries()) {
    for (const b of strands.slice(index + 1)) {
      if (upstream.get(a.id)?.has(b.id) === true || upstream.get(b.id)?.has(a.id) === true) {
        continue;
      }
      const intersections = scopeIntersections(a.scope, b.scope);
      if (intersections.length > 0) found.push({ a, b, intersections });
    }
  }
  return found;
};

// --- gating and the cone ------------------------------------------------------

/**
 * How a strand stands, as the engine sees it. `succeeded` is the only outcome a
 * dependent may build on; `failed` and `cancelled` park it (§4.4).
 */
export type StrandOutcome =
  | "pending"
  | "running"
  | "succeeded"
  /**
   * Done, on the run's provisional line (D-P7-10): a check is deferred for a
   * human prerequisite. A dependent may build on it, which is the bet the owner
   * chose; the program branch has none of it until the deferred checks pass.
   */
  | "provisional"
  | "failed"
  | "cancelled";

export type StrandOutcomes = Readonly<Record<string, StrandOutcome | undefined>>;

const outcomeOf = (outcomes: StrandOutcomes, id: string): StrandOutcome =>
  outcomes[id] ?? "pending";

/** What a dependent strand may start on: work that landed, or that stands on the provisional line. */
const canBuildOn = (outcome: StrandOutcome): boolean =>
  outcome === "succeeded" || outcome === "provisional";

const isParked = (outcome: StrandOutcome): boolean =>
  outcome === "failed" || outcome === "cancelled";

/** One attempt at a strand: the node that ran it, as the control plane records it. */
export interface StrandAttempt {
  readonly strandId: string;
  readonly status: ExecutionNodeStatus;
  readonly createdAt: string;
  /**
   * True when something under the strand's node is `deferred` (D-P7-10). Its
   * orchestrator may well have finished; its work has not reached the program
   * branch, and saying "succeeded" of it would be the report's first lie.
   */
  readonly hasDeferredWork?: boolean;
}

const outcomeOfStatus = (status: ExecutionNodeStatus): StrandOutcome => {
  if (status === "succeeded" || status === "integrated") return "succeeded";
  if (status === "deferred") return "provisional";
  if (status === "cancelled") return "cancelled";
  // `interrupted` and the failed verdicts are all "did not succeed, may be tried again".
  if (status === "failed" || status === "interrupted") return "failed";
  if (status === "verification_failed" || status === "examination_failed") return "failed";
  return "running";
};

/**
 * Where every strand stands, from the run's own records. A strand tried twice
 * stands where its **latest** attempt does, so one that failed and was delegated
 * again is running again, and its cone is no longer blocked by it.
 *
 * A strand the run carried over from an earlier run of the same plan
 * (`Run.carriedStrands`) has succeeded: its work is on the program branch. An
 * attempt at it in this run, which nothing should make, would stand instead.
 */
export const strandOutcomes = (
  attempts: readonly StrandAttempt[],
  carried: readonly { readonly strandId: string }[] = [],
): StrandOutcomes => {
  const latest = new Map<string, StrandAttempt>();
  for (const attempt of attempts) {
    const seen = latest.get(attempt.strandId);
    if (seen === undefined || seen.createdAt <= attempt.createdAt) {
      latest.set(attempt.strandId, attempt);
    }
  }
  return Object.fromEntries([
    ...carried.map(({ strandId }) => [strandId, "succeeded"] as const),
    ...[...latest].map(([strandId, attempt]) => {
      const outcome = outcomeOfStatus(attempt.status);
      return [
        strandId,
        outcome === "succeeded" && attempt.hasDeferredWork === true ? "provisional" : outcome,
      ] as const;
    }),
  ]);
};

/**
 * Every attempt at every strand, from a run's nodes and the strand each node's
 * Job Contract names. One definition, for the engine that gates by it and the
 * report that tells a human about it.
 */
export const strandAttempts = (
  nodes: readonly ExecutionNode[],
  strandOfJob: ReadonlyMap<string, string>,
): readonly StrandAttempt[] => {
  const tree = buildTree(nodes);
  return nodes.flatMap((node) => {
    const strandId = node.jobContractId === null ? undefined : strandOfJob.get(node.jobContractId);
    if (strandId === undefined) return [];
    const hasDeferredWork = descendantsOf(tree, node.executionNodeId).some(
      (id) => tree.nodes.get(id)?.status === "deferred",
    );
    return [{ strandId, status: node.status, createdAt: node.createdAt, hasDeferredWork }];
  });
};

const requireStrand = (contract: ProgramContract, id: string): Strand => {
  const strand = strandsOf(contract).find((candidate) => candidate.id === id);
  if (strand === undefined) throw new RangeError(`the contract has no strand ${id}`);
  return strand;
};

export type StrandStart =
  | { readonly start: true }
  /** `waitingFor` names the strands it depends on that have not succeeded yet. */
  | { readonly start: false; readonly waitingFor: readonly string[] };

/** The strands `id` depends on that have not succeeded. Empty means nothing holds it. */
export const strandWaitingFor = (
  contract: ProgramContract,
  outcomes: StrandOutcomes,
  id: string,
): readonly string[] =>
  requireStrand(contract, id).dependsOn.filter((dep) => !canBuildOn(outcomeOf(outcomes, dep)));

/**
 * Whether the engine may start a strand: never before every strand it depends
 * on has succeeded, under any finishing order (SC-P7-07). A strand that is
 * already running or settled is not started again.
 */
export const mayStartStrand = (
  contract: ProgramContract,
  outcomes: StrandOutcomes,
  id: string,
): StrandStart => {
  const waitingFor = strandWaitingFor(contract, outcomes, id);
  if (waitingFor.length > 0) return { start: false, waitingFor };
  if (outcomeOf(outcomes, id) !== "pending") return { start: false, waitingFor: [] };
  return { start: true };
};

/**
 * Everything that depends on `id`, transitively, in the contract's own order.
 * What is parked when `id` fails, and the cone P9 replays when a decision made
 * in `id` is reversed.
 */
export const downstreamCone = (contract: ProgramContract, id: string): readonly string[] => {
  requireStrand(contract, id);
  const strands = strandsOf(contract);
  const edges = dependencyEdges(strands);
  return strands
    .filter((strand) => strand.id !== id && reachableFrom(edges, strand.id).has(id))
    .map((strand) => strand.id);
};

/**
 * Strand id → the strands that block it, for every strand that can no longer
 * run. A blocker is a strand that settled without succeeding and was not itself
 * blocked: the report names the strand that broke, not the first casualty.
 */
export const blockedBy = (
  contract: ProgramContract,
  outcomes: StrandOutcomes,
): ReadonlyMap<string, readonly string[]> => {
  const strands = strandsOf(contract);
  const edges = dependencyEdges(strands);
  const parkedUpstream = (id: string): readonly string[] =>
    [...reachableFrom(edges, id)].filter((up) => up !== id && isParked(outcomeOf(outcomes, up)));

  const blocked = new Map<string, readonly string[]>();
  for (const strand of strands) {
    const blockers = parkedUpstream(strand.id)
      .filter((up) => parkedUpstream(up).length === 0)
      .sort();
    if (blockers.length > 0) blocked.set(strand.id, blockers);
  }
  return blocked;
};

// --- the plan document --------------------------------------------------------

/** Strand id → its section of the plan document, heading included. */
export type PlanSections = Readonly<Record<string, string | undefined>>;

const HEADING = /^(#{1,6})\s+(.*)$/;
const STRAND_HEADING = /^(S-\d{2,})\b/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Splits a plan document into its strand sections. A strand's section starts at
 * the heading whose text begins with its id (`### S-01 Name`) and runs to the
 * next heading of the same or a higher level. Headings inside a fenced code
 * block are text. A strand's orchestrator is handed this, verbatim (D-P7-04).
 */
export const splitPlanSections = (planText: string): PlanSections => {
  const sections: Record<string, string> = {};
  let open: OpenSection | undefined;
  let fenced = false;

  const close = (): void => {
    // The first section under an id wins; a second heading with it is prose about it.
    if (open !== undefined && sections[open.id] === undefined) {
      sections[open.id] = open.lines.join("\n").trimEnd();
    }
    open = undefined;
  };

  for (const line of normalizePlanText(planText).split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : headingOf(line);
    if (heading !== undefined && open !== undefined && heading.level <= open.level) close();
    if (heading?.strandId !== undefined && open === undefined) {
      open = { id: heading.strandId, level: heading.level, lines: [line] };
    } else {
      open?.lines.push(line);
    }
  }
  close();
  return sections;
};

interface OpenSection {
  readonly id: string;
  readonly level: number;
  readonly lines: string[];
}

const headingOf = (
  line: string,
): { readonly level: number; readonly strandId: string | undefined } | undefined => {
  const heading = HEADING.exec(line);
  if (heading === null) return undefined;
  return {
    level: (heading[1] ?? "").length,
    strandId: STRAND_HEADING.exec(heading[2] ?? "")?.[1],
  };
};

/** Whether a section says anything: some line that is neither blank nor a heading. */
const sectionHasBody = (section: string | undefined): boolean =>
  (section ?? "").split("\n").some((line) => line.trim() !== "" && !HEADING.test(line));

// --- readiness ----------------------------------------------------------------

export type PlanReason =
  | { readonly kind: "no_strands"; readonly message: string }
  /**
   * P9 (D-P9-04): a correction names a decision that is not there, or not
   * reversed by a human. Found against the control plane, never by `checkPlan`,
   * which reads only the files.
   */
  | { readonly kind: "correction_invalid"; readonly message: string }
  | { readonly kind: "unclaimed_criterion"; readonly criterionId: string; readonly message: string }
  | {
      readonly kind: "unknown_criterion";
      readonly strandId: string;
      readonly criterionId: string;
      readonly message: string;
    }
  | {
      readonly kind: "scope_outside_program";
      readonly strandId: string;
      readonly message: string;
    }
  | {
      readonly kind: "unknown_dependency";
      readonly strandId: string;
      readonly dependsOn: string;
      readonly message: string;
    }
  | {
      readonly kind: "dependency_cycle";
      readonly cycle: readonly string[];
      readonly message: string;
    }
  | { readonly kind: "missing_section"; readonly strandId: string; readonly message: string }
  | {
      readonly kind: "unknown_prerequisite";
      readonly strandId: string;
      readonly prerequisiteId: string;
      readonly message: string;
    }
  | {
      readonly kind: "prerequisite_without_remediation";
      readonly prerequisiteId: string;
      readonly message: string;
    }
  | {
      readonly kind: "prerequisite_without_verify_command";
      readonly prerequisiteId: string;
      readonly message: string;
    }
  | {
      readonly kind: "unknown_step_prerequisite";
      readonly stepId: string;
      readonly prerequisiteId: string;
      readonly message: string;
    }
  | {
      readonly kind: "unused_prerequisite";
      readonly prerequisiteId: string;
      readonly message: string;
    }
  | { readonly kind: "unanswered_decision"; readonly decisionId: string; readonly message: string }
  /** P14 (D-P14-02, D-P14-04): why the program exists, and the human's words for it. */
  | { readonly kind: "no_stories"; readonly message: string }
  | {
      readonly kind: "story_incomplete";
      readonly storyId: string;
      readonly missing: readonly ("who" | "problem" | "outcome")[];
      readonly message: string;
    }
  | { readonly kind: "unserved_story"; readonly storyId: string; readonly message: string }
  | {
      readonly kind: "criterion_serves_no_story";
      readonly criterionId: string;
      readonly message: string;
    }
  | {
      readonly kind: "unknown_story";
      readonly criterionId: string;
      readonly storyId: string;
      readonly message: string;
    }
  | { readonly kind: "conversation_missing"; readonly message: string }
  | {
      readonly kind: "quote_not_found";
      readonly storyId: string;
      readonly quote: string;
      readonly message: string;
    }
  | {
      readonly kind: "unknown_decision_strand";
      readonly decisionId: string;
      readonly strandId: string;
      readonly message: string;
    }
  | {
      readonly kind: "scope_overlap";
      readonly strandIds: readonly [string, string];
      readonly intersections: readonly GlobIntersection[];
      readonly message: string;
    }
  /**
   * P15 (D-P15-08): the gates' audit. Found against the project's gate-health
   * record on the control plane, never by `checkPlan`, which reads only the
   * files; `gateHealthReasons` says them.
   */
  | { readonly kind: "gate_health_unrecorded"; readonly message: string }
  /** The record could not be read, or the fingerprint not computed: not signed in, out of reach. */
  | { readonly kind: "gate_health_unreadable"; readonly message: string }
  | {
      readonly kind: "gate_health_stale";
      readonly commit: string;
      readonly message: string;
    }
  | {
      readonly kind: "gate_finding_unanswered";
      readonly findingId: string;
      readonly decisionId: string;
      readonly message: string;
    }
  | { readonly kind: "gate_health_strand_missing"; readonly message: string }
  | {
      readonly kind: "gate_health_strand_not_first";
      readonly strandId: string;
      readonly message: string;
    };

export type PlanReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reasons: readonly PlanReason[] };

const describeScope = (strand: Strand): string =>
  `  ${strand.id} ${strand.name}\n    includes: ${strand.scope.includes.join(", ")}\n    excludes: ${
    strand.scope.excludes.length > 0 ? strand.scope.excludes.join(", ") : "(none)"
  }`;

/** The two scopes side by side, and which globs intersect: this is the check people argue with. */
const overlapMessage = (overlap: StrandOverlap): string =>
  [
    `${overlap.a.id} and ${overlap.b.id} have no dependency path between them, so they may run at once, and their scopes may overlap:`,
    describeScope(overlap.a),
    describeScope(overlap.b),
    ...overlap.intersections.map(
      (pair) => `  "${pair.a}" (${overlap.a.id}) intersects "${pair.b}" (${overlap.b.id})`,
    ),
    "  Add a dependsOn between them, or narrow a scope (an exclude that covers the other's include clears it).",
  ].join("\n");

const criteriaReasons = (contract: ProgramContract, strands: readonly Strand[]): PlanReason[] => {
  const known = new Set(contract.successCriteria.map((criterion) => criterion.id));
  const claimed = new Set(strands.flatMap((strand) => strand.successCriteria));
  const unclaimed = contract.successCriteria
    .filter((criterion) => !claimed.has(criterion.id))
    .map(
      (criterion): PlanReason => ({
        kind: "unclaimed_criterion",
        criterionId: criterion.id,
        message: `success criterion ${criterion.id} is claimed by no strand`,
      }),
    );
  const unknown = strands.flatMap((strand) =>
    strand.successCriteria
      .filter((criterionId) => !known.has(criterionId))
      .map(
        (criterionId): PlanReason => ({
          kind: "unknown_criterion",
          strandId: strand.id,
          criterionId,
          message: `${strand.id} claims success criterion ${criterionId}, which the contract does not have`,
        }),
      ),
  );
  return [...unclaimed, ...unknown];
};

const strandReasons = (
  contract: ProgramContract,
  strand: Strand,
  planSections: PlanSections,
): PlanReason[] => {
  const strandIds = new Set(strandsOf(contract).map((candidate) => candidate.id));
  const prerequisiteIds = new Set(prerequisitesOf(contract).map((candidate) => candidate.id));
  const reasons: PlanReason[] = [];

  // Excludes are inherited from the program, so only the includes can widen.
  const widenings = explainWidening(contract.scope, { includes: strand.scope.includes });
  if (widenings.length > 0) {
    reasons.push({
      kind: "scope_outside_program",
      strandId: strand.id,
      message: `${strand.id}'s scope is outside the program's: ${widenings.join("; ")}`,
    });
  }
  for (const dependsOn of strand.dependsOn.filter((id) => !strandIds.has(id))) {
    reasons.push({
      kind: "unknown_dependency",
      strandId: strand.id,
      dependsOn,
      message: `${strand.id} depends on ${dependsOn}, which is not a strand of this program`,
    });
  }
  if (!sectionHasBody(planSections[strand.id])) {
    reasons.push({
      kind: "missing_section",
      strandId: strand.id,
      message: `${strand.id} has no section in the plan document (a heading starting "${strand.id}" with text under it)`,
    });
  }
  for (const prerequisiteId of strand.prerequisites.filter((id) => !prerequisiteIds.has(id))) {
    reasons.push({
      kind: "unknown_prerequisite",
      strandId: strand.id,
      prerequisiteId,
      message: `${strand.id} needs ${prerequisiteId}, which the contract does not have`,
    });
  }
  return reasons;
};

/** A verification step that waits on a prerequisite the contract does not have. */
const stepReasons = (contract: ProgramContract): PlanReason[] => {
  const known = new Set(prerequisitesOf(contract).map((prerequisite) => prerequisite.id));
  return contract.verification.flatMap((step) =>
    (step.requires ?? [])
      .filter((id) => !known.has(id))
      .map(
        (prerequisiteId): PlanReason => ({
          kind: "unknown_step_prerequisite",
          stepId: step.id,
          prerequisiteId,
          message: `verification step ${step.id} requires ${prerequisiteId}, which the contract does not have`,
        }),
      ),
  );
};

const prerequisiteReasons = (
  prerequisite: Prerequisite,
  used: ReadonlySet<string>,
): PlanReason[] => {
  // A hurdle the engine found mid-run is not the plan's to account for.
  if (prerequisite.discoveredInRunId !== undefined) return [];
  const reasons: PlanReason[] = [];
  if (prerequisite.remediation.trim() === "") {
    reasons.push({
      kind: "prerequisite_without_remediation",
      prerequisiteId: prerequisite.id,
      message: `${prerequisite.id} has no remediation: the exact commands or console steps a human follows`,
    });
  }
  if (prerequisite.verifyCommand.trim() === "") {
    reasons.push({
      kind: "prerequisite_without_verify_command",
      prerequisiteId: prerequisite.id,
      message: `${prerequisite.id} has no verifyCommand: a command that exits zero iff it is done`,
    });
  }
  if (!used.has(prerequisite.id)) {
    reasons.push({
      kind: "unused_prerequisite",
      prerequisiteId: prerequisite.id,
      message: `${prerequisite.id} is needed by no strand`,
    });
  }
  return reasons;
};

const decisionReasons = (
  decision: PlannedDecision,
  strandIds: ReadonlySet<string>,
): PlanReason[] => {
  const reasons: PlanReason[] = [];
  if (decision.answer === undefined) {
    reasons.push({
      kind: "unanswered_decision",
      decisionId: decision.id,
      message: `decision ${decision.id} has no answer: "${decision.question}"`,
    });
  }
  const touched = decision.touches === "all" ? [] : decision.touches;
  for (const strandId of touched.filter((id) => !strandIds.has(id))) {
    reasons.push({
      kind: "unknown_decision_strand",
      decisionId: decision.id,
      strandId,
      message: `decision ${decision.id} touches ${strandId}, which is not a strand of this program`,
    });
  }
  return reasons;
};

const STORY_FIELDS = ["who", "problem", "outcome"] as const;

const shortQuote = (quote: string): string =>
  quote.length <= 80 ? quote : `${quote.slice(0, 77)}…`;

/**
 * Stories (P14, D-P14-02): at least one; each says who, what is wrong today and
 * what changes; every criterion serves one and every story is served. Quotes are
 * the human's own words, held to the kept conversation (D-P14-04).
 */
const storyReasons = (
  contract: ProgramContract,
  conversation: KeptConversation | undefined,
): PlanReason[] => {
  const stories = programStories(contract);
  if (stories.length === 0) {
    return [
      {
        kind: "no_stories",
        message:
          "the contract has no user stories: who the program is for, what goes wrong for them " +
          "today, and what is different for them afterwards (at least one)",
      },
    ];
  }
  const known = new Set(stories.map((story) => story.id));
  const served = new Set(contract.successCriteria.flatMap((criterion) => criterion.serves ?? []));
  const reasons: PlanReason[] = [];
  for (const story of stories) {
    const missing = STORY_FIELDS.filter((field) => story[field].trim() === "");
    if (missing.length > 0) {
      reasons.push({
        kind: "story_incomplete",
        storyId: story.id,
        missing,
        message: `${story.id} does not say ${missing.join(", ")}`,
      });
    }
    if (!served.has(story.id)) {
      reasons.push({
        kind: "unserved_story",
        storyId: story.id,
        message: `${story.id} is served by no success criterion (a criterion lists it in \`serves\`)`,
      });
    }
  }
  for (const criterion of contract.successCriteria) {
    const serves = criterion.serves ?? [];
    if (serves.length === 0) {
      reasons.push({
        kind: "criterion_serves_no_story",
        criterionId: criterion.id,
        message: `success criterion ${criterion.id} serves no story: say whose problem it checks, in \`serves\``,
      });
    }
    for (const storyId of serves.filter((id) => !known.has(id))) {
      reasons.push({
        kind: "unknown_story",
        criterionId: criterion.id,
        storyId,
        message: `success criterion ${criterion.id} serves ${storyId}, which the contract does not have`,
      });
    }
  }
  const quoted = stories.filter((story) => (story.words ?? []).length > 0);
  if (!keepsConversation(contract) || quoted.length === 0) return reasons;
  if (conversation === undefined) {
    reasons.push({
      kind: "conversation_missing",
      message:
        "the stories quote the human, and no planning conversation is kept to hold the quotes to: " +
        "run `nightshift plan conversation` (or set keepConversation to false)",
    });
    return reasons;
  }
  for (const story of quoted) {
    for (const quote of (story.words ?? []).filter((words) => !humanSaid(conversation, words))) {
      reasons.push({
        kind: "quote_not_found",
        storyId: story.id,
        quote,
        message: `${story.id} quotes "${shortQuote(quote)}", which is not in the human's kept messages word for word`,
      });
    }
  }
  return reasons;
};

/**
 * Whether a plan can be ratified (D-P7-07): `READY`, or every reason at once so
 * a plan is fixed in one pass. `contract` has already parsed; `planSections` is
 * {@link splitPlanSections} of the plan document; `conversation` is the kept
 * planning conversation, when there is one (P14).
 */
export const checkPlan = (
  contract: ProgramContract,
  planSections: PlanSections,
  conversation?: KeptConversation,
): PlanReadiness => {
  const strands = strandsOf(contract);
  const strandIds = new Set(strands.map((strand) => strand.id));
  // A prerequisite is used by a strand that needs it, or by a verification step
  // that cannot run without it (D-P7-10).
  const used = new Set([
    ...strands.flatMap((strand) => strand.prerequisites),
    ...contract.verification.flatMap((step) => step.requires ?? []),
  ]);
  const cycle = findDependencyCycle(strands);

  const reasons: PlanReason[] = [
    ...(strands.length === 0
      ? [
          {
            kind: "no_strands",
            message: "the contract has no strands; a plan has at least one (one is fine)",
          } as const,
        ]
      : []),
    ...storyReasons(contract, conversation),
    ...criteriaReasons(contract, strands),
    ...strands.flatMap((strand) => strandReasons(contract, strand, planSections)),
    ...(cycle === undefined
      ? []
      : [
          {
            kind: "dependency_cycle",
            cycle,
            message: `dependsOn has a cycle: ${cycle.join(" → ")}`,
          } as const,
        ]),
    ...stepReasons(contract),
    ...prerequisitesOf(contract).flatMap((prerequisite) => prerequisiteReasons(prerequisite, used)),
    ...(contract.decisions ?? []).flatMap((decision) => decisionReasons(decision, strandIds)),
    ...independentOverlaps(strands).map(
      (overlap): PlanReason => ({
        kind: "scope_overlap",
        strandIds: [overlap.a.id, overlap.b.id],
        intersections: overlap.intersections,
        message: overlapMessage(overlap),
      }),
    ),
  ];

  return reasons.length === 0 ? { ready: true } : { ready: false, reasons };
};

// --- the hash -----------------------------------------------------------------

/** Lowercase hex SHA-256 of a UTF-8 string. Injected: `core` imports no `node:crypto`. */
export type Sha256 = (text: string) => string;

export interface PlanHash {
  /** Over the contract, without what ratifying and preflight themselves write. */
  readonly contract: string;
  /** Over the plan document with LF line endings: the `sha256` of what is uploaded. */
  readonly plan: string;
  /** What is ratified, and what a run is checked against. */
  readonly hash: string;
}

/** The plan document as it is hashed and uploaded, so a CRLF checkout and an LF one agree. */
export const normalizePlanText = (planText: string): string => planText.replace(/\r\n?/g, "\n");

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
};

/**
 * What of a contract is *approved*. Left out: the ratification's own record
 * (`status`, `planHash`, `planDocument`, `conversation`, `ratifications`), or
 * ratifying would change the hash; each prerequisite's `status` and
 * `lastCheck`, which preflight writes, and its `machineChecks`, which a run's
 * machine writes (P16, D-08); and prerequisites the engine discovered
 * mid-run (D-P7-10). An absent planned field and an empty one are the same plan.
 *
 * P14's fields are left out when empty rather than normalised to empty, so a
 * contract ratified before P14 hashes exactly as it did.
 */
const approvedContent = (contract: ProgramContract): unknown => {
  const {
    status: _status,
    planHash: _planHash,
    planDocument: _planDocument,
    conversation: _conversation,
    ratifications: _ratifications,
    stories,
    successCriteria,
    ...rest
  } = contract;
  return {
    ...rest,
    ...(stories === undefined || stories.length === 0 ? {} : { stories }),
    successCriteria: successCriteria.map(({ serves, ...criterion }) =>
      serves === undefined || serves.length === 0 ? criterion : { ...criterion, serves },
    ),
    strands: strandsOf(contract),
    decisions: contract.decisions ?? [],
    outOfScope: contract.outOfScope ?? [],
    prerequisites: prerequisitesOf(contract)
      .filter((prerequisite) => prerequisite.discoveredInRunId === undefined)
      .map(({ status: _s, lastCheck: _c, machineChecks: _m, ...prerequisite }) => prerequisite),
  };
};

/**
 * The hash a ratification records (D-P7-02). Stable over key order and line
 * endings. The plan component is kept apart so the control plane can hold the
 * uploaded document to it without ever seeing the repository.
 */
export const planHash = (contract: ProgramContract, planText: string, sha256: Sha256): PlanHash => {
  const contractHash = sha256(JSON.stringify(canonical(approvedContent(contract))));
  const plan = sha256(normalizePlanText(planText));
  return {
    contract: contractHash,
    plan,
    hash: combinePlanHash(contractHash, plan, sha256),
  };
};

export const combinePlanHash = (contractHash: string, plan: string, sha256: Sha256): string =>
  sha256(`nightshift-plan-v1\n${contractHash}\n${plan}`);

/**
 * Whether two contracts approve the same thing: what a ratified contract may
 * not change without being ratified again.
 */
export const samePlanContent = (a: ProgramContract, b: ProgramContract): boolean =>
  JSON.stringify(canonical(approvedContent(a))) === JSON.stringify(canonical(approvedContent(b)));
