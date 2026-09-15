/**
 * User — a principal that can call the control plane (T9, A-19).
 *
 * Keyed by the Cognito `sub`, which is the one identifier the JWT authorizer
 * guarantees. For a human that is a UUID; for a machine caller using the client
 * credentials grant it is the app client's identifier. Both are opaque here.
 *
 * A user is **not** project scoped and is deliberately absent from
 * `AGGREGATE_SCHEMAS`: a user exists above every project and may belong to
 * several organisations (D-P2-17). Its schema checks live in the identity
 * registry instead.
 *
 * Which AWS profiles a user holds is irrelevant here. Control-plane identity is a
 * token, never an AWS credential (A-25's two credential worlds).
 */
import { z } from "zod";
import { IsoTimestampSchema, SchemaVersionSchema } from "./common.js";

/**
 * A Cognito subject. Restricted to letters, digits and hyphens, which covers both
 * UUID subjects and app client identifiers, and keeps `#` out so the value is safe
 * inside a composite DynamoDB key.
 */
export const UserIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/, {
    message: "must be a Cognito subject: letters, digits and hyphens, at most 128 characters",
  })
  .brand<"UserId">();
export type UserId = z.infer<typeof UserIdSchema>;

/**
 * `human` signs in interactively; `machine` uses the client credentials grant (the
 * smoke suite now, the remote runner later).
 */
export const PrincipalKindSchema = z.enum(["human", "machine"]);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

export const UserSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  userId: UserIdSchema,
  kind: PrincipalKindSchema,
  /** Absent for machine principals, which have no mailbox. */
  email: z.email().optional(),
  createdAt: IsoTimestampSchema,
});
export type User = z.infer<typeof UserSchema>;
