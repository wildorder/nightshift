/**
 * `nightshift plan check` and `nightshift plan ratify` (P7, T3; D-P7-02, D-P7-07).
 *
 * `check` is deterministic and touches nothing: it reads the two files, runs
 * `checkPlan` from `core`, and its exit code is the answer. `ratify` is the gate.
 * It refuses a plan that is not `READY`, and one with uncommitted changes,
 * because the hash has to name something git can reproduce; then it uploads the
 * plan document and records the hash. If the upload fails, nothing is ratified.
 */
import { checkPlan, type PlanReason, planHash, splitPlanSections } from "@nightshift/core";
import { createHttpPlanning, sha256Hex } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { type ProgramFiles, readProgramFiles, resolveFrom } from "../program-files.js";
import { openSession } from "../session.js";

export interface PlanOptions {
  readonly id: string;
  readonly repo?: string;
}

export interface PlanCheckResult {
  readonly ready: boolean;
  readonly reasons: readonly PlanReason[];
  readonly planHash: string;
}

const readinessOf = (files: ProgramFiles): PlanCheckResult => {
  const readiness = checkPlan(files.contract, splitPlanSections(files.planText));
  return {
    ready: readiness.ready,
    reasons: readiness.ready ? [] : readiness.reasons,
    planHash: planHash(files.contract, files.planText, sha256Hex).hash,
  };
};

const printReasons = (environment: CliEnvironment, result: PlanCheckResult): void => {
  environment.err(
    `NOT READY: ${result.reasons.length} ${result.reasons.length === 1 ? "reason" : "reasons"}`,
  );
  for (const reason of result.reasons) {
    const [first, ...rest] = reason.message.split("\n");
    environment.err(`  - ${first}`);
    for (const line of rest) environment.err(`    ${line}`);
  }
};

/** Exit code 0 when `READY`, 1 otherwise: the exit code is the answer. */
export const planCheck = async (
  environment: CliEnvironment,
  options: PlanOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);
  const result = readinessOf(files);
  if (!result.ready) {
    printReasons(environment, result);
    return 1;
  }
  environment.out("READY");
  environment.out(
    `${files.directory}: ${files.contract.strands?.length ?? 0} strands, ` +
      `${files.contract.prerequisites?.length ?? 0} prerequisites, ` +
      `${files.contract.decisions?.length ?? 0} decisions; plan ${result.planHash.slice(0, 12)}`,
  );
  return 0;
};

/** Paths under the program directory, or the config, that git does not have as they are on disk. */
const uncommittedChanges = async (
  environment: CliEnvironment,
  repoPath: string,
  files: ProgramFiles,
): Promise<readonly string[]> => {
  const result = await environment.git(
    ["status", "--porcelain", "--", files.directory, "nightshift.config.json"],
    { cwd: repoPath },
  );
  if (result.exitCode !== 0) {
    throw new UsageError(
      `${repoPath} is not a git repository nightshift can read`,
      result.stderr.trim() ||
        "A plan is ratified from a commit, so that its hash names something reproducible.",
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
};

export const planRatify = async (
  environment: CliEnvironment,
  options: PlanOptions,
): Promise<number> => {
  const repoPath = resolveFrom(environment.cwd, options.repo ?? environment.cwd);
  const files = await readProgramFiles(repoPath, options.id);

  const result = readinessOf(files);
  if (!result.ready) {
    printReasons(environment, result);
    environment.err("Nothing was ratified. Fix the plan and run `nightshift plan check` again.");
    return 1;
  }

  const dirty = await uncommittedChanges(environment, repoPath, files);
  if (dirty.length > 0) {
    environment.err(
      "the plan has uncommitted changes, so its hash would name nothing git can reproduce:",
    );
    for (const line of dirty) environment.err(`  ${line}`);
    environment.err("Commit them, then ratify. Nothing was ratified.");
    return 1;
  }

  const session = await openSession(environment);
  const planning = createHttpPlanning({ transport: session.transport });
  // Upload first, then record: if the upload fails this throws, and nothing was asked for.
  const ratified = await planning.ratify(files.contract, files.planText);

  environment.out(`ratified ${files.directory}`);
  environment.out(`  program   ${ratified.programId}`);
  environment.out(`  plan hash ${ratified.planHash}`);
  environment.out(
    `  document  ${ratified.planDocument?.uri} (${ratified.planDocument?.sizeBytes} bytes, sha256 ${ratified.planDocument?.sha256})`,
  );
  environment.out(`  strands   ${(ratified.strands ?? []).map((strand) => strand.id).join(", ")}`);
  environment.out(
    `An edit to ${files.directory}/ after this is refused by \`nightshift run\` until it is ratified again.`,
  );
  return 0;
};
