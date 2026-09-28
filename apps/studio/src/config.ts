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

export const StudioConfigSchema = z.strictObject({
  stage: z.string().min(1),
  /** Origin with no trailing slash. */
  apiEndpoint: z.string().url(),
  /** The Cognito hosted domain, no scheme. */
  authDomain: z.string().min(1),
  clientId: z.string().min(1),
});
export type StudioConfig = z.infer<typeof StudioConfigSchema>;

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
    return { ...defaults, clientId: defaults.clientId };
  }
  if (response.status !== 200) {
    throw new StudioConfigError(`config.json answered ${response.status}`);
  }
  const parsed = StudioConfigSchema.safeParse(JSON.parse(await response.text()));
  if (!parsed.success) {
    throw new StudioConfigError(`config.json is not a Studio config: ${parsed.error.message}`);
  }
  return { ...parsed.data, apiEndpoint: parsed.data.apiEndpoint.replace(/\/+$/, "") };
};
