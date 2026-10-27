/**
 * The `line` setting, kept apart from `line.ts` so the program contract and the
 * config can use it without importing the line records (which need the org
 * config, which needs the program contract).
 */
import { z } from "zod";

/** `"line": {"branch": …}` in `nightshift.config.json`, and inherited into the program contract. */
export const LineConfigSchema = z.strictObject({
  /** The branch the line lives on, e.g. `nightshift/develop`. */
  branch: z.string().min(1),
  /** The cap on what the plane's own starts may spend on this line per month. Absent means the default. */
  monthlyUsd: z.number().positive().optional(),
});
export type LineConfig = z.infer<typeof LineConfigSchema>;
