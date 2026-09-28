/**
 * `nightshift decision reverse` and `nightshift decision brief` (P9, D-P9-02,
 * D-P9-03).
 *
 * A reversal is a record: the owner's new choice, as a `human` decision that
 * supersedes the one reversed. Nothing else moves. The correction is a plan,
 * made with the owner in `plan-program`, and the brief is where it starts: the
 * fork in the road, the branch that was taken and why, what it produced, and
 * everything that landed after it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Decision, DecisionId, ProgramContract, Run } from "@nightshift/contracts";
import { DecisionIdSchema } from "@nightshift/contracts";
import {
  buildReversal,
  CONFIRMED_CLASSES,
  nowIso,
  splitPlanSections,
  whyNotReversible,
} from "@nightshift/core";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { type ProgramFiles, readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession, type Session } from "../session.js";
import { REPORT_FILE } from "./run-program.js";

export interface DecisionTarget {
  readonly id: string;
  readonly decisionId: string;
  readonly run?: string;
  readonly repo?: string;
}

export interface ReverseOptions extends DecisionTarget {
  readonly choice: string;
  readonly reason: string;
}

export interface BriefOptions extends DecisionTarget {
  /** Where to write the brief. Absent: printed. */
  readonly out?: string;
}

interface Found {
  readonly session: Session;
  readonly files: ProgramFiles;
  readonly repoPath: string;
  readonly run: Run;
  readonly decision: Decision;
  readonly decisions: readonly Decision[];
}

const readAll = async <T>(
  list: (page: { cursor?: string }) => Promise<{
    readonly items: readonly T[];
    readonly cursor?: string | undefined;
  }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

/** The decision, in the run named or whichever of the program's runs holds it, latest first. */
export const findDecision = async (
  environment: CliEnvironment,
  options: DecisionTarget,
): Promise<Found> => {
  const parsed = DecisionIdSchema.safeParse(options.decisionId);
  if (!parsed.success) throw new UsageError(`\`${options.decisionId}\` is not a decision id`);
  const decisionId: DecisionId = parsed.data;
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const session = await openSession(environment);
  const program = { projectId: files.contract.projectId, programId: files.contract.programId };
  const runs = (await readAll((page) => session.stores.runs.listByProgram(program, page)))
    .filter((run) => options.run === undefined || run.runId === options.run)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const run of runs) {
    const scope = { ...program, runId: run.runId };
    const decision = await session.stores.decisions.get(scope, decisionId);
    if (decision === undefined) continue;
    const decisions = await readAll((page) => session.stores.decisions.listByRun(scope, page));
    return { session, files, repoPath, run, decision, decisions };
  }
  throw new UsageError(
    `no run of \`${options.id}\`${options.run === undefined ? "" : ` named ${options.run}`} holds decision ${decisionId}`,
  );
};

/** The owner's reversal of `decision`, when there is one: the latest human decision superseding it. */
const reversalOf = (decision: Decision, decisions: readonly Decision[]): Decision | undefined =>
  decisions
    .filter(
      (candidate) =>
        candidate.supersedesDecisionId === decision.decisionId && candidate.authority === "human",
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);

/**
 * Records the owner's reversal of a decision and prints what to do next. Any
 * decision: one the owner answered in a plan, an orchestrator's, a worker's, an
 * arbiter's ruling. It moves nothing.
 */
export const reverseDecision = async (
  environment: CliEnvironment,
  options: ReverseOptions,
): Promise<{ readonly exitCode: number; readonly reversal: Decision; readonly found: Found }> => {
  const found = await findDecision(environment, options);
  const { decision, run } = found;
  const refusal = whyNotReversible(decision);
  if (refusal !== undefined) throw new UsageError(refusal);
  // One builder for the CLI and the Studio (D-P11-08): what is written here is
  // what a reversal from the run page writes.
  const reversal = buildReversal(decision, {
    decisionId: environment.ids.next("dec"),
    choice: options.choice,
    reason: options.reason,
    at: nowIso(environment.clock),
  });
  await found.session.stores.decisions.put(reversal);

  environment.out(
    `Recorded ${reversal.decisionId}: ${decision.decisionId} is reversed, on your authority. ` +
      `It chose "${decision.choice}"; you chose "${options.choice}".`,
  );
  if (CONFIRMED_CLASSES.includes(decision.reversibility)) {
    environment.out(
      `It was ${decision.reversibility}: its effects reach outside the repository. The correction ` +
        "is flagged, and `nightshift run` will ask you to confirm before it runs.",
    );
  }
  environment.out(
    "Nothing else changed. To correct the program under your decision, write the brief and plan from it:",
  );
  environment.out(
    `  nightshift decision brief ${options.id} ${decision.decisionId} --run ${run.runId} --out docs/programs/<correction>/brief.md`,
  );
  environment.out(
    "  then, in Claude Code, ask plan-program to plan the correction from that brief.",
  );
  return { exitCode: 0, reversal, found };
};

const gitText = async (
  environment: CliEnvironment,
  repoPath: string,
  args: readonly string[],
): Promise<string> => {
  const result = await environment.git([...args], { cwd: repoPath });
  return result.exitCode === 0 ? result.stdout.trim() : "";
};

/** Each commit's short sha, subject and the files it touched. */
const describeCommits = async (
  environment: CliEnvironment,
  repoPath: string,
  range: readonly string[],
): Promise<string[]> => {
  if (range.length === 0) return [];
  const text = await gitText(environment, repoPath, [
    "show",
    "--no-patch",
    "--format=%h %s",
    ...range,
  ]);
  const lines: string[] = [];
  for (const [index, sha] of range.entries()) {
    const subject = text.split("\n")[index] ?? sha.slice(0, 8);
    const files = await gitText(environment, repoPath, ["show", "--name-only", "--format=", sha]);
    lines.push(
      `- ${subject}`,
      ...files
        .split("\n")
        .filter(Boolean)
        .map((file) => `  - ${file}`),
    );
  }
  return lines;
};

const where = (
  decision: Decision,
  program: ProgramContract,
  planText: string,
): { readonly label: string; readonly text: string } => {
  const planned = program.decisions?.find((candidate) =>
    decision.context.startsWith(`${candidate.id}: `),
  );
  if (decision.authority === "human" && planned !== undefined) {
    const touches =
      planned.touches === "all" ? "every strand" : `strands ${planned.touches.join(", ")}`;
    return {
      label: `A decision you answered in the plan (${planned.id}), touching ${touches}`,
      text: [
        `Question: ${planned.question}`,
        `Options: ${planned.options.join(" | ")}`,
        ...(planned.leaning === undefined ? [] : [`The plan leaned: ${planned.leaning}`]),
      ].join("\n"),
    };
  }
  const sections = splitPlanSections(planText);
  const strands = program.strands ?? [];
  const mentioned = strands.filter((strand) => decision.context.includes(strand.id));
  return {
    label: `Recorded on node ${decision.executionNodeId}`,
    text: mentioned.map((strand) => sections[strand.id] ?? "").join("\n\n"),
  };
};

/** The brief a correction is planned from (D-P9-03), as markdown. */
export const renderBrief = async (environment: CliEnvironment, found: Found): Promise<string> => {
  const { decision, decisions, files, repoPath, run, session } = found;
  const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
  const reversal = reversalOf(decision, decisions);
  const before = await session.stores.checkpoints.get(scope, decision.checkpointBefore);
  const branch = files.contract.repository.programBranch;
  const later =
    before === undefined
      ? []
      : (
          await gitText(environment, repoPath, [
            "rev-list",
            "--reverse",
            `${before.commitSha}..${branch}`,
          ])
        )
          .split("\n")
          .filter(Boolean);
  const produced = decision.produced?.commits ?? [];
  const place = where(decision, files.contract, files.planText);
  const report = await readFile(join(repoPath, files.directory, REPORT_FILE), "utf8").catch(
    () => undefined,
  );
  const related = decisions.filter(
    (other) =>
      other.decisionId !== decision.decisionId &&
      other.createdAt > decision.createdAt &&
      other.supersedesDecisionId === null &&
      (other.executionNodeId === decision.executionNodeId ||
        other.context.includes(decision.decisionId)),
  );

  return [
    `# Correction brief: ${decision.decisionId}`,
    "",
    `Program \`${files.id}\`, run \`${run.runId}\`. ${place.label}.`,
    "",
    ...(CONFIRMED_CLASSES.includes(decision.reversibility)
      ? [
          `> **${decision.reversibility.toUpperCase()}.** This decision's effects reach outside the repository. The correction must say what`,
          "> happens to them, and `nightshift run` asks the owner to confirm before it runs.",
          "",
        ]
      : []),
    "## The decision",
    "",
    `Context: ${decision.context.trim()}`,
    `Chose: ${decision.choice}`,
    `Why: ${decision.rationale}`,
    `Class: ${decision.reversibility}`,
    "",
    "Weighed and rejected:",
    ...decision.alternatives.map(
      (alternative) =>
        `- ${alternative.summary}${alternative.rejectedBecause === undefined ? "" : `: rejected because ${alternative.rejectedBecause}`}`,
    ),
    "",
    ...(place.text === "" ? [] : ["## Where it was made", "", place.text, ""]),
    "## The owner's decision",
    "",
    ...(reversal === undefined
      ? ["Not reversed yet: `nightshift decision reverse` records it.", ""]
      : [`\`${reversal.decisionId}\`: ${reversal.choice}`, `Why: ${reversal.rationale}`, ""]),
    "## What it produced",
    "",
    before === undefined
      ? "Its checkpoint is not on the record."
      : `Made at checkpoint \`${before.checkpointId}\` (${before.commitSha.slice(0, 8)}).`,
    "",
    ...(produced.length === 0
      ? ["Nothing it produced has landed, or it was not stamped.", ""]
      : [...(await describeCommits(environment, repoPath, produced)), ""]),
    "## Everything that landed after it",
    "",
    ...(later.length === 0
      ? ["Nothing.", ""]
      : [...(await describeCommits(environment, repoPath, later)), ""]),
    ...(related.length === 0
      ? []
      : [
          "## Later decisions it may have shaped",
          "",
          ...related.map(
            (other) =>
              `- \`${other.decisionId}\`: ${other.context.trim()} Chose: ${other.choice}. ${other.rationale}`,
          ),
          "",
        ]),
    "## The run's report",
    "",
    report ?? "No report.md in the repository; `nightshift report` writes one.",
    "",
  ].join("\n");
};

export const decisionBrief = async (
  environment: CliEnvironment,
  options: BriefOptions,
): Promise<number> => {
  const found = await findDecision(environment, options);
  const brief = await renderBrief(environment, found);
  if (options.out === undefined) {
    environment.out(brief);
    return 0;
  }
  const path = resolveFrom(found.repoPath, options.out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, brief);
  environment.out(`wrote the correction brief to ${path}`);
  return 0;
};
