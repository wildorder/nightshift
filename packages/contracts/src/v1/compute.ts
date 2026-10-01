/**
 * Compute: the machine a remote run gets (P10, D-P10-13, D-P10-14, D-P10-19).
 *
 * Three tiers, chosen by the customer. The classes and their prices are a table
 * here, changed only by a decision, because no machine may launch at a price
 * nobody wrote down (D-P10-19). The recommendation that picks a tier before the
 * first run and the right-sizing that revises it from measured use are `core`'s
 * pure functions; this module holds only what they are computed over and what
 * they produce.
 */
import { z } from "zod";

export const ComputeTierSchema = z.enum(["good", "better", "best"]);
export type ComputeTier = z.infer<typeof ComputeTierSchema>;

export const COMPUTE_TIER_ORDER: readonly ComputeTier[] = ["good", "better", "best"];

/** The architecture every tier runs on (D-P10-13). One, so the image and the cache are single. */
export const ComputeArchitectureSchema = z.enum(["arm64"]);
export type ComputeArchitecture = z.infer<typeof ComputeArchitectureSchema>;

export interface ComputeTierSpec {
  readonly instanceType: string;
  readonly vcpu: number;
  readonly memoryGiB: number;
  /** The gp3 workspace volume's size. */
  readonly volumeGiB: number;
  /** On-demand Linux in `us-west-2`, from the Pricing API on 2026-10-01 (H-P10-03). */
  readonly usdPerHour: number;
}

/**
 * The tier table (D-P10-13). Graviton, memory-optimised: installs, bundlers and
 * test runners want the memory more than the clock.
 */
export const COMPUTE_TIERS: Readonly<Record<ComputeTier, ComputeTierSpec>> = {
  good: { instanceType: "m7g.xlarge", vcpu: 4, memoryGiB: 16, volumeGiB: 100, usdPerHour: 0.1632 },
  better: {
    instanceType: "m7g.2xlarge",
    vcpu: 8,
    memoryGiB: 32,
    volumeGiB: 200,
    usdPerHour: 0.3264,
  },
  best: {
    instanceType: "m7g.4xlarge",
    vcpu: 16,
    memoryGiB: 64,
    volumeGiB: 400,
    usdPerHour: 0.6528,
  },
};

/** gp3 storage in `us-west-2`, per GiB-month, so a run's volume is priced beside its hours. */
export const GP3_USD_PER_GIB_MONTH = 0.08;

export const computeTierRank = (tier: ComputeTier): number => COMPUTE_TIER_ORDER.indexOf(tier);

/** A recommendation, with the sentences that explain it. */
export const ComputeRecommendationSchema = z.strictObject({
  tier: ComputeTierSchema,
  reasons: z.array(z.string().min(1)),
});
export type ComputeRecommendation = z.infer<typeof ComputeRecommendationSchema>;

/**
 * What a contract or `nightshift.config.json` says about the machine
 * (D-P10-14). `tier` is the customer's choice; `recommended` is what the probe
 * said at `init` or `plan check`. The order of precedence is `chooseTier` in `core`.
 */
export const ComputeChoiceSchema = z.strictObject({
  tier: ComputeTierSchema.optional(),
  recommended: ComputeRecommendationSchema.optional(),
});
export type ComputeChoice = z.infer<typeof ComputeChoiceSchema>;

/**
 * An org's ceilings (D-P10-19). A contract or a repository's config may only
 * lower them; `narrowerCeilings` is how.
 */
export const ComputeCeilingsSchema = z.strictObject({
  maxTier: ComputeTierSchema,
  maxConcurrentRuns: z.int().min(1),
  maxRunHours: z.number().positive(),
  maxUsdPerMonth: z.number().positive(),
  maxUsdPerRun: z.number().positive(),
});
export type ComputeCeilings = z.infer<typeof ComputeCeilingsSchema>;

/**
 * The shipped defaults (D-P10-19): the owner's provisional figures of
 * 2026-10-01, to be revisited against the first three live runs' metered cost.
 */
export const DEFAULT_COMPUTE_CEILINGS: ComputeCeilings = {
  maxTier: "best",
  maxConcurrentRuns: 2,
  maxRunHours: 24,
  maxUsdPerMonth: 300,
  maxUsdPerRun: 50,
};

/** The lower of two ceilings, field by field: a narrowing can only ever take away. */
export const narrowerCeilings = (
  a: ComputeCeilings,
  b: Partial<ComputeCeilings> | undefined,
): ComputeCeilings =>
  b === undefined
    ? a
    : {
        maxTier:
          b.maxTier !== undefined && computeTierRank(b.maxTier) < computeTierRank(a.maxTier)
            ? b.maxTier
            : a.maxTier,
        maxConcurrentRuns: Math.min(a.maxConcurrentRuns, b.maxConcurrentRuns ?? Infinity),
        maxRunHours: Math.min(a.maxRunHours, b.maxRunHours ?? Infinity),
        maxUsdPerMonth: Math.min(a.maxUsdPerMonth, b.maxUsdPerMonth ?? Infinity),
        maxUsdPerRun: Math.min(a.maxUsdPerRun, b.maxUsdPerRun ?? Infinity),
      };
