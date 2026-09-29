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
 * The authorization URL is **always printed**, whether or not the opener
 * reported success. `open` on macOS and `xdg-open` on Linux report success when
 * a browser was launched on *that machine's* desktop, which over SSH is a window
 * nobody is looking at; the callback still lands on this machine's loopback
 * port, so the operator needs the URL and a browser (or a tunnel) that can reach
 * it. `--no-browser` skips the opener for exactly that case, and the **paste
 * path** (`paste.ts`) finishes it: the address the browser failed to reach,
 * pasted into the terminal, carries the code. Whichever arrives first, the
 * callback or the paste, completes the login.
 *
 * The refresh token exists in this module as one local binding that goes
 * straight into `writeCredentials`. It is never printed, never logged, never put
 * in an error message, and never returned by {@link login}.
 */
import { nowIso } from "@nightshift/core";
import type { CognitoProfile, Profile } from "@nightshift/persistence/http";
import {
  isTokenProfile,
  profilePath,
  readProfile,
  tokenClaims,
  writeCredentials,
  writeProfile,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import { DEFAULT_STAGE, defaultsFor, isGeneratedEndpoint } from "../hostnames.js";
import type { Loopback } from "../loopback.js";
import { authorizeUrl, exchangeAuthorizationCode } from "../oauth.js";
import { PastedCallbackError, parsePastedCallback } from "../paste.js";
import {
  assertState,
  createPkce,
  createState,
  type RandomBytes,
  StateMismatchError,
} from "../pkce.js";

export { DEFAULT_STAGE } from "../hostnames.js";

/** The stage `nightshift local` writes; never a hosted one (D-P12-05). */
export const LOCAL_STAGE = "local";

export interface LoginFlags {
  readonly api?: string;
  readonly authDomain?: string;
  readonly clientId?: string;
  readonly stage?: string;
  /** Print the URL and do not try to open a browser (an SSH session, a container). */
  readonly noBrowser?: boolean;
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
  readonly profile: CognitoProfile;
  readonly subject: string;
  readonly email: string | undefined;
}

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/** A domain, however it was pasted: a bare host, an origin, or a URL. */
const normalizeAuthDomain = (value: string): string =>
  trimTrailingSlashes(value.replace(/^https?:\/\//, ""));

/** What `resolveProfile` decided, and what it wants said about it. */
export interface ResolvedProfile {
  readonly profile: CognitoProfile;
  /** Lines worth telling the operator: a rewritten value, for instance. */
  readonly notes: readonly string[];
}

/**
 * The profile to sign in with: flags, then the stored profile, then the stage's
 * shipped defaults (D-P3-18).
 *
 * The precedence is the whole of this function. A developer's flag always wins.
 * A stored value is kept — that is what "a second login needs no flags" means —
 * with one exception: a stored generated `execute-api` endpoint is replaced by
 * the stable hostname and the operator is told, because the generated name is
 * the one a stack replacement changes. Everything else comes from the rule, so a
 * fresh machine signs in with `nightshift login` and nothing after it.
 *
 * The only way to fail is a stage this CLI ships no client id for and no flag
 * naming one; that failure names the flag and where its value lives.
 */
export const resolveProfile = (flags: LoginFlags, stored: Profile | undefined): ResolvedProfile => {
  // A local instance's profile says nothing about where to sign in: it has no
  // sign-in (D-P12-03), so its stage is not the default for `login`.
  const signedIn = stored === undefined || isTokenProfile(stored) ? undefined : stored;
  const stage = flags.stage ?? signedIn?.stage ?? DEFAULT_STAGE;
  if (stage === LOCAL_STAGE) {
    throw new UsageError(
      "the local instance has no sign-in",
      "Start it with `nightshift local`; it writes its own profile. `nightshift use <stage>` switches back to a hosted one.",
    );
  }
  // A stored profile for another stage says nothing about this one.
  const kept = signedIn !== undefined && signedIn.stage === stage ? signedIn : undefined;
  const defaults = defaultsFor(stage);
  const notes: string[] = [];

  let apiEndpoint = flags.api ?? kept?.apiEndpoint;
  if (apiEndpoint === undefined) {
    apiEndpoint = defaults.apiEndpoint;
  } else if (flags.api === undefined && isGeneratedEndpoint(apiEndpoint)) {
    notes.push(
      `the stored control plane ${apiEndpoint} is a generated hostname a redeploy can change; ` +
        `using ${defaults.apiEndpoint} instead`,
    );
    apiEndpoint = defaults.apiEndpoint;
  }

  const authDomain = flags.authDomain ?? kept?.authDomain ?? defaults.authDomain;
  const clientId = flags.clientId ?? kept?.clientId ?? defaults.clientId;

  if (clientId === undefined) {
    throw new UsageError(
      `stage "${stage}" ships no interactive client id, so --client-id is required`,
      "The value is the data stack's `InteractiveClientId` output for that stage. " +
        "After one successful login it is remembered and `nightshift login --stage " +
        `${stage}\` takes no other flag.`,
    );
  }

  return {
    profile: {
      apiEndpoint: trimTrailingSlashes(apiEndpoint),
      authDomain: normalizeAuthDomain(authDomain),
      clientId,
      stage,
    },
    notes,
  };
};

/**
 * The code, from whichever arrives first: the loopback callback or a paste.
 *
 * A paste that is not a callback, or carries the wrong `state`, is reported and
 * the wait continues; the operator can paste again or finish in the browser. A
 * machine with no terminal (`line` resolves `undefined`) waits on the callback
 * alone, which is the pre-paste behaviour exactly.
 */
const waitForCode = async (
  loopback: Loopback,
  environment: CliEnvironment,
  checkState: (received: string | null) => void,
): Promise<string> => {
  // Read by the race below; the timeout rejection is handled there, so the
  // extra handler only keeps it from ever counting as unhandled after a paste
  // has already won.
  void loopback.code.catch(() => undefined);
  const callback = loopback.code.then((code) => ({ kind: "callback" as const, code }));

  let paste = environment.readPaste();
  try {
    for (;;) {
      const winner = await Promise.race([
        callback,
        paste.line.then((line) => ({ kind: "paste" as const, line })),
      ]);
      if (winner.kind === "callback") return winner.code;
      if (winner.line === undefined) return (await callback).code;
      try {
        return parsePastedCallback(winner.line, checkState);
      } catch (error) {
        if (error instanceof PastedCallbackError || error instanceof StateMismatchError) {
          environment.err(`${error.message}. Paste again, or finish the sign-in in the browser.`);
          paste = environment.readPaste();
          continue;
        }
        throw error;
      }
    }
  } finally {
    paste.cancel();
  }
};

export const login = async (
  environment: CliEnvironment,
  options: LoginOptions,
): Promise<LoginResult> => {
  // The profile of the stage being signed into, when there is one; else the
  // current one, whose stage is the default.
  const current = await readProfile(environment.paths);
  const stored =
    options.flags.stage === undefined
      ? current
      : ((await readProfile(environment.paths, options.flags.stage)) ?? current);
  const { profile, notes } = resolveProfile(options.flags, stored);
  for (const note of notes) environment.out(note);

  // Step 2: before any network call. See the module comment.
  await writeProfile(profile, environment.paths);
  environment.out(
    `profile written to ${profilePath(environment.paths)} (control plane ${profile.apiEndpoint}, stage ${profile.stage})`,
  );

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

    const opened = options.flags.noBrowser === true ? false : await environment.openBrowser(url);
    environment.out(
      opened
        ? "opened a browser on this machine to sign in. If no window appeared (over SSH, for " +
            "example), open this URL in a browser that can reach " +
            `${loopback.redirectUri.replace(/\/callback$/, "")} on this machine:`
        : options.flags.noBrowser === true
          ? "open this URL to sign in:"
          : "could not open a browser. Open this URL to sign in:",
    );
    environment.out(url);
    environment.out(
      `waiting for the callback on ${loopback.redirectUri}. If the browser cannot reach it, ` +
        "paste the address it was redirected to (or just the code) here and press Enter:",
    );

    const code = await waitForCode(loopback, environment, (received) => {
      assertState(state, received);
    });

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
