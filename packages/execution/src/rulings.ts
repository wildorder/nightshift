/**
 * The program's memory of its rulings (P15).
 *
 * An arbiter's upheld ruling is a decision about how the program's code must
 * behave, made with the evidence in front of it. It used to live only on the
 * job it was made on, so the next job never knew it. In P15's own run a job
 * re-landed work an arbiter had just ruled on; its examiner was never told,
 * and the work landed without the ruling carried out.
 *
 * So every upheld ruling in the program, in any of its runs, is gathered here
 * and given to each agent Nightshift starts:
 *
 * - **as memory**, to workers, orchestrators and examiners, in their brief: what
 *   has been decided, to follow (or, for an examiner, to hold the change to)
 *   where the work touches what it covers. Whether one applies is the reader's
 *   judgement, never a match on file names: two jobs with different objectives
 *   in the same file are not the same work.
 * - **as a requirement**, only to the examination of a change that carries the
 *   very work a ruling was made on: the same commit, or the same patch replayed
 *   or re-landed. Its examiner must confirm the ruling is carried out, as it does
 *   for the attempt the engine starts after a ruling (`followsRulings`).
 *
 * A ruling a human reversed (`nightshift ruling reverse`, a later decision that
 * supersedes it) is not among them. From the records alone.
 */
import type { Decision, Examination, ExaminationRuling, Run } from "@nightshift/contracts";
import type { Page, PageRequest, ProgramScope, ProjectStores } from "@nightshift/core";
import type { ProgramRuling } from "@nightshift/harness";
import { type GitRunner, tryGit } from "./git/index.js";

const everyPage = async <T>(
  list: (page: PageRequest) => Promise<Page<T>>,
): Promise<readonly T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? {} : { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

const pathsOf = (finding: Examination["findings"][number]): readonly string[] => [
  ...new Set(
    finding.evidence.flatMap((evidence) =>
      "path" in evidence && typeof evidence.path === "string" ? [evidence.path] : [],
    ),
  ),
];

/** One run's upheld, unreversed rulings. */
const rulingsOfRun = async (
  stores: Pick<ProjectStores, "decisions" | "examinations">,
  run: Run,
): Promise<readonly ProgramRuling[]> => {
  const scope = { projectId: run.projectId, programId: run.programId, runId: run.runId };
  const decisions = await everyPage((page) => stores.decisions.listByRun(scope, page));
  const reversed = new Set(
    decisions.flatMap((decision) =>
      decision.supersedesDecisionId === null ? [] : [decision.supersedesDecisionId as string],
    ),
  );
  const upheld = decisions.filter(
    (decision: Decision) =>
      decision.authority === "agent" &&
      decision.choice === "uphold" &&
      !reversed.has(decision.decisionId),
  );
  const rulings: ProgramRuling[] = [];
  for (const decision of upheld) {
    const examinations = await stores.examinations.listByNode(scope, decision.executionNodeId);
    for (const examination of examinations) {
      const finding = examination.findings.find(
        (candidate) => candidate.resolvedBy?.decisionId === decision.decisionId,
      );
      if (finding === undefined) continue;
      rulings.push({
        decisionId: decision.decisionId,
        runId: run.runId,
        findingId: finding.id,
        finding: finding.summary,
        rationale: decision.rationale,
        paths: pathsOf(finding),
        commitSha: examination.commitSha,
        patchId: examination.patchId,
      });
      break;
    }
  }
  return rulings;
};

/** Every upheld ruling in the program, oldest run first. */
export const programRulings = async (
  stores: Pick<ProjectStores, "runs" | "decisions" | "examinations">,
  scope: ProgramScope,
): Promise<readonly ProgramRuling[]> => {
  const runs = [...(await everyPage((page) => stores.runs.listByProgram(scope, page)))].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt),
  );
  const rulings: ProgramRuling[] = [];
  for (const run of runs) rulings.push(...(await rulingsOfRun(stores, run)));
  return rulings;
};

/**
 * The rulings a change must be shown to carry out: those made on the very work
 * it carries. The same patch (replayed onto a moved head, or re-landed by
 * another job), or a change whose commits include the one the ruling was made
 * against. As the examination of a ruling's own follow-up checks them.
 */
export const rulingsCarriedBy = async (
  git: GitRunner,
  input: {
    readonly repoPath: string;
    readonly base: string;
    readonly commitSha: string;
    readonly patchId: string;
    readonly rulings: readonly ProgramRuling[];
  },
): Promise<readonly ExaminationRuling[]> => {
  const isAncestor = async (ancestor: string, of: string): Promise<boolean> =>
    (
      await tryGit(git, ["merge-base", "--is-ancestor", ancestor, of], {
        cwd: input.repoPath,
      })
    ).exitCode === 0;
  const carried: ExaminationRuling[] = [];
  for (const ruling of input.rulings) {
    const samePatch = ruling.patchId === input.patchId;
    const containsCommit =
      !samePatch &&
      (await isAncestor(ruling.commitSha, input.commitSha)) &&
      !(await isAncestor(ruling.commitSha, input.base));
    if (!samePatch && !containsCommit) continue;
    carried.push({
      findingId: ruling.findingId,
      decisionId: ruling.decisionId as ExaminationRuling["decisionId"],
      summary: ruling.finding,
      rationale: ruling.rationale,
    });
  }
  return carried;
};
