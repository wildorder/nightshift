import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorizationRefusedError,
  CallbackTimeoutError,
  LOOPBACK_CALLBACK_URL,
  LOOPBACK_HOST,
  LOOPBACK_PORT,
  type Loopback,
  PortUnavailableError,
  startLoopback,
} from "./loopback.js";
import { assertState } from "./pkce.js";

const STATE = "the-state-this-process-sent";

const open: Loopback[] = [];
const others: Server[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((loopback) => loopback.close()));
  await Promise.all(
    others.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

const listen = async (overrides: { timeoutMs?: number } = {}): Promise<Loopback> => {
  const loopback = await startLoopback({
    state: STATE,
    port: 0,
    timeoutMs: 10_000,
    ...overrides,
    checkState: (received) => {
      assertState(STATE, received);
    },
  });
  open.push(loopback);
  return loopback;
};

const get = async (loopback: Loopback, path: string): Promise<Response> =>
  fetch(`http://${LOOPBACK_HOST}:${loopback.port}${path}`);

describe("the callback listener", () => {
  it("names the registered redirect URL when it holds the registered port", () => {
    expect(LOOPBACK_CALLBACK_URL).toBe(`http://localhost:${LOOPBACK_PORT}/callback`);
    expect(LOOPBACK_PORT).toBe(47821);
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });

  it("accepts one callback, answers the browser, and closes", async () => {
    const loopback = await listen();

    const response = await get(loopback, `/callback?code=abc123&state=${STATE}`);

    expect(response.status).toBe(200);
    await expect(loopback.code).resolves.toBe("abc123");
    // The socket is gone once the one callback has been served.
    await loopback.close();
    await expect(get(loopback, "/callback")).rejects.toThrow();
  });

  it("answers a browser's incidental fetches without consuming the one callback", async () => {
    const loopback = await listen();

    expect((await get(loopback, "/favicon.ico")).status).toBe(404);
    expect((await get(loopback, "/")).status).toBe(404);

    await get(loopback, `/callback?code=still-works&state=${STATE}`);
    await expect(loopback.code).resolves.toBe("still-works");
  });

  it("refuses a callback whose state it did not send", async () => {
    const loopback = await listen();

    const response = await get(loopback, "/callback?code=abc123&state=some-other-state");

    expect(response.status).toBe(400);
    await expect(loopback.code).rejects.toThrow(/did not send/);
  });

  it("refuses a callback with no state at all", async () => {
    const loopback = await listen();

    await get(loopback, "/callback?code=abc123");

    await expect(loopback.code).rejects.toThrow(/did not send/);
  });

  it("reports the authorization server's own refusal", async () => {
    const loopback = await listen();

    await get(
      loopback,
      `/callback?error=access_denied&error_description=user+said+no&state=${STATE}`,
    );

    await expect(loopback.code).rejects.toThrow(AuthorizationRefusedError);
    await expect(loopback.code).rejects.toThrow(/access_denied/);
  });

  it("refuses a callback that carried no code", async () => {
    const loopback = await listen();

    await get(loopback, `/callback?state=${STATE}`);

    await expect(loopback.code).rejects.toThrow(/no authorization code/);
  });

  it("gives the terminal back when no callback ever arrives", async () => {
    const loopback = await listen({ timeoutMs: 20 });

    await expect(loopback.code).rejects.toThrow(CallbackTimeoutError);
  });

  it("explains a busy port rather than choosing another one", async () => {
    const blocker = createServer();
    others.push(blocker);
    await new Promise<void>((resolve) => {
      blocker.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
        resolve();
      });
    });
    const address = blocker.address();
    const taken = address !== null && typeof address !== "string" ? address.port : 0;

    const failure = await startLoopback({
      state: STATE,
      port: taken,
      checkState: () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PortUnavailableError);
    const message = (failure as Error).message;
    expect(message).toContain("already in use");
    // The two things an operator needs: that the port is not negotiable, and how
    // to find what holds it.
    expect(message).toContain("Cognito matches a redirect URI exactly");
    expect(message).toContain(`lsof -nP -iTCP:${taken}`);
  });
});
