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

/** The branch every project's line lives on unless its config names another (P25, D-P25-19). */
export const DEFAULT_LINE_BRANCH = "nightshift/develop";

/**
 * The `line` setting in `nightshift.config.json`: a line, or `false` to have
 * none. Absent means the default line (D-P25-19).
 */
export const ConfigLineSchema = z.union([LineConfigSchema, z.literal(false)]);
export type ConfigLine = z.infer<typeof ConfigLineSchema>;

/**
 * The line a project's config gives it (D-P25-19): the line it names, none for
 * `false`, and `nightshift/develop` when it says nothing. Every project gets a
 * line unless it opts out; nobody has to set one up.
 */
export const lineOfConfig = (line: ConfigLine | undefined): LineConfig | undefined =>
  line === false ? undefined : (line ?? { branch: DEFAULT_LINE_BRANCH });
