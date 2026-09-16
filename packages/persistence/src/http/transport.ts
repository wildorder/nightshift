/**
 * The seam between the stores and the network.
 *
 * A `Transport` is a function from a request to a status and a body. The stores
 * are written against it and nothing else, so a test can drive every store with
 * no socket at all, and the production implementation is the only thing that
 * knows about `fetch`, tokens, retries or backoff.
 *
 * ## Why every request here is safe to retry
 *
 * Retrying a request that is not idempotent turns a timeout into a duplicate.
 * Every request this adapter makes is idempotent **by construction**, and it is
 * worth writing down which mechanism makes each one so rather than leaving it to
 * be rediscovered:
 *
 * - `GET` is a read.
 * - `PUT` on a record is create-or-confirm: an identical retry answers 200 with
 *   the stored record. The client mints the identifier, so a retry addresses the
 *   same record.
 * - `PUT` on a run or an agent is a transition to a **named status**, not an
 *   increment. Replaying "become `running`" against a run that is already
 *   `running` answers 200 through the identical-record path.
 * - `POST …/events` carries an idempotency key; a duplicate stores nothing and
 *   returns the event that was already there.
 * - `POST …/artifacts/{id}/upload-url` signs; signing has no effect on anything.
 *
 * So the retry policy applies to the whole surface. A future route that is not
 * idempotent must say so here, or it will be retried.
 *
 * ## Two different failures, kept apart
 *
 * A 5xx that survives every attempt is **returned** as a response, so the caller
 * sees the status and whatever the server said.
 * {@link ControlPlaneUnreachableError} is raised only when there was no answer at
 * all — a refused connection, a DNS failure, a socket that died. The control
 * plane failing and the network failing are different problems, and a caller
 * deciding whether to spool an event and retry later needs to tell them apart.
 */
import type { Clock } from "@nightshift/core";
import { ControlPlaneUnreachableError, toThrowable } from "./errors.js";

export interface ControlPlaneRequest {
  readonly method: "GET" | "PUT" | "POST";
  /** Path with no origin and no stage prefix, e.g. `/projects/proj_…`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  /** Omitted for a request with no body. */
  readonly body?: unknown;
}

export interface ControlPlaneResponse {
  readonly status: number;
  readonly body: unknown;
}

export type Transport = (request: ControlPlaneRequest) => Promise<ControlPlaneResponse>;

/** Mints an ID token, refreshing it when it is close to expiry. */
export interface TokenProvider {
  idToken(): Promise<string>;
}

/** The slice of `fetch` this adapter uses, so a test injects three lines. */
export type FetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retrying. */
  readonly attempts: number;
  readonly initialDelayMs: number;
  /** Each delay multiplies the last by this. */
  readonly factor: number;
  readonly maxDelayMs: number;
}

/**
 * Four attempts over roughly two seconds.
 *
 * Sized for the failure this exists for: a laptop's connection blinking, or an
 * API Gateway 502 during a Lambda cold start. A long retry budget would make a
 * worker's progress event outlive the tool call that reported it, and the outbox
 * (T5) is what handles a genuine outage.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 4,
  initialDelayMs: 100,
  factor: 3,
  maxDelayMs: 2_000,
};

export interface FetchTransportOptions {
  /** Origin with no trailing slash, e.g. `https://….execute-api.us-west-2.amazonaws.com`. */
  readonly endpoint: string;
  readonly tokens: TokenProvider;
  readonly fetch?: FetchLike;
  readonly retry?: RetryPolicy;
  /** Injected so a test does not wait out a backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: Clock;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const buildUrl = (endpoint: string, request: ControlPlaneRequest): string => {
  const entries = Object.entries(request.query ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (entries.length === 0) return `${endpoint}${request.path}`;
  return `${endpoint}${request.path}?${new URLSearchParams(entries).toString()}`;
};

const parseBody = (text: string): unknown => {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A gateway refusal may not be JSON. Keep the text so a human can read it.
    return text;
  }
};

/** A 5xx is the server having a bad moment; a 4xx is the server's considered answer. */
const isRetryableStatus = (status: number): boolean => status >= 500;

/** One attempt: either a response, or the failure that stopped it reaching one. */
type Attempt =
  | { readonly kind: "response"; readonly response: ControlPlaneResponse }
  | { readonly kind: "unreachable"; readonly cause: unknown };

export const createFetchTransport = (options: FetchTransportOptions): Transport => {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const retry = options.retry ?? DEFAULT_RETRY;
  const sleep = options.sleep ?? defaultSleep;
  const endpoint = options.endpoint.replace(/\/+$/, "");

  const attempt = async (request: ControlPlaneRequest, url: string): Promise<Attempt> => {
    try {
      // The **ID** token, not the access token. The authorizer's audience lists
      // the interactive client, and `custom:active_org` — the claim the control
      // plane resolves an org from — appears only in ID tokens on the pool's
      // Lite feature plan (`apps/api/src/auth/acting-org.ts`). An access token
      // would authenticate and then fail to resolve an org.
      const headers: Record<string, string> = {
        authorization: `Bearer ${await options.tokens.idToken()}`,
      };
      if (request.body !== undefined) headers["content-type"] = "application/json";

      const response = await doFetch(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      return {
        kind: "response",
        response: { status: response.status, body: parseBody(await response.text()) },
      };
    } catch (cause) {
      // A network failure, a DNS failure, a refused connection, or a token that
      // could not be minted. Never a 4xx: those arrive as a response.
      return { kind: "unreachable", cause };
    }
  };

  /** Why an attempt did not end the loop, as a message the final failure can quote. */
  const describeRetryable = (result: Attempt): unknown =>
    result.kind === "unreachable"
      ? result.cause
      : new Error(
          `the control plane answered ${result.response.status}: ${JSON.stringify(result.response.body)}`,
        );

  /** Whether this attempt's outcome is worth trying again. */
  const worthRetrying = (result: Attempt): boolean =>
    result.kind === "unreachable" || isRetryableStatus(result.response.status);

  return async (request) => {
    const url = buildUrl(endpoint, request);
    let delay = retry.initialDelayMs;
    let lastCause: unknown;

    for (let n = 1; n <= retry.attempts; n += 1) {
      const result = await attempt(request, url);
      // A 5xx on the last attempt is returned, not masked: the caller wants the
      // status and whatever the server said, not a generic "unreachable".
      if (result.kind === "response" && !(worthRetrying(result) && n < retry.attempts)) {
        return result.response;
      }
      lastCause = describeRetryable(result);
      if (n === retry.attempts) break;
      await sleep(delay);
      delay = Math.min(delay * retry.factor, retry.maxDelayMs);
    }

    throw new ControlPlaneUnreachableError(
      `the control plane could not be reached after ${retry.attempts} attempts: ${
        lastCause instanceof Error ? lastCause.message : String(lastCause)
      }`,
      retry.attempts,
      lastCause,
    );
  };
};

/**
 * Sends `request` and returns its body, throwing the typed failure for any
 * status outside `expected`.
 *
 * Every store method goes through this, so "a 409 with a domain code becomes
 * that error class" is true once rather than twenty times.
 */
export const send = async (
  transport: Transport,
  request: ControlPlaneRequest,
  expected: readonly number[] = [200, 201],
): Promise<unknown> => {
  const response = await transport(request);
  if (!expected.includes(response.status)) throw toThrowable(response.status, response.body);
  return response.body;
};
