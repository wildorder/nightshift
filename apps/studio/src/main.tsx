/**
 * The Studio's composition root: the real browser session over the real HTTP
 * stores (D-P11-04, D-P11-07). Everything below `App` is the same tree a test
 * mounts over the memory stores.
 */
import { ArtifactDownloadResponseSchema, ProjectSchema } from "@nightshift/contracts";
import { createUlidIdGenerator, nowIso, systemClock } from "@nightshift/core";
import {
  createFetchTransport,
  createHttpStores,
  routes,
  type Transport,
} from "@nightshift/persistence/http/browser";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app.js";
import {
  beginSignIn,
  CALLBACK_PATH,
  completeSignIn,
  createBrowserTokenProvider,
  hasSession,
  type SessionEnvironment,
  signOut,
} from "./auth/session.js";
import { forgetLocalToken, LOCAL_IDENTITY, takeLocalToken } from "./auth/token-session.js";
import { type CognitoStudioConfig, loadConfig, type TokenStudioConfig } from "./config.js";
import "./index.css";
import { LocalStartPage, SignInPage } from "./pages/sign-in.js";
import type { Studio } from "./studio.js";

const root = createRoot(document.getElementById("root") as HTMLElement);

const render = (node: React.ReactNode): void => root.render(<StrictMode>{node}</StrictMode>);

/** The acting org, as `whoami` learns it: from the projects the token can list. */
const resolveOrg = async (transport: Transport): Promise<Studio["orgId"]> => {
  const response = await transport({
    method: "GET",
    path: routes.projects(),
    query: { limit: "1" },
  });
  if (response.status !== 200) return undefined;
  const items = ((response.body as { items?: unknown[] } | null)?.items ?? []).map((item) =>
    ProjectSchema.parse(item),
  );
  return items[0]?.orgId;
};

/** The download URL the control plane signs (D-P11-06). */
const artifactsOver = (transport: Transport): NonNullable<Studio["artifacts"]> => ({
  downloadUrl: async (scope, artifactId) => {
    const response = await transport({
      method: "POST",
      path: routes.artifactDownloadUrl(scope, artifactId),
    });
    if (response.status !== 200) {
      throw new Error(`the control plane would not sign a download (${response.status})`);
    }
    return ArtifactDownloadResponseSchema.parse(response.body).url;
  },
});

/** Everything below the session: the same for a hosted stage and a local instance. */
const renderStudio = async (
  transport: Transport,
  identity: Studio["identity"],
  signOutAndLeave: () => Promise<void>,
): Promise<void> => {
  const orgId = await resolveOrg(transport);
  const studio: Studio = {
    stores: createHttpStores({ transport, ...(orgId === undefined ? {} : { actingOrg: orgId }) }),
    identity,
    orgId,
    ids: createUlidIdGenerator(),
    now: () => nowIso(systemClock),
    artifacts: artifactsOver(transport),
    signOut: signOutAndLeave,
  };
  render(
    <BrowserRouter>
      <App studio={studio} />
    </BrowserRouter>,
  );
};

/** A local instance (D-P12-04): the bearer is the secret from the start URL. */
const startLocal = async (config: TokenStudioConfig): Promise<void> => {
  const token = takeLocalToken(window.location, window.sessionStorage, (url) =>
    window.history.replaceState(null, "", url),
  );
  if (token === undefined) {
    render(<LocalStartPage />);
    return;
  }
  const transport = createFetchTransport({
    endpoint: config.apiEndpoint,
    tokens: { idToken: async () => token },
  });
  await renderStudio(transport, LOCAL_IDENTITY, async () => {
    forgetLocalToken(window.sessionStorage);
    render(<LocalStartPage signedOut />);
  });
};

/** A hosted stage (D-P11-04): the pool's hosted UI, PKCE, the refresh token kept. */
const startHosted = async (config: CognitoStudioConfig): Promise<void> => {
  const env: SessionEnvironment = {
    config,
    durable: window.localStorage,
    tab: window.sessionStorage,
    fetch: (url, init) => fetch(url, init),
    random: window.crypto,
    digest: window.crypto.subtle,
    origin: window.location.origin,
    navigate: (url) => window.location.assign(url),
    now: () => Date.now(),
  };
  const signIn = () => void beginSignIn(env);

  if (window.location.pathname === CALLBACK_PATH) {
    try {
      await completeSignIn(env, new URLSearchParams(window.location.search));
      window.history.replaceState(null, "", "/");
    } catch (error) {
      render(<SignInPage onSignIn={signIn} problem={String(error)} />);
      return;
    }
  }

  if (!hasSession(env)) {
    render(<SignInPage onSignIn={signIn} />);
    return;
  }

  const tokens = createBrowserTokenProvider(env);
  const transport = createFetchTransport({ endpoint: config.apiEndpoint, tokens });
  let identity: Studio["identity"];
  try {
    identity = await tokens.identity();
  } catch (error) {
    // A stored refresh token Cognito no longer honours: start over, honestly.
    await signOut(env);
    render(<SignInPage onSignIn={signIn} problem={`Your session ended: ${String(error)}`} />);
    return;
  }
  await renderStudio(transport, identity, async () => {
    await signOut(env);
    window.location.assign("/");
  });
};

const start = async (): Promise<void> => {
  const config = await loadConfig(async (url) => fetch(url));
  await (config.kind === "token" ? startLocal(config) : startHosted(config));
};

start().catch((error: unknown) => {
  render(
    <main className="m-8 rounded border border-red-300 bg-red-50 p-4 text-red-900">
      <h1 className="font-semibold">The Studio could not start</h1>
      <pre className="whitespace-pre-wrap text-sm">{String(error)}</pre>
    </main>,
  );
});
