/**
 * `nightshift completion <verb> <program> ...` (P20, D-05).
 *
 * Completion histories are named by a person: which runs together delivered one
 * outcome. These verbs are the terminal's form of Studio's membership controls.
 * Every write reads the stored history, proposes its next version and lets the
 * control plane decide; a refusal or a lost race is reported, never retried.
 * `suggest` only prints what recorded facts point at and changes nothing.
 */
import type {
  CompletionHistory,
  CompletionMemberRef,
  ProgramContract,
  ProgramId,
  Run,
  RunFeedback,
  RunId,
} from "@nightshift/contracts";
import { ProgramIdSchema, RunIdSchema } from "@nightshift/contracts";
import type { CompletionFigures } from "@nightshift/core";
import {
  buildCompletionHistory,
  CompletionMembershipError,
  completionOf,
  nowIso,
  StaleWriteError,
  suggestCompletionMembers,
} from "@nightshift/core";
import { isTokenProfile } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { readProgramFiles, resolveFrom } from "../program-files.js";
import { type FreshSession, openFreshSession } from "../session.js";
import { actingUser, findRun, listRuns } from "./program-run.js";

export type CompletionVerb =
  | "create"
  | "list"
  | "show"
  | "suggest"
  | "add"
  | "remove"
  | "checkpoint";

export interface CompletionOptions {
  readonly verb: CompletionVerb;
  readonly id: string;
  readonly repo?: string;
  readonly run?: string;
  readonly title?: string;
  readonly history?: string;
  /** `<programId>/<runId>` */
  readonly member?: string;
  readonly role?: "contributing" | "correction";
  readonly name?: string;
}

const keyOf = (ref: { readonly programId: string; readonly runId: string }): string =>
  `${ref.programId}/${ref.runId}`;

const need = <T>(value: T | undefined, flag: string): T => {
  if (value === undefined) throw new UsageError(`--${flag} is required`);
  return value;
};

const parseMember = (text: string): { programId: ProgramId; runId: RunId } => {
  const [programId, runId, ...rest] = text.split("/");
  const program = ProgramIdSchema.safeParse(programId);
  const run = RunIdSchema.safeParse(runId);
  if (rest.length > 0 || !program.success || !run.success) {
    throw new UsageError(`--member must be <programId>/<runId>, not \`${text}\``);
  }
  return { programId: program.data, runId: run.data };
};

const seconds = (value: number | undefined): string => {
  if (value === undefined) return "none";
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0
    ? `${hours}h ${minutes}m`
    : minutes > 0
      ? `${minutes}m ${total % 60}s`
      : `${total}s`;
};

const percent = (share: number | undefined): string =>
  share === undefined ? "none" : `${Math.round(share * 100)}%`;

/** Every history of the project, ascending by id. */
const allHistories = async (
  session: FreshSession,
  projectId: CompletionHistory["projectId"],
): Promise<CompletionHistory[]> => {
  const found: CompletionHistory[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.stores.completionHistories.listByProject(
      projectId,
      cursor === undefined ? {} : { cursor },
    );
    found.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
};

const findHistory = async (
  session: FreshSession,
  projectId: CompletionHistory["projectId"],
  id: string,
): Promise<CompletionHistory> => {
  const found = (await allHistories(session, projectId)).find(
    (history) => history.completionHistoryId === id,
  );
  if (found === undefined) throw new UsageError(`no completion history ${id} in this project`);
  return found;
};

const figures = (environment: CliEnvironment, label: string, current: CompletionFigures): void => {
  environment.out(
    `${label}: lead time ${seconds(current.leadTimeSeconds)}, run completion ${seconds(current.runCompletionSeconds)}, active union ${seconds(current.activeSeconds)}`,
  );
};

export const completion = async (
  environment: CliEnvironment,
  options: CompletionOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const session = await openFreshSession(environment);
  const { projectId, programId } = files.contract;
  const program = { projectId, programId };

  if (options.verb === "list") {
    const histories = (await allHistories(session, projectId)).filter((history) =>
      history.members.some((member) => member.programId === programId),
    );
    if (histories.length === 0) {
      environment.out(`no completion history includes a run of \`${options.id}\``);
      return 0;
    }
    for (const history of histories) {
      environment.out(
        `${history.completionHistoryId} "${history.title}" ${history.members.length} members, version ${history.version}`,
      );
    }
    return 0;
  }

  const actor = async () => actingUser(session, isTokenProfile(session.profile), projectId);
  const at = nowIso(environment.clock);

  if (options.verb === "create") {
    const run = await findRun(session, program, options.id, options.run);
    const title = need(options.title, "title");
    const history = buildCompletionHistory({
      scope: { ...program, runId: run.runId },
      completionHistoryId: environment.ids.next("comp"),
      title,
      members: [{ programId, runId: run.runId, role: "anchor" }],
      actor: await actor(),
      at,
    });
    return write(
      environment,
      session,
      history,
      () =>
        `created completion history ${history.completionHistoryId} "${title}" anchored on run ${run.runId} (version 1)`,
    );
  }

  const stored = await findHistory(session, projectId, need(options.history, "history"));
  const scope = { projectId, programId: stored.programId, runId: stored.runId };

  if (options.verb === "show" || options.verb === "suggest") {
    return options.verb === "show"
      ? show(environment, session, stored, at)
      : suggest(environment, session, stored);
  }

  const member = parseMember(need(options.member, "member"));
  const key = keyOf(member);
  const propose = async (
    members: readonly CompletionMemberRef[],
    checkpoint?: { readonly name: string; readonly programId: ProgramId; readonly runId: RunId },
  ): Promise<CompletionHistory> =>
    buildCompletionHistory({
      stored,
      scope,
      completionHistoryId: stored.completionHistoryId,
      title: stored.title,
      members,
      actor: await actor(),
      at,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });
  const id = stored.completionHistoryId;

  if (options.verb === "add") {
    const role = options.role ?? "contributing";
    const next = await propose([...stored.members, { ...member, role }]);
    return write(
      environment,
      session,
      next,
      () => `added ${key} to completion history ${id} as ${role} (version ${next.version})`,
    );
  }
  if (options.verb === "remove") {
    const existing = stored.members.find((candidate) => keyOf(candidate) === key);
    if (existing === undefined) throw new UsageError(`${key} is not a member of ${id}`);
    if (existing.role === "anchor") {
      throw new UsageError(`${key} is the anchor of ${id} and cannot be removed`);
    }
    const next = await propose(stored.members.filter((candidate) => keyOf(candidate) !== key));
    return write(
      environment,
      session,
      next,
      () => `removed ${key} from completion history ${id} (version ${next.version})`,
    );
  }
  const name = need(options.name, "name");
  if (stored.checkpoints.some((checkpoint) => checkpoint.name === name)) {
    throw new UsageError(`${id} already has a checkpoint named \`${name}\``);
  }
  const next = await propose(stored.members, { name, ...member });
  return write(
    environment,
    session,
    next,
    () =>
      `recorded checkpoint \`${name}\` at ${key} on completion history ${id} (version ${next.version})`,
  );
};

const write = async (
  environment: CliEnvironment,
  session: FreshSession,
  history: CompletionHistory,
  said: () => string,
): Promise<number> => {
  try {
    await session.stores.completionHistories.put(history);
  } catch (error) {
    if (error instanceof StaleWriteError) {
      environment.err("the completion history changed underneath you; run the command again");
      return 1;
    }
    if (error instanceof CompletionMembershipError) {
      environment.err(error.message);
      return 1;
    }
    throw error;
  }
  environment.out(said());
  return 0;
};

/** The runs and verdicts of the members, read through the stores. */
const readMembers = async (
  session: FreshSession,
  history: CompletionHistory,
): Promise<{ runs: Map<string, Run>; feedback: Map<string, RunFeedback> }> => {
  const runs = new Map<string, Run>();
  const feedback = new Map<string, RunFeedback>();
  for (const member of history.members) {
    const scope = { projectId: history.projectId, programId: member.programId };
    const run = await session.stores.runs.get(scope, member.runId);
    if (run === undefined) continue;
    runs.set(keyOf(member), run);
    const rated = await session.stores.feedback.get({ ...scope, runId: member.runId });
    if (rated !== undefined) feedback.set(keyOf(member), rated);
  }
  return { runs, feedback };
};

const show = async (
  environment: CliEnvironment,
  session: FreshSession,
  history: CompletionHistory,
  asOf: string,
): Promise<number> => {
  const { runs, feedback } = await readMembers(session, history);
  const report = completionOf({ history, runs, feedback, asOf });
  environment.out(
    `completion history ${report.completionHistoryId} "${report.title}" (version ${report.version})`,
  );
  for (const member of report.members) {
    environment.out(
      `member ${member.programId}/${member.runId} ${member.role} ${member.status ?? "unreadable"} ${member.verdict}`,
    );
  }
  const { coverage } = report;
  environment.out(
    `rated ${coverage.rated} of ${coverage.eligible} finished runs, positive share ${percent(coverage.positiveShare)}`,
  );
  figures(environment, "now", report.current);
  for (const checkpoint of report.checkpoints) {
    figures(
      environment,
      `checkpoint \`${checkpoint.name}\` (${checkpoint.recordedAt})`,
      checkpoint,
    );
  }
  return 0;
};

const suggest = async (
  environment: CliEnvironment,
  session: FreshSession,
  history: CompletionHistory,
): Promise<number> => {
  const anchorScope = { projectId: history.projectId, programId: history.programId };
  const anchorRun = await session.stores.runs.get(anchorScope, history.runId);
  if (anchorRun === undefined)
    throw new UsageError(`the anchor run ${history.runId} is unreadable`);
  const programs: ProgramContract[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.stores.programContracts.listByProject(
      history.projectId,
      cursor === undefined ? {} : { cursor },
    );
    programs.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  const runs: Run[] = [];
  for (const contract of programs) {
    runs.push(
      ...(await listRuns(session, { projectId: history.projectId, programId: contract.programId })),
    );
  }
  const suggestions = suggestCompletionMembers({ history, anchorRun, programs, runs });
  if (suggestions.length === 0) {
    environment.out(`nothing suggested for ${history.completionHistoryId}`);
    return 0;
  }
  for (const suggestion of suggestions) {
    environment.out(
      `suggest ${keyOf(suggestion)} as ${suggestion.role}: ${suggestion.reason} — ${suggestion.detail}`,
    );
  }
  return 0;
};
