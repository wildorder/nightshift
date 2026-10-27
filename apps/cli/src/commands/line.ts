/**
 * `nightshift line status [--repo <path>]` (Pipkin M1b, "the project line in
 * the plane"): where the project's development line stands, read from the
 * plane. The repository's `nightshift.config.json` says which project and
 * which branch; without a `line` there is nothing to ask.
 */
import {
  type LineComposition,
  type LineParked,
  type LineRange,
  type LineView,
  LineViewSchema,
} from "@nightshift/contracts";
import { routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { readConfig, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";

export interface LineOptions {
  readonly repo?: string;
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
  lines.push(
    composition.pushed === undefined ? "    not pushed" : `    pushed ${composition.pushed.at}`,
  );
  return lines;
};

const describeParked = (parked: LineParked, names: ReadonlyMap<string, string>): string[] => {
  const lines = [`  ${describeRanges(parked.ranges, names)}`, `    reason: ${parked.reason}`];
  if (parked.resolver !== undefined) {
    lines.push(
      `    resolver ${parked.resolver.decision}, ${parked.resolver.attempts} attempt${parked.resolver.attempts === 1 ? "" : "s"}`,
    );
  }
  return lines;
};

/** The whole of `line status` for one view, a line per entry. */
export const describeLine = (view: LineView): string[] => {
  const { record, dispatch, usage } = view;
  const names = new Map<string, string>(view.programs.map((p) => [p.program, p.branch]));
  const lines: string[] = [];

  lines.push(
    `line ${record.branch}  head ${record.head === undefined ? "unknown" : short(record.head)}`,
  );
  if (record.push === undefined) {
    lines.push("last push: none");
  } else {
    const { push } = record;
    lines.push(
      `last push: ${push.status} ${short(push.head)} (from ${short(push.expectedPredecessor)})${push.detail === undefined ? "" : `: ${push.detail}`}`,
    );
  }

  if (dispatch === undefined) {
    lines.push("line owner: none started");
  } else {
    lines.push(
      `line owner: ${dispatch.status}, generation ${dispatch.generation}, metered ${usd(dispatch.spend.meteredUsd)}`,
    );
  }

  if (usage === undefined) {
    lines.push("self-started spend this month: none metered");
  } else {
    lines.push(
      `self-started spend ${usage.month}: ${usd(usage.meteredUsd)} of ${usd(usage.capUsd)} cap${usage.reachedAt === undefined ? "" : ` (reached ${usage.reachedAt})`}`,
    );
  }
  if (record.waiting !== undefined) {
    lines.push(`waiting (${record.waiting.reason}): ${record.waiting.detail}`);
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
    lines.push(`parked: ${record.parked.length}`);
    for (const parked of record.parked) lines.push(...describeParked(parked, names));
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
  for (const text of describeLine(view)) environment.out(text);
  return 0;
};
