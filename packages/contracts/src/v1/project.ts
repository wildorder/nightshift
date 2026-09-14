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
 */
import { z } from "zod";
import { OrgIdSchema } from "../ids.js";
import { IsoTimestampSchema, projectScoped } from "./common.js";

export const ProjectSchema = z.strictObject({
  ...projectScoped,
  orgId: OrgIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: IsoTimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;
