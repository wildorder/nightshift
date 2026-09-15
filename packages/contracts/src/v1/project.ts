/**
 * Project — the isolation boundary. Every other aggregate is project scoped
 * (A-07), and no query may cross projects.
 *
 * A project belongs to an organisation (A-21), but `orgId` is deliberately *not*
 * part of the ownership chain carried by every other aggregate. `projectId` is a
 * globally unique ULID, so project-scoped records need no org prefix to be
 * unambiguous. The org lives here and on an `ORG#` partition that lists its
 * projects; that is enough to make retrofitting org-awareness an attribute change
 * rather than a migration.
 *
 * `orgId` is immutable once stored. The org pointer partition is written beside
 * the project, so moving a project between orgs would leave a stale pointer; the
 * stores refuse the change rather than half-perform it.
 */
import { z } from "zod";
import { OrgIdSchema } from "../ids.js";
import { IsoTimestampSchema, projectScoped } from "./common.js";

/**
 * How Nightshift will reach this project's AWS account: by assuming a role the
 * account owner created, presenting an external ID (A-25, D-P2-14).
 *
 * **Reserved in P2.** Fields and validation only; nothing assumes the role until
 * the execution layer exists. Both halves are required together, which is why
 * they are one object rather than two optional fields.
 *
 * The external ID is stored in plaintext (A-26). AWS states an external ID is not
 * a secret, only that it must be unpredictable.
 */
export const CrossAccountAccessSchema = z.strictObject({
  roleArn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/, {
    message: "must be an IAM role ARN, for example arn:aws:iam::123456789012:role/name",
  }),
  /** AWS bounds: 2 to 1224 characters from `[\w+=,.@:/-]`. */
  externalId: z
    .string()
    .min(2)
    .max(1224)
    .regex(/^[\w+=,.@:/-]+$/, { message: "contains a character AWS does not allow" }),
});
export type CrossAccountAccess = z.infer<typeof CrossAccountAccessSchema>;

export const ProjectSchema = z.strictObject({
  ...projectScoped,
  orgId: OrgIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  crossAccount: CrossAccountAccessSchema.optional(),
  createdAt: IsoTimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;
