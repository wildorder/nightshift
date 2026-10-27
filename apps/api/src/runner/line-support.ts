/**
 * What the line machine's provisioning, recovery and cleanup share (Pipkin
 * M1b): its monthly cap, and the `waiting` a line records when the plane
 * cannot start its owner.
 */
import type { LineWaitingReason, ProgramContract, ProjectId } from "@nightshift/contracts";
import {
  type Clock,
  DEFAULT_LINE_MONTHLY_USD,
  nowIso,
  type Page,
  type ProjectStores,
} from "@nightshift/core";

/**
 * The project's monthly cap for a line: the lowest `line.monthlyUsd` among the
 * project's programs configured for this branch that set one, else the default.
 */
export const lineCapUsd = async (
  stores: Pick<ProjectStores, "programContracts">,
  projectId: ProjectId,
  branch: string,
): Promise<number> => {
  const caps: number[] = [];
  let cursor: string | undefined;
  do {
    const page: Page<ProgramContract> = await stores.programContracts.listByProject(
      projectId,
      cursor === undefined ? {} : { cursor },
    );
    for (const contract of page.items) {
      if (contract.line?.branch === branch && contract.line.monthlyUsd !== undefined) {
        caps.push(contract.line.monthlyUsd);
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return caps.length === 0 ? DEFAULT_LINE_MONTHLY_USD : Math.min(...caps);
};

/** Records on the line why its owner is not running; the queue is left as it is. */
export const recordLineWaiting = async (
  stores: Pick<ProjectStores, "lines">,
  clock: Clock,
  target: { readonly projectId: ProjectId; readonly branch: string },
  waiting: { readonly reason: LineWaitingReason; readonly detail: string },
): Promise<void> => {
  const at = nowIso(clock);
  await stores.lines.update(target.projectId, target.branch, (current) => {
    if (current === undefined) return undefined;
    if (current.waiting?.reason === waiting.reason && current.waiting.detail === waiting.detail) {
      return undefined;
    }
    const since = current.waiting?.reason === waiting.reason ? current.waiting.since : at;
    return { ...current, waiting: { ...waiting, since }, updatedAt: at };
  });
};

/** The line's owner is starting: nothing is waiting any more. */
export const clearLineWaiting = async (
  stores: Pick<ProjectStores, "lines">,
  clock: Clock,
  target: { readonly projectId: ProjectId; readonly branch: string },
): Promise<void> => {
  const at = nowIso(clock);
  await stores.lines.update(target.projectId, target.branch, (current) => {
    if (current?.waiting === undefined) return undefined;
    const { waiting: _cleared, ...rest } = current;
    return { ...rest, updatedAt: at };
  });
};

/** The line dispatch failure a refused admission ends with. */
export const failureCodeOf = (reason: LineWaitingReason): "line_cap" | "org_month" | undefined =>
  reason === "monthly_cap" ? "line_cap" : reason === "org_month_ceiling" ? "org_month" : undefined;
