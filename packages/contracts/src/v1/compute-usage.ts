/**
 * An org's compute ledger for one month (P10, D-P10-19).
 *
 * The ceilings are the org's, and a dispatch is a run's, so something above
 * every project has to know what the org's runs are spending this month. This
 * is that record: an identity record, like a membership, keyed by org and
 * calendar month, written by the API as machines heartbeat. It is a ledger for
 * refusing a dispatch, not a bill.
 *
 * How many runs are live is **not** kept here. It is a fact about the
 * dispatches, and the API reads it from them. The list this record once kept
 * (`liveRuns`) was updated at some of a dispatch's endings and not others, so
 * a launch that failed held its place against the org's ceiling for the rest
 * of the month (2026-10-06). A row written before that still carries the key,
 * and it is dropped on read.
 */
import { z } from "zod";
import { OrgIdSchema } from "../ids.js";
import { IsoTimestampSchema, SchemaVersionSchema } from "./common.js";

/** `YYYY-MM`, UTC. */
export const CalendarMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, {
  message: "must be a calendar month, YYYY-MM",
});
export type CalendarMonth = z.infer<typeof CalendarMonthSchema>;

export const calendarMonthOf = (iso: string): CalendarMonth => iso.slice(0, 7);

/** A stored row from before the live list was retired: the key goes, the rest is the record. */
const withoutRetiredKeys = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || !("liveRuns" in value)) return value;
  const { liveRuns: _retired, ...rest } = value as Record<string, unknown>;
  return rest;
};

export const OrgComputeUsageSchema = z.preprocess(
  withoutRetiredKeys,
  z.strictObject({
    schemaVersion: SchemaVersionSchema,
    orgId: OrgIdSchema,
    month: CalendarMonthSchema,
    /** Metered compute dollars across the org's runs this month, machine and volume. */
    meteredUsd: z.number().min(0),
    updatedAt: IsoTimestampSchema,
  }),
);
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
  updatedAt: at,
});
