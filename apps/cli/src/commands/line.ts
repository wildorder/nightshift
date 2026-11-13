/**
 * `nightshift line status [--repo <path>]` (Pipkin M1b, "the project line in
 * the plane"): where the project's development line stands, read from the
 * plane. The repository's `nightshift.config.json` says which project and
 * which branch; without a `line` there is nothing to ask.
 */
import {
  type Dispatch,
  type LineComposition,
  type LineParked,
  type LineRange,
  type LineRepairRef,
  LineRequeueResponseSchema,
  type LineView,
  LineViewSchema,
  type ProgramContract,
  type ProgramId,
  type Run,
} from "@nightshift/contracts";
import { lineWaitingReasons } from "@nightshift/core";
import { routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { readConfig, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";

export interface LineOptions {
  readonly repo?: string;
}

export interface LineRequeueOptions extends LineOptions {
  /** A program id, or a program's branch (`program/<name>` or `<name>`); absent: every parked range. */
  readonly program?: string;
}

/** What `line status` says, and exits 1 on, for a project whose config has no `line`. */
export const NO_LINE_CONFIGURED =
  'this project has no line configured: add a `line` setting with the branch to nightshift.config.json (for example "line": { "branch": "nightshift/develop" })';

const short = (sha: string): string => sha.slice(0, 7);

const usd = (value: number): string => `$${value.toFixed(2)}`;

const describeRange = (range: LineRange, names: ReadonlyMap<string, string>): string =>
  `${names.get(range.program) ?? range.program} ${range.from === undefined ? "base" : short(range.from)}..${short(range.upTo)}`;

const describeRanges = (ranges: readonly LineRange[], names: ReadonlyMap<string, string>): string =>
  ranges.map((range) => describeRange(range, names)).join(", ");

const describeRepair = (repair: LineRepairRef): string =>
  `    repair ${repair.runId} ${repair.jobContractId}`;

/** A run of the line program with its dispatch, when it has one. */
export interface LineRunEntry {
  readonly run: Run;
  readonly dispatch?: Dispatch | undefined;
}

const describeRun = ({ run, dispatch }: LineRunEntry): string => {
  const times = `started ${run.startedAt}${run.endedAt === undefined ? "" : `, ended ${run.endedAt}`}`;
  const machine =
    dispatch === undefined
      ? "no machine"
      : `${dispatch.instanceType}${dispatch.instanceId === undefined ? "" : ` ${dispatch.instanceId}`}, metered ${usd(dispatch.spend.meteredUsd)}`;
  return `  ${run.runId}  ${run.status}${run.status === "running" ? " (live)" : ""}  ${times}  ${machine}`;
};

const describeComposition = (
  composition: LineComposition,
  names: ReadonlyMap<string, string>,
): string[] => {
  const { verification, resolver } = composition;
  const lines = [
    `  ${short(composition.commit)}  ${describeRanges(composition.ranges, names)}`,
    `    verification ${verification.outcome} (${verification.verificationId})`,
  ];
  if (resolver !== undefined) {
    lines.push(
      `    resolver ${resolver.decision}, ${resolver.attempts} attempt${resolver.attempts === 1 ? "" : "s"}${resolver.detail === undefined ? "" : `: ${resolver.detail}`}`,
    );
  }
  if (composition.repair !== undefined) lines.push(describeRepair(composition.repair));
  lines.push(
    composition.pushed === undefined ? "    not pushed" : `    pushed ${composition.pushed.at}`,
  );
  return lines;
};

const describeParked = (
  parked: LineParked,
  names: ReadonlyMap<string, string>,
  requeued?: { at: string; by: string },
): string[] => {
  const lines = [
    `  ${describeRanges(parked.ranges, names)}${requeued === undefined ? "" : `  (requeued ${requeued.at} by ${requeued.by})`}`,
    `    reason: ${parked.reason}`,
  ];
  if (parked.resolver !== undefined) {
    lines.push(
      `    resolver ${parked.resolver.decision}, ${parked.resolver.attempts} attempt${parked.resolver.attempts === 1 ? "" : "s"}`,
    );
  }
  if (parked.repair !== undefined) lines.push(describeRepair(parked.repair));
  return lines;
};

/** The promotion's lines: the pull request it keeps open and how the line and target stand. */
const describePromotion = (record: LineView["record"]): string[] => {
  const { promotion } = record;
  if (promotion === undefined) return [];
  const lines: string[] = [];
  if (promotion.number === undefined || promotion.aheadBy === 0) {
    lines.push(`promotion → ${promotion.to}: nothing to promote`);
  } else {
    const described = promotion.head === undefined ? "" : `, describes ${short(promotion.head)}`;
    lines.push(
      `promotion → ${promotion.to}: #${promotion.number} ${promotion.state ?? "unknown"}${promotion.url === undefined ? "" : ` ${promotion.url}`}${described}`,
    );
  }
  if (record.head !== undefined && promotion.head !== undefined && record.head !== promotion.head) {
    lines.push(`  line head ${short(record.head)} differs from the described head`);
  }
  if (promotion.aheadBy !== undefined || promotion.behindBy !== undefined) {
    lines.push(
      `  ${promotion.to}: ${promotion.aheadBy ?? 0} ahead, ${promotion.behindBy ?? 0} behind the line`,
    );
  }
  return lines;
};

/** The whole of `line status` for one view, a line per entry. */
export const describeLine = (view: LineView, runs: readonly LineRunEntry[] = []): string[] => {
  const { record, usage } = view;
  const names = new Map<string, string>(view.programs.map((p) => [p.program, p.branch]));
  const lines: string[] = [];

  lines.push(
    `line ${record.branch}  head ${record.head === undefined ? "unknown" : short(record.head)}`,
    `line program: ${view.programId}`,
    `line branch: ${record.branch}, the branch work ships from`,
  );
  if (record.push === undefined) {
    lines.push("last push: none");
  } else {
    const { push } = record;
    lines.push(
      `last push: ${push.status} ${short(push.head)} (from ${short(push.expectedPredecessor)})${push.detail === undefined ? "" : `: ${push.detail}`}`,
    );
  }

  if (runs.length === 0) {
    // The plane makes the line's program at the first ratification or
    // published range that names the line; until then there is nothing to list.
    lines.push(
      "runs: none yet (the line's program is made when a program is next ratified or a range is published)",
    );
  } else {
    lines.push(`runs: ${runs.length}`);
    for (const entry of runs) lines.push(describeRun(entry));
  }

  if (usage === undefined) {
    lines.push("self-started spend this month: none metered");
  } else {
    lines.push(
      `self-started spend ${usage.month}: ${usd(usage.meteredUsd)} of ${usd(usage.capUsd)} cap${usage.reachedAt === undefined ? "" : ` (reached ${usage.reachedAt})`}`,
    );
  }
  lines.push(...describePromotion(record));
  for (const waiting of lineWaitingReasons(record)) {
    lines.push(`waiting (${waiting.reason}): ${waiting.detail}`);
    if (waiting.reason === "line_refused") {
      lines.push(
        "  to retry: lift the protection, then run `nightshift line requeue --all` (or `nightshift land` for the line program)",
      );
    }
  }

  lines.push(record.queue.length === 0 ? "queue: empty" : `queue: ${record.queue.length}`);
  for (const entry of record.queue) {
    lines.push(
      `  ${names.get(entry.program) ?? entry.program} up to ${short(entry.upTo)}, enqueued ${entry.enqueuedAt}`,
    );
  }

  lines.push(
    record.compositions.length === 0
      ? "compositions: none"
      : `compositions: ${record.compositions.length}`,
  );
  for (const composition of record.compositions) {
    lines.push(...describeComposition(composition, names));
  }

  if (record.parked.length > 0) {
    const requeued = new Map((record.requeued ?? []).map((entry) => [entry.parkedId, entry]));
    const waiting = record.parked.filter((parked) => !requeued.has(parked.compositionId)).length;
    lines.push(
      `parked: ${record.parked.length}${waiting === 0 ? "" : ` (${waiting} waiting for \`nightshift line requeue\`)`}`,
    );
    for (const parked of record.parked) {
      lines.push(...describeParked(parked, names, requeued.get(parked.compositionId)));
    }
  }

  return lines;
};

export const lineStatus = async (
  environment: CliEnvironment,
  options: LineOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const config = await readConfig(repoPath);
  if (config === undefined) {
    environment.err(`no nightshift.config.json in ${repoPath}`);
    return 1;
  }
  if (config.line === undefined) {
    environment.out(NO_LINE_CONFIGURED);
    return 1;
  }
  const session = await openSession(environment);
  const view = LineViewSchema.parse(
    await send(session.transport, {
      method: "GET",
      path: routes.line(config.projectId, config.line.branch),
    }),
  );
  const program = { projectId: config.projectId, programId: view.programId };
  const runs: Run[] = [];
  // The view names the line's latest run once the line's program exists; the
  // program routes answer 404 before the plane has made it (2026-10-29).
  let cursor: string | undefined;
  while (view.runId !== undefined) {
    const page = await session.stores.runs.listByProgram(
      program,
      cursor === undefined ? {} : { cursor },
    );
    runs.push(...page.items);
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const entries: LineRunEntry[] = [];
  for (const run of runs) {
    entries.push({
      run,
      dispatch: await session.stores.dispatches.get({
        ...program,
        runId: run.runId,
      }),
    });
  }
  for (const text of describeLine(view, entries)) environment.out(text);
  return 0;
};

/** The program `named` means: its id, or the program of the project whose branch is `named` or `program/<named>`. */
const resolveProgram = async (
  session: Awaited<ReturnType<typeof openSession>>,
  projectId: ProgramContract["projectId"],
  named: string,
): Promise<ProgramId | undefined> => {
  if (named.startsWith("prog_")) return named as ProgramId;
  const wanted = new Set([named, `program/${named}`]);
  let cursor: string | undefined;
  do {
    const page = await session.stores.programContracts.listByProject(
      projectId,
      cursor === undefined ? {} : { cursor },
    );
    const found = page.items.find((program) => wanted.has(program.repository.programBranch));
    if (found !== undefined) return found.programId;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return undefined;
};

/**
 * `nightshift line requeue <program> | --all [--repo <path>]` (P25,
 * D-P25-05): sends parked ranges back to the line's queue, every one or one
 * program's, and starts the line's run to compose them.
 */
export const lineRequeue = async (
  environment: CliEnvironment,
  options: LineRequeueOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const config = await readConfig(repoPath);
  if (config === undefined) {
    environment.err(`no nightshift.config.json in ${repoPath}`);
    return 1;
  }
  if (config.line === undefined) {
    environment.out(NO_LINE_CONFIGURED);
    return 1;
  }
  const session = await openSession(environment);
  let program: ProgramId | undefined;
  if (options.program !== undefined) {
    program = await resolveProgram(session, config.projectId, options.program);
    if (program === undefined) {
      environment.err(`no program of project ${config.projectId} is named ${options.program}`);
      return 1;
    }
  }
  const answer = LineRequeueResponseSchema.parse(
    await send(session.transport, {
      method: "POST",
      path: routes.lineRequeue(config.projectId, config.line.branch),
      body: program === undefined ? {} : { program },
    }),
  );
  if (answer.released === true) {
    environment.out("the refused push to the line was released and will be tried once more");
  }
  if (answer.requeued.length === 0) {
    if (answer.released === true) {
      environment.out(`the line's run: ${answer.run}`);
      return 0;
    }
    environment.out(
      "nothing new was queued: every parked range is already queued, held or on the line",
    );
  } else {
    environment.out(
      `queued ${answer.requeued.length} range${answer.requeued.length === 1 ? "" : "s"} again:`,
    );
    for (const range of answer.requeued) {
      environment.out(`  ${range.program} up to ${short(range.upTo)}`);
    }
  }
  environment.out(`the line's run: ${answer.run}`);
  return 0;
};
