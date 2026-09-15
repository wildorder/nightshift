/**
 * Membership — joins a user to an organisation (T9).
 *
 * A user may hold several. A contractor working for several clients is the
 * motivating case, and the reason the active organisation has to be *selected*
 * per request rather than read off the user.
 *
 * A membership records that a user may act for an org. It does not, on its own,
 * refuse anything: v1 enforces no org separation (A-21 non-guarantee), and a
 * membership existing is not a fence around the org's projects.
 */
import { z } from "zod";
import { OrgIdSchema } from "../ids.js";
import { IsoTimestampSchema, SchemaVersionSchema } from "./common.js";
import { UserIdSchema } from "./user.js";

export const MembershipSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  userId: UserIdSchema,
  orgId: OrgIdSchema,
  createdAt: IsoTimestampSchema,
});
export type Membership = z.infer<typeof MembershipSchema>;
