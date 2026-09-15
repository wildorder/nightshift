/**
 * The request and response shapes the handler works in, independent of API
 * Gateway. Tests speak these; only `lambda/api-handler.ts` knows the Lambda event.
 */
import type { ErrorResponse } from "@nightshift/contracts";
import type { Clock, NightshiftStores } from "@nightshift/core";
import type { z } from "zod";

export interface ApiRequest {
  readonly method: string;
  /** The path without a stage prefix, e.g. `/projects/proj_…`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON, or `undefined` when there was no body. */
  readonly body: unknown;
  /**
   * Claims the API Gateway JWT authorizer has already validated (A-19). Reading
   * them is not authentication; the gateway did that before this code ran.
   */
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** What the handler needs. It never learns which adapter backs `stores`. */
export interface ApiDeps {
  readonly stores: NightshiftStores;
  readonly clock: Clock;
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
