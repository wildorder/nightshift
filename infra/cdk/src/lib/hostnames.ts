/**
 * Nightshift's public hostnames (D-P3-18).
 *
 * One zone, `nightshift.wildorder.dev`, owned by the Nightshift account and
 * delegated from `wildorder.dev` by one `NS` record in the wildorder management
 * account (H-P3-05). Inside it, one hostname per stage per surface:
 *
 * ```text
 * api.<stage>.nightshift.wildorder.dev   → the HTTP API
 * ```
 *
 * The stage is in the name from the start so that a later `prod` is a new record
 * and a one-constant change to the CLI's default, never a rename. The generated
 * `execute-api` hostname stays reachable but is never the one a client stores:
 * D-P2-07 lets the API stack be replaced, and replacing it changes that name.
 *
 * `apps/cli/src/hostnames.ts` restates this rule. It cannot import it: `infra/cdk`
 * is not in the CLI's layer table and must not be — the IaC app is not a library
 * (the same reasoning as `API_SCOPE` in the CLI's `oauth.ts`). Both sides pin the
 * literal `api.dev.nightshift.wildorder.dev` in a test, so a drift is a red test
 * rather than a login that resolves nothing.
 */

/** The zone Nightshift owns. */
export const ZONE_NAME = "nightshift.wildorder.dev";

/** Its parent, whose zone lives in the wildorder management account. */
export const PARENT_ZONE_NAME = "wildorder.dev";

/** `api.<stage>.nightshift.wildorder.dev`. */
export const apiHostnameFor = (stage: string): string => `api.${stage}.${ZONE_NAME}`;

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
