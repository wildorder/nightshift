/**
 * Which prerequisites are unmet where this engine runs (D-P7-10, A-58).
 *
 * On the laptop, the laptop's last check, which \`nightshift run\` makes for
 * every prerequisite as the run starts. On a run's machine, the machine's own
 * check for its dispatch generation, and when it has none yet, the check is
 * run here, now: the prerequisite's \`verifyCommand\`, as the project user in
 * the project environment, recorded under this generation, once for the
 * engine's life. Nothing depends on a boot step having run it first: a
 * machine whose runner never audited it (2026-10-17, admin-redesign: every
 * Docker gate deferred with Docker running) checks it the first time a gate
 * needs it.
 */
import type { Prerequisite, VerificationStep } from "@nightshift/contracts";
import { machineCheckOf, unmetPrerequisitesAt } from "@nightshift/core";
import type { LandingEnvironment, RunSession } from "./environment.js";
import { runPreflight } from "./preflight.js";
import { stepsAs } from "./runner.js";

/** Per engine: each prerequisite's check on this machine, made once. */
const checked = new WeakMap<object, Map<string, Promise<Prerequisite>>>();

const checksOf = (environment: object): Map<string, Promise<Prerequisite>> => {
  let found = checked.get(environment);
  if (found === undefined) {
    found = new Map();
    checked.set(environment, found);
  }
  return found;
};

/** The prerequisites unmet where this engine runs, of those `steps` require. */
export const unmetWhereThisRuns = async (
  environment: LandingEnvironment,
  session: Pick<RunSession, "scope" | "program" | "repoPath">,
  steps: readonly VerificationStep[],
): Promise<ReadonlySet<string>> => {
  const required = new Set(steps.flatMap((step) => step.requires ?? []));
  if (required.size === 0 || environment.prerequisites === undefined) return new Set();
  const book = environment.prerequisites;
  const program = { projectId: session.program.projectId, programId: session.program.programId };
  const current = (await book.prerequisites(program)).filter((prerequisite) =>
    required.has(prerequisite.id),
  );
  const site = environment.site ?? { where: "laptop" as const };
  if (site.where === "laptop" || book.recordMachineCheck === undefined) {
    return unmetPrerequisitesAt(current, site);
  }
  const record = book.recordMachineCheck.bind(book);
  const checks = checksOf(environment);
  const here = await Promise.all(
    current.map((prerequisite) => {
      if (machineCheckOf(prerequisite, site.dispatch) !== undefined) {
        return Promise.resolve(prerequisite);
      }
      let pending = checks.get(prerequisite.id);
      if (pending === undefined) {
        pending = runPreflight({
          contract: session.program,
          cwd: session.repoPath,
          site,
          only: [prerequisite.id],
          ...(environment.projectEnv === undefined ? {} : { env: environment.projectEnv }),
          ...stepsAs(environment, { agentId: "prerequisites", role: "worker" }),
          clock: environment.clock,
          record: (scope, prerequisiteId, exitCode) =>
            record(scope, prerequisiteId, exitCode, site.dispatch),
        }).then((result) => result.checks[0]?.prerequisite ?? prerequisite);
        // A check that could not even be recorded is tried again next time.
        pending.catch(() => checks.delete(prerequisite.id));
        checks.set(prerequisite.id, pending);
      }
      return pending.catch(() => prerequisite);
    }),
  );
  return unmetPrerequisitesAt(here, site);
};
