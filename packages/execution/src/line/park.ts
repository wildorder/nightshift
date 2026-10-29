import type { LineCommandLog, LineRepairCause } from "./ports.js";

/** At most `max` characters of `text`, the end kept: a log's last lines say why. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - max)}`;

/** What went wrong, in one line for a parked record. */
export const lineCauseText = (cause: {
  cause: LineRepairCause;
  paths: readonly string[];
  checks: readonly LineCommandLog[];
}): string => {
  if (cause.cause === "line_conflict") {
    return `the merge conflicted in ${cause.paths.join(", ") || "paths git did not list"}`;
  }
  const first = cause.checks.find((log) => log.exitCode !== 0) ?? cause.checks[0];
  return first === undefined
    ? "the landing checks failed"
    : `the landing checks failed: \`${first.command}\` exit ${first.exitCode ?? "none"}: ${clip(first.tail.trim(), 800)}`;
};
