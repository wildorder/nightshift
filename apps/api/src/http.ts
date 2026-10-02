/**
 * The request and response shapes the handler works in, independent of API
 * Gateway. Tests speak these; only `lambda/api-handler.ts` knows the Lambda event.
 */
import type { ErrorResponse } from "@nightshift/contracts";
import type {
  ArtifactDownloadSigner,
  ArtifactUploadSigner,
  Clock,
  Envelope,
  GitHubAppClient,
  IdGenerator,
  NightshiftStores,
  PlanDocumentStore,
  RunScope,
} from "@nightshift/core";
import type { z } from "zod";
import type { ProjectOrgCache } from "./auth/enforce.js";
import type { RequestPrincipal } from "./auth/principal.js";
import type { ExecutionTokenSigner } from "./tokens/mint.js";

export interface ApiRequest {
  readonly method: string;
  /** The path without a stage prefix, e.g. `/projects/proj_…`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON, or `undefined` when there was no body. */
  readonly body: unknown;
  /**
   * Who is calling, as Nightshift's authorizer proved them (D-P4-01, A-33, A-36).
   *
   * A typed value, never a claim set: the authorizer validated the token and
   * decided its kind before this code ran, and the handler contains no
   * verification code of its own (SC-P4-10).
   */
  readonly principal: RequestPrincipal;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** What the handler needs. It never learns which adapter backs `stores`. */
export interface ApiDeps {
  readonly stores: NightshiftStores;
  readonly clock: Clock;
  /**
   * Signs presigned artifact uploads (T2). Optional because the handler is a
   * pure function that many tests drive without object storage at all; the one
   * route that needs it answers 501 rather than 500 when it is absent, so a
   * misconfiguration names itself instead of looking like a crash.
   */
  readonly uploads?: ArtifactUploadSigner;
  /**
   * Signs presigned artifact downloads (P11, D-P11-06). Optional like
   * `uploads`, and for the same reason: the one route that needs it answers 501
   * when it is absent.
   */
  readonly downloads?: ArtifactDownloadSigner;
  /**
   * Ratified plan documents (P7, D-P7-02). Optional like `uploads`, and for the
   * same reason: the routes that need it answer 501 when it is absent.
   */
  readonly plans?: PlanDocumentStore;
  /**
   * Signs execution tokens (T2, D-P4-03). Optional for the same reason `uploads`
   * is: most tests drive the handler with no KMS at all, and the one route that
   * needs a signer answers 501 rather than 500 when it is absent, so a
   * misconfiguration names itself instead of looking like a crash.
   */
  readonly tokens?: ExecutionTokenIssuing;
  /**
   * The project → organisation cache `enforce` checks isolation with (D-P4-02).
   * Optional so a test can drive the handler without building one; when absent,
   * `handleRequest` builds a fresh cache per request, which is correct and
   * merely uncached.
   */
  readonly projectOrgs?: ProjectOrgCache;
  /**
   * Seals and opens an org's provider keys (P10, D-P10-23). Optional like the
   * signers: the two routes that need it answer 501 when it is absent, so a
   * plane wired without a key refuses to store a credential rather than
   * storing one in the clear.
   */
  readonly envelope?: Envelope;
  /** The Nightshift GitHub App (P10, D-P10-02). Optional for the same reason; 501 when absent. */
  readonly github?: GitHubAppClient;
  /** Mints the engine identity a dispatch carries (D-P10-20). ULIDs when absent. */
  readonly ids?: IdGenerator;
  /** What the runner's machines run (D-P10-16). Recorded on every dispatch. */
  readonly runner?: { readonly amiVersion: string };
  /**
   * Starts provisioning an accepted dispatch (D-P10-18): the dispatch Lambda,
   * invoked asynchronously. Optional like the rest; without it the dispatch
   * route answers 501 before recording anything, so no dispatch is ever
   * accepted that nothing will provision.
   */
  readonly dispatcher?: Dispatcher;
}

export interface Dispatcher {
  provision(scope: RunScope): Promise<void>;
}

/** Where execution tokens come from, and who they say issued them. */
export interface ExecutionTokenIssuing {
  readonly signer: ExecutionTokenSigner;
  /** `https://api.<stage>.nightshift.wildorder.dev` — set from the stage by the stack. */
  readonly issuer: string;
}

/** A refusal the handler decided on itself, as opposed to one raised by a domain rule. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: readonly unknown[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const errorBody = (
  code: string,
  message: string,
  issues?: readonly unknown[],
): ErrorResponse => ({
  error: issues === undefined ? { code, message } : { code, message, issues: [...issues] },
});

/** Validates a request body. Always the first thing an operation does (T4 deliverable 2). */
export const parseBody = <S extends z.ZodType>(schema: S, body: unknown): z.output<S> => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(
      400,
      "validation_failed",
      "request body failed validation",
      result.error.issues,
    );
  }
  return result.data;
};

/** Key-order-insensitive structural form; `undefined` properties count as absent. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
};

/** Whether two records are the same, regardless of key order. Decides retry versus conflict. */
export const sameRecord = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
