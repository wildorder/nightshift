/**
 * `nightshift login` — authorization code with PKCE against the interactive
 * app client.
 *
 * The order of operations is not arbitrary, and each step is here because of
 * what happens if it moves:
 *
 * 1. **Resolve the flags against the stored profile.** A second `nightshift
 *    login` needs no flags, because the profile already says where the control
 *    plane is. The first one needs all three.
 * 2. **Write `profile.json` first**, before any network call. The profile is
 *    what every other command reads to find the control plane, and a login that
 *    got as far as the browser and then failed should still leave a machine that
 *    knows where its control plane is.
 * 3. **Bind the listener before opening the browser.** The other order races:
 *    a fast sign-in can redirect to a port nothing is listening on yet, and the
 *    operator sees a connection refused page with a live authorization code in
 *    the URL bar.
 * 4. **Exchange, then store, then verify.** The credentials file is written
 *    before the ID token is read, so a refresh token that was issued is never
 *    lost to a parsing failure two lines later.
 *
 * The refresh token exists in this module as one local binding that goes
 * straight into `writeCredentials`. It is never printed, never logged, never put
 * in an error message, and never returned by {@link login}.
 */
import { nowIso } from "@nightshift/core";
import type { Profile } from "@nightshift/persistence/http";
import {
  profilePath,
  readProfile,
  tokenClaims,
  writeCredentials,
  writeProfile,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { authorizeUrl, exchangeAuthorizationCode } from "../oauth.js";
import { assertState, createPkce, createState, type RandomBytes } from "../pkce.js";

/** `--stage` when neither the flags nor the stored profile say otherwise. */
export const DEFAULT_STAGE = "dev";

export interface LoginFlags {
  readonly api?: string;
  readonly authDomain?: string;
  readonly clientId?: string;
  readonly stage?: string;
}

export interface LoginOptions {
  readonly flags: LoginFlags;
  /** Injected so a test replays one exact PKCE exchange. */
  readonly random?: RandomBytes;
  /** Injected so a test binds a port it chose. */
  readonly port?: number;
  readonly timeoutMs?: number;
}

/** What `login` learned. Deliberately no token of any kind. */
export interface LoginResult {
  readonly profile: Profile;
  readonly subject: string;
  readonly email: string | undefined;
}

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/** A domain, however it was pasted: a bare host, an origin, or a URL. */
const normalizeAuthDomain = (value: string): string =>
  trimTrailingSlashes(value.replace(/^https?:\/\//, ""));

/**
 * The three flags, defaulted from the stored profile.
 *
 * "Flags are remembered in the profile, so a second login needs none" is the
 * whole of this function, and the failure it produces for a first login is the
 * one an operator will actually hit, so it names all three and where to find
 * their values.
 */
export const resolveProfile = (flags: LoginFlags, stored: Profile | undefined): Profile => {
  const apiEndpoint = flags.api ?? stored?.apiEndpoint;
  const authDomain = flags.authDomain ?? stored?.authDomain;
  const clientId = flags.clientId ?? stored?.clientId;
  const stage = flags.stage ?? stored?.stage ?? DEFAULT_STAGE;

  const missing = [
    apiEndpoint === undefined ? "--api" : undefined,
    authDomain === undefined ? "--auth-domain" : undefined,
    clientId === undefined ? "--client-id" : undefined,
  ].filter((name) => name !== undefined);

  if (apiEndpoint === undefined || authDomain === undefined || clientId === undefined) {
    throw new UsageError(
      `no profile is stored yet, so ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`,
      "The values are the data stack's outputs: --api is the API stack's endpoint, " +
        "--auth-domain is `AuthDomain`, and --client-id is `InteractiveClientId`. " +
        "After one successful login they are remembered and `nightshift login` takes no flags.",
    );
  }

  return {
    apiEndpoint: trimTrailingSlashes(apiEndpoint),
    authDomain: normalizeAuthDomain(authDomain),
    clientId,
    stage,
  };
};

export const login = async (
  environment: CliEnvironment,
  options: LoginOptions,
): Promise<LoginResult> => {
  const stored = await readProfile(environment.paths);
  const profile = resolveProfile(options.flags, stored);

  // Step 2: before any network call. See the module comment.
  await writeProfile(profile, environment.paths);
  environment.out(`profile written to ${profilePath(environment.paths)}`);

  const pkce = createPkce(options.random);
  const state = createState(options.random);

  // Step 3: bound before the browser is sent anywhere.
  const loopback = await environment.startLoopback({
    state,
    checkState: (received) => {
      assertState(state, received);
    },
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  try {
    const url = authorizeUrl({
      authDomain: profile.authDomain,
      clientId: profile.clientId,
      redirectUri: loopback.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: pkce.method,
    });

    const opened = await environment.openBrowser(url);
    environment.out(
      opened
        ? "opened your browser to sign in; waiting for the callback…"
        : "could not open a browser. Open this URL to sign in:",
    );
    if (!opened) environment.out(url);

    const code = await loopback.code;

    const tokens = await exchangeAuthorizationCode(
      {
        authDomain: profile.authDomain,
        clientId: profile.clientId,
        // The same string that was sent to `/oauth2/authorize`. Cognito checks
        // that the two match, so this must be the value, not a second spelling.
        redirectUri: loopback.redirectUri,
        code,
        codeVerifier: pkce.verifier,
      },
      environment.fetch,
    );

    const claims = tokenClaims(tokens.idToken);
    const subject = typeof claims.sub === "string" ? claims.sub : undefined;
    if (subject === undefined) {
      throw new Error(
        "the ID token carries no `sub` claim, so there is no subject to store. Nothing was written.",
      );
    }

    // Step 4: stored before anything else can fail.
    await writeCredentials(
      {
        refreshToken: tokens.refreshToken,
        subject,
        clientId: profile.clientId,
        obtainedAt: nowIso(environment.clock),
      },
      environment.paths,
    );

    const email = typeof claims.email === "string" ? claims.email : undefined;
    environment.out(
      email === undefined
        ? `signed in as ${subject} (the ID token carried no email claim)`
        : `signed in as ${email}`,
    );
    environment.out(`subject ${subject}`);
    environment.out(`control plane ${profile.apiEndpoint} (stage ${profile.stage})`);

    return { profile, subject, email };
  } finally {
    // Whatever happened, the listener does not outlive the command.
    await loopback.close();
  }
};
