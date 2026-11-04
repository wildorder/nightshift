import { isMainCause, type LineCommandLog, type LineRepairCause } from "./ports.js";

/** At most `max` characters of `text`, the end kept: a log's last lines say why. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - max)}`;

/** What went wrong, in one line for a parked record. */
export const lineCauseText = (cause: {
  cause: LineRepairCause;
  paths: readonly string[];
  checks: readonly LineCommandLog[];
}): string => {
  const of = isMainCause(cause.cause) ? "merging main onto the line" : "the merge";
  if (cause.cause === "line_conflict" || cause.cause === "line_main_conflict") {
    return `${of} conflicted in ${cause.paths.join(", ") || "paths git did not list"}`;
  }
  const after = isMainCause(cause.cause)
    ? " once main was merged onto the line"
    : cause.cause === "candidate_red"
      ? " in the candidate's full verification"
      : "";
  const first = cause.checks.find((log) => log.exitCode !== 0) ?? cause.checks[0];
  return first === undefined
    ? `the landing checks failed${after}`
    : `the landing checks failed${after}: \`${first.command}\` exit ${first.exitCode ?? "none"}: ${clip(first.tail.trim(), 800)}`;
};
