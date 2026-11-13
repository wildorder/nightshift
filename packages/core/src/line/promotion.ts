/**
 * The promotion pull request's rules (P26): what the target has that the line
 * lacks, what the line holds that the target lacks, and the words of the pull
 * request that says so. All pure: the publisher reads GitHub and writes the
 * pull request; nothing here does either.
 */
import {
  type LineComposition,
  type LineRecord,
  type LineWaiting,
  type ProgramId,
  ProgramIdSchema,
} from "@nightshift/contracts";

/** The most characters a promotion body may have; GitHub's own limit is 65536. */
export const MAX_PROMOTION_BODY_CHARS = 60_000;

/** One commit as a GitHub compare lists it. */
export interface PromotionCommit {
  readonly sha: string;
  readonly subject: string;
  readonly parents: readonly string[];
  /** The tree the commit records. */
  readonly tree: string;
}

/** A GitHub compare's result, as `GitHubPromotionClient.compare` returns it. */
export interface PromotionCompare {
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly commits: readonly PromotionCommit[];
  readonly complete: boolean;
}

export interface DivergedCommits {
  readonly commits: readonly { readonly sha: string; readonly subject: string }[];
  readonly count: number;
  readonly complete: boolean;
}

/** The most diverged commits the warning names. */
const WARNING_COMMITS = 10;
/** The most characters of any one line's free text. */
const MAX_TEXT_CHARS = 300;
/** The room each list of the body may take; the sum plus the fixed lines stays under the bound. */
const WARNING_BUDGET = 6_000;
const PROGRAMS_BUDGET = 24_000;
const REPAIRS_BUDGET = 12_000;
const VERIFICATION_BUDGET = 10_000;

const shortSha = (sha: string): string => sha.slice(0, 7);

const oneLine = (text: string, max = MAX_TEXT_CHARS): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The non-first parents of a merge commit, when none is itself target-only; else none. */
export const lineParentsOf = (
  behind: Pick<PromotionCompare, "commits">,
  commit: PromotionCommit,
): readonly string[] => {
  if (commit.parents.length < 2) return [];
  const listed = new Set(behind.commits.map((candidate) => candidate.sha));
  const others = commit.parents.slice(1);
  return others.some((parent) => listed.has(parent)) ? [] : others;
};

/**
 * The target's commits the line lacks. `behind` is `compare(base = line head,
 * head = target)`: its `commits` are the target-only ones and `aheadBy` counts
 * them. A merge commit is not divergence only with evidence that it introduced
 * nothing: every non-first parent is on the line (absent from the list) and
 * the commit's tree equals the tree of one of them (`lineParentTrees`, by
 * sha), as the merge commit of an earlier promotion does. A merge with edits,
 * a squash or rebase merge, a direct commit, or a merge without that evidence
 * is divergence. An incomplete list cannot show the exclusion, so it counts
 * `aheadBy`, conservatively diverged.
 */
export const divergedCommits = (
  behind: PromotionCompare,
  lineParentTrees: ReadonlyMap<string, string> = new Map(),
): DivergedCommits => {
  const kept = behind.commits
    .filter((commit) => {
      const parents = lineParentsOf(behind, commit);
      return !(
        parents.length > 0 && parents.some((parent) => lineParentTrees.get(parent) === commit.tree)
      );
    })
    .map((commit) => ({ sha: commit.sha, subject: commit.subject }));
  return {
    commits: kept,
    count: behind.complete ? kept.length : behind.aheadBy,
    complete: behind.complete,
  };
};

const MERGE_SUBJECT = /^Merge program (\S+) .* into the line$/;

/**
 * The programs on the line the target lacks, in the order the line took them:
 * every range program of each kept composition whose commit is in `ahead`, and
 * the programs only a commit's subject names (compositions beyond those kept).
 */
export const promotionPrograms = (
  record: LineRecord,
  ahead: Pick<PromotionCompare, "commits">,
): readonly ProgramId[] => {
  const byCommit = new Map<string, LineComposition>();
  for (const composition of record.compositions) byCommit.set(composition.commit, composition);
  const accounted = new Set<string>();
  for (const { sha } of ahead.commits) {
    for (const range of byCommit.get(sha)?.ranges ?? []) accounted.add(range.program);
  }
  const programs: ProgramId[] = [];
  const add = (id: ProgramId): void => {
    if (!programs.includes(id)) programs.push(id);
  };
  for (const { sha, subject } of ahead.commits) {
    const composition = byCommit.get(sha);
    if (composition !== undefined) {
      for (const range of composition.ranges) add(range.program);
      continue;
    }
    const parsed = ProgramIdSchema.safeParse(MERGE_SUBJECT.exec(subject)?.[1]);
    if (parsed.success && !accounted.has(parsed.data)) add(parsed.data);
  }
  return programs;
};

export const promotionTitle = (record: LineRecord, to: string): string =>
  `Promote ${record.branch} to ${to}`;

export interface PromotionProgramFacts {
  readonly title?: string;
  /** Its run has ended succeeded; otherwise only part of it is on the line. */
  readonly whole: boolean;
  readonly programsDirectory: string;
  /**
   * The directory name a run publishes the program under (its plan draft's
   * name); absent when it has no draft, in which case nothing was published.
   */
  readonly name?: string;
}

/** The decision a line repair recorded, as the body words it. */
export interface PromotionRepairFacts {
  readonly cause?: string;
  readonly gates?: readonly string[];
  readonly choice: string;
  readonly rationale?: string;
}

export interface PromotionBodyInput {
  readonly record: LineRecord;
  readonly to: string;
  /** `owner/name`. */
  readonly repository: string;
  /** `compare(base = target, head = line)`. */
  readonly ahead: PromotionCompare;
  readonly diverged: DivergedCommits;
  readonly programs: ReadonlyMap<ProgramId, PromotionProgramFacts>;
  /** By repair job contract id; a repair absent here is worded "decision not recorded". */
  readonly repairs?: ReadonlyMap<string, PromotionRepairFacts>;
}

const divergedWords = (
  commits: readonly { readonly sha: string; readonly subject: string }[],
  count: number,
  limit: number,
): string[] => {
  const lines = commits
    .slice(0, limit)
    .map((commit) => `- \`${shortSha(commit.sha)}\` ${oneLine(commit.subject)}`);
  const more = count - Math.min(commits.length, limit);
  if (more > 0) lines.push(`- and ${more} more`);
  return lines;
};

const remedy = (to: string, line: string): string =>
  `Merge \`${to}\` into \`${line}\`, or protect \`${to}\` so only this promotion merges into it. Nightshift never merges \`${to}\` into the line.`;

/** Lines that fit `budget` characters, then an "and N more" line for the rest. */
const withinBudget = (lines: readonly string[], budget: number): string[] => {
  const out: string[] = [];
  let used = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // Leave room for the "and N more" line.
    if (used + line.length + 1 + 40 > budget) {
      out.push(`- and ${lines.length - index} more`);
      return out;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
};

const repairDecisionWords = (facts: PromotionRepairFacts | undefined): string => {
  if (facts === undefined) return "decision not recorded";
  const why: string[] = [];
  if (facts.cause !== undefined) why.push(`cause ${oneLine(facts.cause, 60)}`);
  if (facts.gates !== undefined && facts.gates.length > 0) {
    why.push(`gates ${oneLine(facts.gates.join(", "), 120)}`);
  }
  const decided = `decided: ${oneLine(facts.choice, 200)}`;
  const rationale =
    facts.rationale === undefined ? "" : `, because ${oneLine(facts.rationale, 200)}`;
  return [...why, `${decided}${rationale}`].join("; ");
};

const repairLines = (
  record: LineRecord,
  aheadShas: ReadonlySet<string>,
  repairs: ReadonlyMap<string, PromotionRepairFacts>,
): string[] =>
  record.compositions
    .filter(
      (composition) =>
        aheadShas.has(composition.commit) &&
        (composition.resolver?.decision === "resolved" || composition.repair !== undefined),
    )
    .map((composition) => {
      const parts = [`\`${shortSha(composition.commit)}\``];
      if (composition.resolver !== undefined) {
        const detail =
          composition.resolver.detail === undefined
            ? ""
            : `: ${oneLine(composition.resolver.detail)}`;
        parts.push(`resolver ${composition.resolver.decision}${detail}`);
      }
      if (composition.repair !== undefined) {
        parts.push(
          `repair run ${composition.repair.runId}, job ${composition.repair.jobContractId}; ${repairDecisionWords(repairs.get(composition.repair.jobContractId))}`,
        );
      }
      return `- ${parts.join("; ")}`;
    });

const verificationLines = (record: LineRecord): string[] => {
  const composition =
    record.compositions.find((candidate) => candidate.commit === record.head) ??
    record.compositions[record.compositions.length - 1];
  if (composition === undefined) return [];
  const { verification } = composition;
  const lines = [
    `Verification of \`${shortSha(verification.commitSha)}\`: **${verification.outcome}**`,
  ];
  const commands = verification.commands.map((command) => {
    const result =
      command.exitCode !== undefined
        ? `exit ${command.exitCode}`
        : command.deferred !== undefined
          ? "deferred"
          : "skipped";
    return `- \`${oneLine(command.command, 200)}\`: ${result}`;
  });
  return [...lines, ...withinBudget(commands, VERIFICATION_BUDGET)];
};

/** The pull request body: the warning if the target diverged, then what the line holds. */
export const promotionBody = (input: PromotionBodyInput): string => {
  const { record, to, repository, ahead, diverged, programs } = input;
  const out: string[] = [];

  if (diverged.commits.length > 0 || diverged.count > 0) {
    out.push(
      `> **Warning: \`${to}\` has ${diverged.count} commit${diverged.count === 1 ? "" : "s"} the line \`${record.branch}\` lacks.**`,
      "",
      ...withinBudget(
        divergedWords(diverged.commits, diverged.count, WARNING_COMMITS),
        WARNING_BUDGET,
      ),
      "",
      remedy(to, record.branch),
      "",
    );
  }

  out.push(
    `Promotes line \`${record.branch}\` to \`${to}\`.`,
    "",
    record.head === undefined
      ? "Head: not yet known."
      : `This describes head \`${shortSha(record.head)}\` (${record.head}).`,
    "",
  );

  const aheadShas = new Set(ahead.commits.map((commit) => commit.sha));
  const ids = promotionPrograms(record, ahead);
  out.push("## Programs", "");
  if (ids.length === 0) {
    out.push("No program is named by the commits the target lacks.");
  } else {
    const rows = ids.map((id) => {
      const facts = programs.get(id);
      const name = facts?.name;
      const link =
        name === undefined
          ? "no report published"
          : `[report](https://github.com/${repository}/blob/${record.branch}/${facts?.programsDirectory ?? "docs/programs"}/${name}/report.md)`;
      const shown = facts?.title ?? name;
      const title = shown === undefined ? "" : ` ${oneLine(shown, 120)}`;
      return `- \`${id}\`${title}: ${facts?.whole === true ? "whole" : "part"}, ${link}`;
    });
    out.push(...withinBudget(rows, PROGRAMS_BUDGET));
  }
  if (!ahead.complete) {
    const unlisted = Math.max(ahead.aheadBy - ahead.commits.length, 0);
    out.push(
      "",
      `${unlisted} commit${unlisted === 1 ? "" : "s"} the line holds were not listed by GitHub, so programs they carry may be missing above.`,
    );
  }

  const repairs = repairLines(record, aheadShas, input.repairs ?? new Map());
  if (repairs.length > 0) {
    out.push("", "## Repairs made on the line", "", ...withinBudget(repairs, REPAIRS_BUDGET));
  }

  const verification = verificationLines(record);
  if (verification.length > 0) out.push("", "## Verification", "", ...verification);

  out.push(
    "",
    "Merge with a merge commit, not squash or rebase: either of those makes the target diverge from the line.",
  );

  // The shares above keep this far under the bound; this is the guarantee, cutting whole lines only.
  while (out.join("\n").length > MAX_PROMOTION_BODY_CHARS && out.length > 1) out.pop();
  return out.join("\n");
};

/** What the line waits for: its own, plus what its promotion adds. */
export const lineWaitingReasons = (record: LineRecord): LineWaiting[] => {
  const reasons: LineWaiting[] = record.waiting === undefined ? [] : [record.waiting];
  const promotion = record.promotion;
  if (promotion?.diverged !== undefined) {
    const { commits, count, since } = promotion.diverged;
    const named = commits
      .slice(0, 3)
      .map((commit) => `${shortSha(commit.sha)} ${oneLine(commit.subject, 80)}`)
      .join("; ");
    reasons.push({
      reason: "promotion_diverged",
      detail: `${promotion.to} has ${count} commit${count === 1 ? "" : "s"} the line lacks${named === "" ? "" : ` (${named}${count > 3 ? "; …" : ""})`}. ${remedy(promotion.to, record.branch)}`,
      since,
    });
  }
  if (promotion?.blocked?.reason === "pull_requests_permission") {
    reasons.push({
      reason: "promotion_forbidden",
      detail:
        "Give the Nightshift GitHub App 'Pull requests: Read and write' and have the installation accept it.",
      since: promotion.blocked.since,
    });
  }
  return reasons;
};
