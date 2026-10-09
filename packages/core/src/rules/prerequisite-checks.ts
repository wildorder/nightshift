/**
 * A prerequisite check counts only where it ran (P16, D-08).
 *
 * The laptop's `nightshift preflight` moves a prerequisite's `status`, with its
 * exit code in `lastCheck`. A remote run's machine runs every `verifyCommand`
 * itself before its gate audit and keeps what it found in `machineChecks`, the
 * latest per run. A run's `unmet` set is built only from checks made where that
 * run runs: Docker on the laptop says nothing of Docker on the machine.
 *
 * Pure: the control plane applies these to the record it holds, and a run asks
 * what is unmet of the prerequisites it read.
 */
import {
  type CheckDispatch,
  MAX_MACHINE_CHECKS,
  type MachineCheck,
  type Prerequisite,
} from "@nightshift/contracts";

/** Where a run runs: on the laptop, or on the machine of one dispatch. */
export type RunSite =
  | { readonly where: "laptop" }
  | { readonly where: "machine"; readonly dispatch: CheckDispatch };

/** This dispatch's own check of `prerequisite`, if its machine made one. */
export const machineCheckOf = (
  prerequisite: Prerequisite,
  dispatch: CheckDispatch,
): MachineCheck | undefined =>
  (prerequisite.machineChecks ?? []).find(
    (check) => check.runId === dispatch.runId && check.generation === dispatch.generation,
  );

/**
 * Whether `prerequisite` is met where the run runs. On the laptop, its status,
 * as it always was. On a machine, only this dispatch's own check, exited zero:
 * the laptop's status, another run's machine and an earlier generation of this
 * one are no evidence.
 */
export const isMetAt = (prerequisite: Prerequisite, site: RunSite): boolean =>
  site.where === "laptop"
    ? prerequisite.status === "satisfied"
    : machineCheckOf(prerequisite, site.dispatch)?.exitCode === 0;

/** The ids of the prerequisites not met where the run runs. */
export const unmetPrerequisitesAt = (
  prerequisites: readonly Prerequisite[],
  site: RunSite,
): ReadonlySet<string> =>
  new Set(
    prerequisites
      .filter((prerequisite) => !isMetAt(prerequisite, site))
      .map((prerequisite) => prerequisite.id),
  );

/**
 * The laptop's check applied: `status` follows its exit code. The machines'
 * checks are left exactly as they were.
 */
export const withLaptopCheck = (
  prerequisite: Prerequisite,
  check: { readonly exitCode: number; readonly checkedAt: string },
): Prerequisite => ({
  ...prerequisite,
  status: check.exitCode === 0 ? "satisfied" : "pending",
  lastCheck: { exitCode: check.exitCode, checkedAt: check.checkedAt, where: "laptop" },
});

/**
 * A machine's check applied: it replaces the same run's earlier one (a
 * replacement machine's is the run's latest), and the oldest run's goes when
 * there are more than {@link MAX_MACHINE_CHECKS}. `status` and `lastCheck`,
 * the laptop's, are left exactly as they were.
 */
export const withMachineCheck = (
  prerequisite: Prerequisite,
  check: Omit<MachineCheck, "where">,
): Prerequisite => {
  const others = (prerequisite.machineChecks ?? []).filter(
    (candidate) => candidate.runId !== check.runId,
  );
  const machineChecks = [...others, { where: "machine" as const, ...check }]
    .sort((a, b) => (a.checkedAt < b.checkedAt ? -1 : a.checkedAt > b.checkedAt ? 1 : 0))
    .slice(-MAX_MACHINE_CHECKS);
  return { ...prerequisite, machineChecks };
};
