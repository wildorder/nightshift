/**
 * Nightshift's public hostnames (D-P3-18).
 *
 * One zone, `nightshift.wildorder.dev`, owned by the Nightshift account and
 * delegated from `wildorder.dev` by one `NS` record in the wildorder management
 * account (H-P3-05). Inside it, one hostname per stage per surface:
 *
 * ```text
 * api.<stage>.nightshift.wildorder.dev      → the HTTP API
 * studio.<stage>.nightshift.wildorder.dev   → the Studio (P11, D-P11-02)
 * ```
 *
 * The stage is in the name from the start so that a later `prod` is a new record
 * and a one-constant change to the CLI's default, never a rename. The generated
 * `execute-api` hostname stays reachable but is never the one a client stores:
 * D-P2-07 lets the API stack be replaced, and replacing it changes that name.
 *
 * `apps/cli/src/hostnames.ts` restates this rule, and the Studio restates it
 * again for itself. Neither can import it: `infra/cdk` is not in either layer
 * table and must not be — the IaC app is not a library (the same reasoning as
 * `API_SCOPE` in the CLI's `oauth.ts`). Every side pins the `dev` literals in a
 * test, so a drift is a red test rather than a login that resolves nothing.
 */

/** The zone Nightshift owns. */
export const ZONE_NAME = "nightshift.wildorder.dev";

/** Its parent, whose zone lives in the wildorder management account. */
export const PARENT_ZONE_NAME = "wildorder.dev";

/**
 * The one account (A-17) and its primary region, restated from the CLI for the
 * two stacks that cannot be environment-agnostic (P11, D-P11-02): CloudFront
 * accepts a certificate from `us-east-1` only, and CDK carries a value across
 * regions only between stacks whose account and region are both explicit.
 */
export const NIGHTSHIFT_ACCOUNT = "755348349819";
export const PRIMARY_REGION = "us-west-2";
/** Where CloudFront's certificate must live. Not a choice. */
export const CERTIFICATE_REGION = "us-east-1";

/** `api.<stage>.nightshift.wildorder.dev`. */
export const apiHostnameFor = (stage: string): string => `api.${stage}.${ZONE_NAME}`;

/** `studio.<stage>.nightshift.wildorder.dev` (D-P11-02). */
export const studioHostnameFor = (stage: string): string => `studio.${stage}.${ZONE_NAME}`;

/**
 * The origin the Studio is developed from (D-P11-01): Vite's default port, on
 * the `dev` stage's client only. `npm run studio` is a development affordance of
 * this repository, not a feature, and keeping its callback off every other
 * stage is what keeps that structural rather than a matter of discipline.
 */
export const DEV_STAGE = "dev";
export const STUDIO_DEV_PORT = 5173;
export const STUDIO_DEV_ORIGIN = `http://localhost:${STUDIO_DEV_PORT}`;

/**
 * Every origin a browser may present when it calls the API as the Studio
 * (D-P11-03) and every origin the Studio's app client may send a code to
 * (D-P11-04). One list, used by both, so the two cannot disagree: the hosted
 * origin for every stage, plus the local development origin for `dev` alone.
 */
export const studioOriginsFor = (stage: string): readonly string[] => [
  `https://${studioHostnameFor(stage)}`,
  ...(stage === DEV_STAGE ? [STUDIO_DEV_ORIGIN] : []),
];

/**
 * Whether the stacks create the certificate and custom domain, or only the zone.
 *
 * `zone-only` exists for the first deploy of a new account: a DNS-validated
 * certificate sits in `PENDING_VALIDATION`, and CloudFormation waits on it, until
 * the zone has been delegated — which needs the nameservers that deploy prints.
 * Deploy `zone-only`, add the `NS` record, then deploy `full`. Steady state is
 * `full`, which is the default.
 */
export const HOSTNAMES_MODES = ["zone-only", "full"] as const;
export type HostnamesMode = (typeof HOSTNAMES_MODES)[number];
export const DEFAULT_HOSTNAMES_MODE: HostnamesMode = "full";

export const parseHostnamesMode = (value: unknown): HostnamesMode => {
  if (value === undefined || value === "") return DEFAULT_HOSTNAMES_MODE;
  if (typeof value === "string" && (HOSTNAMES_MODES as readonly string[]).includes(value)) {
    return value as HostnamesMode;
  }
  throw new Error(
    `invalid hostnames mode ${JSON.stringify(value)}: use -c hostnames=${HOSTNAMES_MODES.join("|")}`,
  );
};
