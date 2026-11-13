/**
 * What the line machine's provisioning, recovery and cleanup share (Pipkin
 * M1b): its monthly cap, and the `waiting` a line records when the plane
 * cannot start its owner.
 */
import type {
  LineRecord,
  LineWaitingReason,
  ProgramContract,
  ProjectId,
} from "@nightshift/contracts";
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

/**
 * The branch the line promotes to: `line.promote.to` of the newest non-line
 * program contract of the project whose `line.branch` is this branch. That
 * contract is authoritative; an older contract's `promote` is ignored.
 */
export const promotionConfigOf = async (
  stores: Pick<ProjectStores, "programContracts">,
  projectId: ProjectId,
  branch: string,
): Promise<{ readonly to: string } | undefined> => {
  let newest: ProgramContract | undefined;
  let cursor: string | undefined;
  do {
    const page: Page<ProgramContract> = await stores.programContracts.listByProject(
      projectId,
      cursor === undefined ? {} : { cursor },
    );
    for (const contract of page.items) {
      if (contract.kind === "line" || contract.line?.branch !== branch) continue;
      if (newest === undefined || contract.createdAt > newest.createdAt) newest = contract;
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return newest?.line?.promote;
};

/**
 * The record with its promotion seeded for `to`: prior fields kept when `to` is
 * unchanged, reset to `{ to }` when it changed, removed when there is no `to`.
 * `undefined` when the record already is so.
 */
export const seedPromotion = (
  record: LineRecord,
  to: string | undefined,
  at: string,
): LineRecord | undefined => {
  if (to === undefined) {
    if (record.promotion === undefined) return undefined;
    const { promotion: _removed, ...rest } = record;
    return { ...rest, updatedAt: at };
  }
  if (record.promotion?.to === to) return undefined;
  return { ...record, promotion: { to, updatedAt: at }, updatedAt: at };
};
