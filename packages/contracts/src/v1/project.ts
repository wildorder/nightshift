/**
 * Project — the isolation boundary. Every other aggregate is project scoped
 * (A-07), and no query may cross projects.
 */
import { z } from "zod";
import { IsoTimestampSchema, projectScoped } from "./common.js";

export const ProjectSchema = z.strictObject({
  ...projectScoped,
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: IsoTimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;
