/**
 * Whether the plane may start the line's owner now (Pipkin M1b).
 *
 * Two ceilings, both read by `get` and never listed: the project's own
 * self-started spend this month against its cap, and the org's compute ledger
 * against the org's monthly ceiling. Concurrency is the reconciler's to
 * enforce (`org_concurrency`), where it can see the machines; this decides
 * only what the ledgers say.
 */
import {
  calendarMonthOf,
  DEFAULT_COMPUTE_CEILINGS,
  type LineWaitingReason,
  type OrgId,
  type ProjectId,
} from "@nightshift/contracts";
import type { IdentityStores, ProjectStores } from "../ports/stores.js";
import { capReached } from "../rules/line.js";
import type { Clock } from "../time.js";

export type LineAdmissionStores = Pick<ProjectStores, "orgConfigs" | "projectSelfStartedUsage"> &
  Pick<IdentityStores, "computeLedger">;

export interface LineAdmissionDeps {
  readonly stores: LineAdmissionStores;
  readonly clock: Clock;
}

export type LineAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LineWaitingReason; readonly detail: string };

export const lineAdmission = async (
  { stores, clock }: LineAdmissionDeps,
  input: {
    readonly projectId: ProjectId;
    readonly branch: string;
    readonly capUsd: number;
    readonly orgId: OrgId;
  },
): Promise<LineAdmission> => {
  const month = calendarMonthOf(new Date(clock.now()).toISOString());
  const usage = await stores.projectSelfStartedUsage.get(input.projectId, month);
  if (capReached(usage, month, input.capUsd)) {
    return {
      ok: false,
      reason: "monthly_cap",
      detail: `the line has spent $${(usage?.meteredUsd ?? 0).toFixed(2)} of its $${input.capUsd.toFixed(2)} monthly cap for ${month}`,
    };
  }
  const ceilings = (await stores.orgConfigs.get(input.orgId))?.compute ?? DEFAULT_COMPUTE_CEILINGS;
  const ledger = await stores.computeLedger.get(input.orgId, month);
  if ((ledger?.meteredUsd ?? 0) >= ceilings.maxUsdPerMonth) {
    return {
      ok: false,
      reason: "org_month_ceiling",
      detail: `the org has spent $${(ledger?.meteredUsd ?? 0).toFixed(2)} of its $${ceilings.maxUsdPerMonth.toFixed(2)} monthly compute ceiling for ${month}`,
    };
  }
  return { ok: true };
};
