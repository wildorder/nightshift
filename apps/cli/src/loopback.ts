/**
 * The one-request listener that receives the authorization code.
 *
 * Cognito has no OAuth device flow, so an interactive sign-in from a terminal is
 * the loopback redirect `aws sso login` and `gh auth login` use: the browser is
 * sent to the hosted UI, and the hosted UI sends the code back to a server this
 * process runs for a few seconds.
 *
 * Three properties are load-bearing, and each is a rule rather than a
 * preference:
 *
 * - **The port is fixed at 47821.** Cognito matches a callback URL exactly, port
 *   included, and the data stack registered exactly one
 *   (`LOOPBACK_CALLBACK_URL`). A port chosen at runtime would be refused by the
 *   authorization server, so a busy port is a clear failure here rather than a
 *   confusing one three redirects later.
 * - **It binds `127.0.0.1`, not `0.0.0.0`.** The value arriving at this socket
 *   is an authorization code for the operator's account. Bound to every
 *   interface it would be reachable from the coffee-shop network the laptop is
 *   on.
 * - **It accepts exactly one callback and closes.** A listener that outlived the
 *   sign-in would be a local endpoint that redeems codes, left running.
 *
 * The registered URL says `localhost` while the socket binds `127.0.0.1`. That
 * is deliberate, not an inconsistency: the redirect URI is a string Cognito
 * compares byte for byte, and the bind address is a decision about which
 * interfaces are listening. `localhost` resolves to the loopback address, so the
 * browser arrives at exactly this socket.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** Fixed by the data stack (`LOOPBACK_CALLBACK_URL`). Not configurable. */
export const LOOPBACK_PORT = 47821;
export const LOOPBACK_HOST = "127.0.0.1";
export const CALLBACK_PATH = "/callback";
/** The string sent as `redirect_uri`. Must match the registered URL exactly. */
export const LOOPBACK_CALLBACK_URL = `http://localhost:${LOOPBACK_PORT}${CALLBACK_PATH}`;

/** How long the listener waits before giving the terminal back. */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;

/** Raised when something else already holds the one port Cognito will redirect to. */
export class PortUnavailableError extends Error {
  override readonly name = "PortUnavailableError";
  readonly code = "port_unavailable" as const;

  constructor(
    readonly port: number,
    override readonly cause: unknown,
  ) {
    super(
      `${LOOPBACK_HOST}:${port} is already in use, so \`nightshift login\` cannot receive the ` +
        "sign-in callback. That port is not a preference: Cognito matches a redirect URI " +
        "exactly, port included, and the data stack registered only " +
        `${LOOPBACK_CALLBACK_URL}, so it cannot be chosen at runtime. Find what holds it with ` +
        `\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` (macOS, Linux) or ` +
        `\`netstat -ano | findstr :${port}\` (Windows) — most often an earlier \`nightshift ` +
        "login` that is still waiting — stop it, and run `nightshift login` again.",
    );
  }
}

/** Raised when the authorization server redirected with an error instead of a code. */
export class AuthorizationRefusedError extends Error {
  override readonly name = "AuthorizationRefusedError";
  readonly code = "authorization_refused" as const;

  constructor(
    readonly reason: string,
    description: string | null,
  ) {
    super(
      `the sign-in was refused (${reason})${description === null ? "" : `: ${description}`}. ` +
        "Nothing was written; run `nightshift login` again to retry.",
    );
  }
}

export class CallbackTimeoutError extends Error {
  override readonly name = "CallbackTimeoutError";
  readonly code = "callback_timeout" as const;

  constructor(timeoutMs: number) {
    super(
      `no sign-in callback arrived within ${Math.round(timeoutMs / 1000)}s, so the listener on ` +
        `${LOOPBACK_HOST}:${LOOPBACK_PORT} was closed. Run \`nightshift login\` again when you ` +
        "are ready to finish the sign-in in the browser.",
    );
  }
}

export interface LoopbackOptions {
  /** The value the callback's `state` must equal. */
  readonly state: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  /** Compares the received `state`. Injected so the check itself stays one tested function. */
  readonly checkState: (received: string | null) => void;
}

export interface Loopback {
  /** The exact string to send as `redirect_uri`. */
  readonly redirectUri: string;
  /** The port actually bound, which is {@link LOOPBACK_PORT} unless a test says otherwise. */
  readonly port: number;
  /** Resolves with the authorization code from the one accepted callback. */
  readonly code: Promise<string>;
  /** Idempotent. Safe to call whether or not a callback arrived. */
  close(): Promise<void>;
}

/** What to show the human whose browser just landed here. Plain, and tiny. */
const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:34rem"><h1>${title}</h1>` +
  `<p>${body}</p></body>`;

const respond = (response: ServerResponse, status: number, html: string): void => {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
};

/**
 * Starts the listener.
 *
 * Resolves once the socket is bound — so `nightshift login` can be sure the
 * listener is up *before* it sends a browser anywhere — and rejects with
 * {@link PortUnavailableError} if it cannot bind.
 */
export const startLoopback = async (options: LoopbackOptions): Promise<Loopback> => {
  const requestedPort = options.port ?? LOOPBACK_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  /** The port actually bound. Differs from the request only for `0`, which a test uses. */
  let port = requestedPort;

  let settle: (outcome: { code: string } | { error: unknown }) => void = () => undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = (outcome) => {
      if ("code" in outcome) resolve(outcome.code);
      else reject(outcome.error);
    };
  });
  // Nothing is awaiting `code` between here and the caller taking it, and an
  // early failure (a refused authorization, say) would otherwise be an
  // unhandled rejection that kills the process.
  code.catch(() => undefined);

  /** Set once the one callback has been accepted, so a second is not served. */
  let done = false;

  const server = createServer();

  let closed: Promise<void> | undefined;
  const closeServer = (): Promise<void> => {
    clearTimeout(timer);
    closed ??= new Promise<void>((resolve) => {
      // Browsers keep the connection alive after the redirect, and an idle
      // keep-alive socket would hold `close` open until it timed out.
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    return closed;
  };

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    settle({ error: new CallbackTimeoutError(timeoutMs) });
    void closeServer();
  }, timeoutMs);
  // A login that is waiting has a pending socket keeping the loop alive already;
  // this timer must not be the thing that does.
  timer.unref();

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);

    // Anything that is not the callback — `/favicon.ico` above all — is answered
    // and ignored. "Exactly one request" is a rule about the callback, and a
    // browser's incidental fetches must not consume it.
    if (url.pathname !== CALLBACK_PATH) {
      respond(response, 404, page("Not here", "This is the Nightshift sign-in listener."));
      return;
    }
    if (done) {
      respond(response, 409, page("Already done", "This sign-in has already been completed."));
      return;
    }
    done = true;

    const fail = (error: unknown, status: number, title: string, body: string): void => {
      respond(response, status, page(title, body));
      settle({ error });
      void closeServer();
    };

    const error = url.searchParams.get("error");
    if (error !== null) {
      fail(
        new AuthorizationRefusedError(error, url.searchParams.get("error_description")),
        400,
        "Sign-in refused",
        "The authorization server refused the sign-in. Return to your terminal.",
      );
      return;
    }

    try {
      options.checkState(url.searchParams.get("state"));
    } catch (mismatch) {
      fail(
        mismatch,
        400,
        "Refused",
        "This callback does not belong to the sign-in your terminal started. Return to your terminal.",
      );
      return;
    }

    const authorizationCode = url.searchParams.get("code");
    if (authorizationCode === null || authorizationCode === "") {
      fail(
        new AuthorizationRefusedError("no_code", "the callback carried no authorization code"),
        400,
        "Sign-in incomplete",
        "The callback carried no authorization code. Return to your terminal.",
      );
      return;
    }

    respond(
      response,
      200,
      page("Signed in", "Nightshift has your session. You can close this tab."),
    );
    settle({ code: authorizationCode });
    void closeServer();
  };

  server.on("request", handle);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", (cause) => {
        reject(new PortUnavailableError(requestedPort, cause));
      });
      server.listen({ host: LOOPBACK_HOST, port: requestedPort }, () => {
        const address = server.address();
        // `0` asks the operating system for a free port; the bound one is what
        // the redirect URI has to name. In production the request is 47821 and
        // this changes nothing.
        if (address !== null && typeof address !== "string") port = address.port;
        // Replace the bind-time handler: a later socket error must not reject a
        // promise that has already settled.
        server.removeAllListeners("error");
        server.on("error", () => undefined);
        resolve();
      });
    });
  } catch (bindError) {
    clearTimeout(timer);
    throw bindError;
  }

  return {
    redirectUri:
      port === LOOPBACK_PORT ? LOOPBACK_CALLBACK_URL : `http://localhost:${port}${CALLBACK_PATH}`,
    port,
    code,
    close: closeServer,
  };
};
