/**
 * The catalogue (P17, D-P17-03, D-P17-04): what the forecast recommends, and
 * on what evidence.
 *
 * Each entry names a gate-standard rule, says what it read, quotes the
 * evidence it matched, and states its saving as a formula over measured
 * numbers. Deterministic: signatures and arithmetic, no model. A match is
 * evidence quoted, never a verdict; the thresholds are named here and printed
 * with the evidence, so a reader sees why a line fired.
 *
 * The whole-system entry fires on tool signatures only, never on time alone:
 * a slow gate is not thereby a whole-system gate (the owner, 2026-10-16).
 */
import type { PlannedStep, VerificationPlan } from "./model.js";
import { END_GATE_RUNS } from "./model.js";
import type { ResolvedCommand, ResolvedLine } from "./resolve.js";

export interface ContractEdit {
  /** The step the edit is on. */
  readonly stepId: string;
  /** The field and value to set on it. */
  readonly set: Readonly<Record<string, string>>;
}

export interface Recommendation {
  /** The gate-standard rule it serves; absent for a fact that saves nothing. */
  readonly rule?: number;
  readonly title: string;
  readonly stepId: string;
  /** What was read, quoted. */
  readonly evidence: readonly string[];
  /** Measured × stated, as the reader can check it. */
  readonly formula: string;
  /** Absent for a fact; 0 is a real "nothing to save". */
  readonly savingMs?: number;
  /** The fix, as a sentence. */
  readonly fix: string;
  /** When the fix is a contract edit, exactly which (D-P17-08). */
  readonly edit?: ContractEdit;
}

/** Tool signatures: what a resolved line says it runs. */
const WHOLE_SYSTEM =
  /\b(playwright|cypress|webdriver(?:io)?|puppeteer|selenium|detox|nightwatch|testcafe)\b/i;
const SERVICE_START =
  /\b(docker(?:-compose)?\s+(?:compose\s+)?(?:up|run|start)|testcontainers|pg_ctl\s+start|postgres\s+-D|mysqld|redis-server|mongod|localstack|supabase\s+start|sst\s+dev)\b/i;
const INSTALL_IN_GATE =
  /\b(npm\s+(?:ci|install|i)\b|pnpm\s+(?:install|i)\b|yarn(?:\s+install)?\s*$|pip\s+install|poetry\s+install|bundle\s+install|cargo\s+fetch|go\s+mod\s+download|prisma\s+generate|graphql-codegen|openapi-generator)/i;

/** A gate quiet for at least this long before its first output looks like a service starting (rule 7). */
export const QUIET_START_THRESHOLD_MS = 60_000;

const matching = (lines: readonly ResolvedLine[], pattern: RegExp): ResolvedLine | undefined =>
  lines.find((line) => pattern.test(line.text));

/** The resolved lines that match any signature: what the record keeps as evidence (D-P17-07). */
export const signatureLines = (lines: readonly ResolvedLine[]): readonly ResolvedLine[] =>
  lines.filter((line) =>
    [WHOLE_SYSTEM, SERVICE_START, INSTALL_IN_GATE].some((pattern) => pattern.test(line.text)),
  );

const quote = (line: ResolvedLine): string => `${line.source}: \`${line.text}\``;

const measuredOf = (step: PlannedStep) => step.measured;

/**
 * The recommendations for a plan, most time saved first; facts (no saving)
 * last. `resolved` is by step id.
 */
export const recommend = (
  plan: VerificationPlan,
  resolved: ReadonlyMap<string, ResolvedCommand>,
): readonly Recommendation[] => {
  const landings = plan.landings.count;
  const found: Recommendation[] = [];

  for (const step of plan.steps) {
    const lines = resolved.get(step.id)?.lines ?? [{ source: "contract", text: step.command }];
    const measured = measuredOf(step);

    // Rule 9: a whole-system gate on every landing.
    const wholeSystem = step.kind === "landing" ? matching(lines, WHOLE_SYSTEM) : undefined;
    if (wholeSystem !== undefined) {
      const perRun = measured?.durationMs ?? 0;
      const saving = Math.max(0, perRun * landings - perRun * END_GATE_RUNS);
      found.push({
        rule: 9,
        title: `${step.id} at the end`,
        stepId: step.id,
        evidence: [
          `${step.id} resolves to ${quote(wholeSystem)}: a whole-system gate proves the program, not a job`,
          ...(measured === undefined ? [] : [`measured ${ms(perRun)} per landing`]),
        ],
        formula: `${ms(perRun)} × ${landings} landings − ${ms(perRun)} × ${END_GATE_RUNS} runs at the end`,
        savingMs: saving,
        fix: `declare it an end gate: it runs once when the run finishes, and again after each fix that lands (A-57)`,
        edit: { stepId: step.id, set: { at: "end" } },
      });
    }

    // Rule 7: a service started on every verification.
    const service = step.kind === "setup" ? undefined : matching(lines, SERVICE_START);
    if (service !== undefined && measured !== undefined) {
      const quiet = measured.quietMs;
      const loud = quiet >= QUIET_START_THRESHOLD_MS;
      found.push({
        rule: 7,
        title: `${step.id} starts a service every time`,
        stepId: step.id,
        evidence: [
          `${step.id} resolves to ${quote(service)}`,
          `quiet for ${ms(quiet)} of ${ms(measured.durationMs)} before its first output` +
            (loud
              ? ` (over the ${ms(QUIET_START_THRESHOLD_MS)} threshold: usually a service starting)`
              : ` (under the ${ms(QUIET_START_THRESHOLD_MS)} threshold)`),
        ],
        formula: `${ms(quiet)} quiet × ${landings} landings`,
        savingMs: quiet * landings,
        fix:
          "keep the service alive across verifications and give each verification its own state " +
          "(a database from a template, named by NIGHTSHIFT_VERIFICATION_ID); state keyed by content, never by the last run",
      });
    }

    // Rule 1: setup folded into a gate.
    const install = step.kind === "setup" ? undefined : matching(lines, INSTALL_IN_GATE);
    if (install !== undefined) {
      found.push({
        rule: 1,
        title: `${step.id} installs inside a gate`,
        stepId: step.id,
        evidence: [`${step.id} resolves to ${quote(install)}`],
        formula:
          measured === undefined
            ? "unmeasured"
            : `up to ${ms(measured.durationMs)} × ${landings} landings; setup is seeded when the lockfiles match`,
        ...(measured === undefined ? {} : { savingMs: measured.durationMs * landings }),
        fix: "move the install or codegen to `setup`, which runs once per checkout and is skipped when nothing changed",
      });
    }
  }

  // A fact, not a saving: what examination costs in gates.
  if (plan.examinedJobMs > 0) {
    found.push({
      title: "an examined job verifies twice",
      stepId: "*",
      evidence: [
        `a candidate check on the job's base, then the queue's on the program head (D-P8-09): ${ms(plan.examinedJobMs)} per examined job`,
      ],
      formula: `2 × ${ms(plan.landingMs)}`,
      fix: "nothing to change here; the examination policy decides which jobs are examined",
    });
  }

  return found.sort((a, b) => (b.savingMs ?? -1) - (a.savingMs ?? -1));
};

const ms = (value: number): string => {
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
};
