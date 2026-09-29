/**
 * What the Studio needs to know at startup: where the control plane is, where
 * to sign in, and as which client.
 *
 * Hosted, `config.json` sits beside the app, written by the Studio stack from
 * the deployed values (D-P11-02), so a build carries no stage inside it. Run
 * from the repository, the stage's defaults apply (`hostnames.ts`), and the
 * client id must be baked or the sign-in cannot start.
 */
import { z } from "zod";
import { DEFAULT_STAGE, defaultsFor } from "./hostnames.js";

const CognitoAuthSchema = z.strictObject({
  kind: z.literal("cognito"),
  authDomain: z.string().min(1),
  clientId: z.string().min(1),
});

/**
 * What `config.json` may say (P11, D-P11-02; P12, D-P12-04). The hosted stack
 * wrote `authDomain` and `clientId` flat; since P12 it also writes `auth`, and a
 * local instance writes `auth: { kind: "token" }` and nothing about Cognito.
 */
export const StudioConfigInputSchema = z.strictObject({
  stage: z.string().min(1),
  /** Origin with no trailing slash; the local instance adds `/api`. */
  apiEndpoint: z.string().url(),
  authDomain: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  auth: z.union([CognitoAuthSchema, z.strictObject({ kind: z.literal("token") })]).optional(),
});

/** A hosted stage: sign in through the pool (D-P11-04). */
export interface CognitoStudioConfig {
  readonly kind: "cognito";
  readonly stage: string;
  readonly apiEndpoint: string;
  readonly authDomain: string;
  readonly clientId: string;
}

/** A local instance: the bearer is in the start URL (D-P12-04). */
export interface TokenStudioConfig {
  readonly kind: "token";
  readonly stage: string;
  readonly apiEndpoint: string;
}

export type StudioConfig = CognitoStudioConfig | TokenStudioConfig;

const normalize = (input: z.infer<typeof StudioConfigInputSchema>): StudioConfig => {
  const apiEndpoint = input.apiEndpoint.replace(/\/+$/, "");
  if (input.auth?.kind === "token") return { kind: "token", stage: input.stage, apiEndpoint };
  const authDomain = input.auth?.authDomain ?? input.authDomain;
  const clientId = input.auth?.clientId ?? input.clientId;
  if (authDomain === undefined || clientId === undefined) {
    throw new StudioConfigError("config.json names neither a Cognito client nor a local token");
  }
  return { kind: "cognito", stage: input.stage, apiEndpoint, authDomain, clientId };
};

export class StudioConfigError extends Error {
  override readonly name = "StudioConfigError";
}

export type ConfigFetch = (
  url: string,
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/**
 * `config.json` when it is served, the stage's defaults when it is not (a 404
 * is what the Vite dev server answers). Anything else is a configuration error
 * worth stopping on: a hosted Studio with a malformed config should say so, not
 * quietly sign in against the wrong stage.
 */
export const loadConfig = async (
  fetchConfig: ConfigFetch,
  stage: string = DEFAULT_STAGE,
): Promise<StudioConfig> => {
  const response = await fetchConfig("/config.json");
  if (response.status === 404) {
    const defaults = defaultsFor(stage);
    if (defaults.clientId === undefined) {
      throw new StudioConfigError(
        `no config.json is served and the ${stage} stage has no baked Studio client id`,
      );
    }
    return { kind: "cognito", ...defaults, clientId: defaults.clientId };
  }
  if (response.status !== 200) {
    throw new StudioConfigError(`config.json answered ${response.status}`);
  }
  const parsed = StudioConfigInputSchema.safeParse(JSON.parse(await response.text()));
  if (!parsed.success) {
    throw new StudioConfigError(`config.json is not a Studio config: ${parsed.error.message}`);
  }
  return normalize(parsed.data);
};
