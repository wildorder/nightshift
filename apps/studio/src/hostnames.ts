/**
 * Where the Studio and the control plane are, by stage (D-P3-18, D-P11-01).
 *
 * The same rule `apps/cli/src/hostnames.ts` and `infra/cdk/src/lib/hostnames.ts`
 * state; none of the three can import another (the IaC app is not a library,
 * and the CLI is not in the Studio's layer table), so each pins the `dev`
 * literals in a test and a drift is a red test rather than a page that resolves
 * nothing.
 *
 * Hosted, none of this is consulted: the deploy writes `config.json` beside the
 * app from the stack's own values (D-P11-02). These defaults serve the build run
 * from this repository, which is for developing the Studio (D-P11-01).
 */

export const ZONE_NAME = "nightshift.wildorder.dev";
export const NIGHTSHIFT_ACCOUNT = "755348349819";
export const PRIMARY_REGION = "us-west-2";
export const DEFAULT_STAGE = "dev";

/** The port `vite` serves on, and the one the `dev` Studio client registers. */
export const DEV_PORT = 5173;

export const apiEndpointFor = (stage: string): string => `https://api.${stage}.${ZONE_NAME}`;
export const studioOriginFor = (stage: string): string => `https://studio.${stage}.${ZONE_NAME}`;
export const authDomainFor = (stage: string): string =>
  `nightshift-${stage}-${NIGHTSHIFT_ACCOUNT}.auth.${PRIMARY_REGION}.amazoncognito.com`;

/**
 * The Studio app clients, by stage. Public identifiers (PKCE, no secret), baked
 * the way the CLI bakes its interactive client ids. Filled in from the data
 * stack's `StudioClientId` output when a stage is deployed.
 */
export const STUDIO_CLIENT_IDS: Readonly<Record<string, string>> = {};

export interface StageDefaults {
  readonly stage: string;
  readonly apiEndpoint: string;
  readonly authDomain: string;
  /** `undefined` for a stage with no baked client id. */
  readonly clientId: string | undefined;
}

export const defaultsFor = (stage: string): StageDefaults => ({
  stage,
  apiEndpoint: apiEndpointFor(stage),
  authDomain: authDomainFor(stage),
  clientId: STUDIO_CLIENT_IDS[stage],
});
