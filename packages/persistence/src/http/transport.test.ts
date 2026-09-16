import { createFixedClock, rejectionOf } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import { ControlPlaneUnreachableError } from "./errors.js";
import {
  type ControlPlaneRequest,
  createFetchTransport,
  type FetchLike,
  send,
  type TokenProvider,
} from "./transport.js";

const tokens: TokenProvider = { idToken: async () => "the-id-token" };

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** A fetch that answers a scripted sequence, recording what it was asked. */
const scriptedFetch = (
  answers: readonly (number | Error)[],
  body: unknown = {},
): { fetch: FetchLike; calls: Call[] } => {
  const calls: Call[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) throw answer;
    return { status: answer ?? 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
};

const transportOver = (fetch: FetchLike, attempts = 4) =>
  createFetchTransport({
    endpoint: "https://control.invalid",
    tokens,
    fetch,
    retry: { attempts, initialDelayMs: 1, factor: 2, maxDelayMs: 4 },
    // Never actually wait: a retry test that slept would be a slow test.
    sleep: async () => {},
    clock: createFixedClock(0),
  });

const GET: ControlPlaneRequest = { method: "GET", path: "/projects" };

describe("the fetch transport", () => {
  it("sends the ID token as a bearer credential", async () => {
    const { fetch, calls } = scriptedFetch([200]);
    await transportOver(fetch)(GET);
    expect(calls[0]?.headers.authorization).toBe("Bearer the-id-token");
  });

  it("sets a content type only when there is a body", async () => {
    const { fetch, calls } = scriptedFetch([200, 200]);
    const transport = transportOver(fetch);
    await transport(GET);
    await transport({ method: "PUT", path: "/projects/x", body: { name: "a" } });
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
    expect(calls[1]?.headers["content-type"]).toBe("application/json");
    expect(calls[1]?.body).toBe(JSON.stringify({ name: "a" }));
  });

  it("builds a query string, dropping absent parameters", async () => {
    const { fetch, calls } = scriptedFetch([200]);
    await transportOver(fetch)({
      method: "GET",
      path: "/p/events",
      query: { limit: "10", cursor: undefined, afterSequence: "3" },
    });
    expect(calls[0]?.url).toBe("https://control.invalid/p/events?limit=10&afterSequence=3");
  });

  it("strips a trailing slash from the endpoint rather than doubling it", async () => {
    const { fetch, calls } = scriptedFetch([200]);
    const transport = createFetchTransport({
      endpoint: "https://control.invalid/",
      tokens,
      fetch,
    });
    await transport(GET);
    expect(calls[0]?.url).toBe("https://control.invalid/projects");
  });

  describe("retrying", () => {
    it("retries a 5xx and returns the first success", async () => {
      const { fetch, calls } = scriptedFetch([503, 502, 200]);
      const response = await transportOver(fetch)(GET);
      expect(calls).toHaveLength(3);
      expect(response.status).toBe(200);
    });

    it("retries a network failure", async () => {
      const { fetch, calls } = scriptedFetch([new Error("ECONNRESET"), 200]);
      expect((await transportOver(fetch)(GET)).status).toBe(200);
      expect(calls).toHaveLength(2);
    });

    it("never retries a 4xx: it is the server's considered answer", async () => {
      for (const status of [400, 403, 404, 409, 422, 429]) {
        const { fetch, calls } = scriptedFetch([status]);
        const response = await transportOver(fetch)(GET);
        expect(response.status, String(status)).toBe(status);
        expect(calls, String(status)).toHaveLength(1);
      }
    });

    /**
     * A 5xx that survives every attempt is **returned**, not turned into an
     * unreachable error. The caller then gets the status and whatever the server
     * said, through `send`'s typed failure. `ControlPlaneUnreachableError` is
     * reserved for the case where there was no answer at all, because those are
     * different problems: one is the control plane failing, the other is the
     * network.
     */
    it("returns a 5xx that survived every attempt, having tried them all", async () => {
      const { fetch, calls } = scriptedFetch([500], {
        error: { code: "internal_error", message: "internal error" },
      });
      const response = await transportOver(fetch)(GET);
      expect(response.status).toBe(500);
      expect(calls).toHaveLength(4);
      await expect(send(transportOver(fetch), GET)).rejects.toThrow("internal error");
    });

    it("surfaces a persistent network failure as unreachable, not as a status", async () => {
      const { fetch } = scriptedFetch([new Error("getaddrinfo ENOTFOUND")]);
      const failure = await rejectionOf(transportOver(fetch)(GET));
      expect(failure).toBeInstanceOf(ControlPlaneUnreachableError);
      expect((failure as ControlPlaneUnreachableError).attempts).toBe(4);
      expect(failure.message).toMatch(/ENOTFOUND/);
    });

    it("makes exactly one attempt when retrying is disabled", async () => {
      const { fetch, calls } = scriptedFetch([500]);
      expect((await transportOver(fetch, 1)(GET)).status).toBe(500);
      expect(calls).toHaveLength(1);
    });
  });

  it("keeps a body that is not JSON rather than throwing on it", async () => {
    // A gateway refusal is often HTML. Losing it would lose the only clue.
    const html: FetchLike = async () => ({ status: 502, text: async () => "<html>gateway</html>" });
    expect((await transportOver(html, 1)(GET)).body).toBe("<html>gateway</html>");

    const ok: FetchLike = async () => ({ status: 200, text: async () => "not json" });
    expect((await transportOver(ok)(GET)).body).toBe("not json");
  });
});

describe("send", () => {
  it("returns the body for an expected status", async () => {
    const { fetch } = scriptedFetch([201], { items: [] });
    expect(await send(transportOver(fetch), GET)).toEqual({ items: [] });
  });

  it("throws the typed failure for an unexpected status", async () => {
    const { fetch } = scriptedFetch([404], {
      error: { code: "not_found", message: "no such run" },
    });
    await expect(send(transportOver(fetch), GET)).rejects.toThrow("no such run");
  });
});
