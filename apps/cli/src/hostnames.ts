/**
 * Where the control plane is, by stage (D-P3-18).
 *
 * Nightshift is one hosted control plane, and a user should no more type its URL
 * than a `gh` user types `github.com`. So the CLI ships the rule, and
 * `nightshift login` with no flags signs in against `DEFAULT_STAGE`. The explicit
 * flags survive for developers and for a stage this table does not know.
 *
 * Two of the three values follow a rule; the third is a table.
 *
 * - The API: `api.<stage>.nightshift.wildorder.dev`, an alias the API stack keeps
 *   pointing at whatever it deploys. `infra/cdk/src/lib/hostnames.ts` states the
 *   same rule; neither can import the other (the IaC app is not a library and is
 *   not in the CLI's layer table), so both pin the literal for `dev` in a test.
 * - The Cognito hosted domain: `nightshift-<stage>-<account>.auth.<region>.amazoncognito.com`.
 *   Derived from the stage and the one account A-17 fixes, and the pool it fronts
 *   is retained, so it is as stable as the API alias without a certificate in a
 *   second region. A branded `auth.` hostname is a separate decision.
 * - The interactive app client id: generated per pool and public (PKCE, no
 *   secret). Baked per stage; an unknown stage needs `--client-id`.
 *
 * Nothing here is secret. A generated `execute-api` hostname is never written to a
 * profile: `resolveProfile` rewrites one it finds.
 */

export const ZONE_NAME = "nightshift.wildorder.dev";

/** The one account (A-17) and the primary region. */
export const NIGHTSHIFT_ACCOUNT = "755348349819";
export const PRIMARY_REGION = "us-west-2";

export const DEFAULT_STAGE = "dev";

export const apiEndpointFor = (stage: string): string => `https://api.${stage}.${ZONE_NAME}`;

export const authDomainFor = (stage: string): string =>
  `nightshift-${stage}-${NIGHTSHIFT_ACCOUNT}.auth.${PRIMARY_REGION}.amazoncognito.com`;

/** Interactive app clients, by stage. Public identifiers. */
export const INTERACTIVE_CLIENT_IDS: Readonly<Record<string, string>> = {
  dev: "hs42ak267ticrk2calntvc7a9",
};

export interface StageDefaults {
  readonly apiEndpoint: string;
  readonly authDomain: string;
  /** `undefined` for a stage with no baked client id. */
  readonly clientId: string | undefined;
}

export const defaultsFor = (stage: string): StageDefaults => ({
  apiEndpoint: apiEndpointFor(stage),
  authDomain: authDomainFor(stage),
  clientId: INTERACTIVE_CLIENT_IDS[stage],
});

/**
 * Whether a stored value is a hostname a stack deploy could change: the generated
 * `execute-api` endpoint. Such a value is rewritten to the stable rule on the
 * next login rather than kept.
 */
export const isGeneratedEndpoint = (apiEndpoint: string): boolean =>
  /\.execute-api\.[a-z0-9-]+\.amazonaws\.com/.test(apiEndpoint);
