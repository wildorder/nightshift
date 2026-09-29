/**
 * Reaching the control plane from a signed-in session.
 *
 * Every command except `login`, `logout` and `id` needs the same four things:
 * the profile (where the control plane is), a refresh token, a transport that
 * puts an **ID** token on each request, and the stores over it. Built once here
 * so no command decides for itself what a session is.
 *
 * The ID token, not the access token: the control plane resolves the acting
 * organisation from `custom:active_org`, and `custom:` claims appear only in ID
 * tokens on the pool's Lite feature plan. `apps/api/src/auth/acting-org.ts` is
 * where that rule lives, and `persistence/http`'s transport is what enforces it.
 */
import type { ProjectStores } from "@nightshift/core";
import type { Profile, Transport } from "@nightshift/persistence/http";
import {
  createFetchTransport,
  createHttpStores,
  createTokenProvider,
  isTokenProfile,
  readLocalToken,
  refreshIdToken,
  requireCredentials,
  requireProfile,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "./environment.js";

export interface Session {
  readonly profile: Profile;
  readonly transport: Transport;
  readonly stores: ProjectStores;
}

/**
 * A session over a cached, lazily refreshed ID token.
 *
 * For commands that make several requests: one refresh serves all of them, and a
 * command that ends up making none mints no token at all.
 */
export const openSession = async (environment: CliEnvironment): Promise<Session> => {
  const profile = await requireProfile(environment.paths);
  const transport = createFetchTransport({
    endpoint: profile.apiEndpoint,
    tokens: createTokenProvider({
      profile,
      paths: environment.paths,
      fetch: environment.fetch,
      clock: environment.clock,
    }),
    fetch: environment.fetch,
    clock: environment.clock,
  });
  return { profile, transport, stores: createHttpStores({ transport }) };
};

export interface FreshSession extends Session {
  /** The ID token this session was opened with, minted just now. */
  readonly idToken: string;
}

/**
 * A session over one token minted on the spot.
 *
 * `whoami` is the reason this exists, and its answer would be worthless without
 * it: reporting the subject out of a cached token would report what Nightshift
 * last believed rather than what Cognito will say now. Minting proves the stored
 * refresh token still works, which is half of what the operator is asking.
 */
export const openFreshSession = async (environment: CliEnvironment): Promise<FreshSession> => {
  const profile = await requireProfile(environment.paths);
  // A local instance's bearer is its token file; a hosted stage's is minted now.
  const idToken = isTokenProfile(profile)
    ? await readLocalToken(profile.tokenFile)
    : await refreshIdToken(
        profile,
        (await requireCredentials(environment.paths)).refreshToken,
        environment.fetch,
      );
  const transport = createFetchTransport({
    endpoint: profile.apiEndpoint,
    tokens: staticTokenProvider(idToken),
    fetch: environment.fetch,
    clock: environment.clock,
  });
  return { profile, transport, stores: createHttpStores({ transport }), idToken };
};
