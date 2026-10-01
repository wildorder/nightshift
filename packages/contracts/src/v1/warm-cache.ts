/**
 * WarmCache — a project's warm snapshot (P10, D-P10-15).
 *
 * Every run's workspace volume is created from the project's latest snapshot:
 * a mirror clone, the package stores and the last prepared checkout. When a
 * run ends with its setup having passed at least once, its volume is
 * snapshotted and this record moves to it. The last three are kept as
 * `history`, so a bad snapshot can be stepped back from and the reconciler
 * knows what to delete.
 *
 * Project scoped: the cache is the project's, shared by every program and run.
 */
import { z } from "zod";
import { RunIdSchema } from "../ids.js";
import { IsoTimestampSchema, projectScoped } from "./common.js";
import { ComputeArchitectureSchema } from "./compute.js";

export const WarmSnapshotSchema = z.strictObject({
  snapshotId: z.string().min(1),
  amiVersion: z.string().min(1),
  /** `sha256` per lockfile path, as the run that took it reported them. */
  lockfileHashes: z.record(z.string().min(1), z.string().min(1)),
  fromRunId: RunIdSchema,
  takenAt: IsoTimestampSchema,
});
export type WarmSnapshot = z.infer<typeof WarmSnapshotSchema>;

/** How many superseded snapshots are kept before the oldest is deleted (D-P10-15). */
export const WARM_CACHE_HISTORY = 3;

export const WarmCacheSchema = z.strictObject({
  ...projectScoped,
  architecture: ComputeArchitectureSchema,
  /** The snapshot the next run starts from. */
  current: WarmSnapshotSchema,
  /** Superseded snapshots, newest first, at most `WARM_CACHE_HISTORY`. */
  history: z.array(WarmSnapshotSchema).max(WARM_CACHE_HISTORY),
  updatedAt: IsoTimestampSchema,
});
export type WarmCache = z.infer<typeof WarmCacheSchema>;
