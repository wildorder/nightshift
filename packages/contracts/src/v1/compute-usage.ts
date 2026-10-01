/**
 * An org's compute ledger for one month (P10, D-P10-19).
 *
 * The ceilings are the org's, and a dispatch is a run's, so something above
 * every project has to know what the org's runs are spending this month and how
 * many are live. This is that record: an identity record, like a membership,
 * keyed by org and calendar month, written by the API as dispatches start,
 * heartbeat and end. It is a ledger for refusing a dispatch, not a bill.
 */
import { z } from "zod";
import { OrgIdSchema, RunIdSchema } from "../ids.js";
import { IsoTimestampSchema, SchemaVersionSchema } from "./common.js";

/** `YYYY-MM`, UTC. */
export const CalendarMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, {
  message: "must be a calendar month, YYYY-MM",
});
export type CalendarMonth = z.infer<typeof CalendarMonthSchema>;

export const calendarMonthOf = (iso: string): CalendarMonth => iso.slice(0, 7);

export const OrgComputeUsageSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  orgId: OrgIdSchema,
  month: CalendarMonthSchema,
  /** Metered compute dollars across the org's runs this month, machine and volume. */
  meteredUsd: z.number().min(0),
  /** Runs whose dispatch is not terminal, whichever month they started in. */
  liveRuns: z.array(RunIdSchema),
  updatedAt: IsoTimestampSchema,
});
export type OrgComputeUsage = z.infer<typeof OrgComputeUsageSchema>;

export const emptyComputeUsage = (
  orgId: OrgComputeUsage["orgId"],
  month: CalendarMonth,
  at: string,
): OrgComputeUsage => ({
  schemaVersion: 1,
  orgId,
  month,
  meteredUsd: 0,
  liveRuns: [],
  updatedAt: at,
});
