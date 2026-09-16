/**
 * What a tool answers with.
 *
 * Every result carries both halves, and both are load-bearing:
 *
 * - **`structuredContent`**, so an orchestrator can act on identifiers without
 *   parsing prose, and so the identifiers a tool created are always returned
 *   (§4.5);
 * - **a one-paragraph text summary**, because the thing reading this is a
 *   language model, and a model that has to parse JSON to learn that its job
 *   failed will sometimes not.
 *
 * Refusals are the typed `code` plus a message, **never a stack trace**. A
 * refusal is a fact about the delegation, not an incident: `scope_widening`
 * tells an orchestrator to restate its request, `concurrency_limit_exceeded`
 * tells it to wait. A stack trace tells it nothing it can act on and fills its
 * context with this repository's file paths.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ConcurrencyLimitExceededError,
  DelegationRefusedError,
  DepthLimitExceededError,
  isDomainError,
  ScopeWideningError,
} from "@nightshift/core";
import { ZodError } from "zod";

/**
 * The refusal vocabulary of contract §4.5, plus the ones the surrounding
 * machinery needs. Stable strings: an orchestrator branches on them.
 */
export type RefusalCode =
  | "validation_failed"
  | "scope_widening"
  | "depth_limit_exceeded"
  | "concurrency_limit_exceeded"
  | "examination_unavailable"
  | "not_attached"
  | "already_attached"
  | "job_running"
  | "not_found"
  | "control_plane_error"
  | "internal_error";

export class ToolRefusal extends Error {
  override readonly name = "ToolRefusal";

  constructor(
    readonly code: RefusalCode,
    message: string,
    /** Anything the orchestrator needs to act on the refusal. */
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/**
 * The SDK's own result type, aliased rather than restated.
 *
 * Restating it would mean a shape that happens to match today and silently
 * stops matching on an SDK upgrade — and the mismatch would surface as a type
 * error in every tool at once rather than in one place.
 */
export type ToolResult = CallToolResult;

/** A successful result: the summary a model reads, and the data it acts on. */
export const ok = (
  summary: string,
  structuredContent: Record<string, unknown> = {},
): ToolResult => ({
  content: [{ type: "text", text: summary }],
  structuredContent: { ok: true, ...structuredContent },
});

/** A refusal, in the same two halves. */
export const refused = (refusal: ToolRefusal): ToolResult => ({
  content: [{ type: "text", text: `${refusal.code}: ${refusal.message}` }],
  structuredContent: { ok: false, code: refusal.code, message: refusal.message, ...refusal.detail },
  isError: true,
});

/**
 * Any failure, as a refusal an orchestrator can act on.
 *
 * Domain errors keep their own code, so `ScopeWideningError` raised three layers
 * down in `core` arrives at the orchestrator as `scope_widening` with the
 * reasons attached — the same answer whether the rule fired locally or across
 * the network (`persistence/http` reconstructs the class).
 */
export const asRefusal = (error: unknown): ToolRefusal => {
  if (error instanceof ToolRefusal) return error;

  if (error instanceof ZodError) {
    return new ToolRefusal("validation_failed", "the request is not a valid Job Contract", {
      issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  if (error instanceof ScopeWideningError) {
    return new ToolRefusal("scope_widening", error.message, { reasons: error.reasons });
  }
  if (error instanceof DepthLimitExceededError) {
    return new ToolRefusal("depth_limit_exceeded", error.message, {
      depth: error.depth,
      maxDepth: error.maxDepth,
    });
  }
  if (error instanceof ConcurrencyLimitExceededError) {
    return new ToolRefusal("concurrency_limit_exceeded", error.message, {
      running: error.running,
      maxConcurrency: error.maxConcurrency,
    });
  }
  if (error instanceof DelegationRefusedError) {
    return new ToolRefusal("validation_failed", error.message, { reason: error.reason });
  }
  if (isDomainError(error)) {
    return new ToolRefusal("control_plane_error", error.message, { domainCode: error.code });
  }
  if (typeof (error as { status?: unknown }).status === "number") {
    return new ToolRefusal(
      "control_plane_error",
      error instanceof Error ? error.message : String(error),
      { status: (error as { status: number }).status },
    );
  }
  // Nothing recognised. The message, and deliberately not the stack: a stack
  // trace fills an orchestrator's context with this repository's file paths and
  // tells it nothing it can act on.
  return new ToolRefusal("internal_error", error instanceof Error ? error.message : String(error));
};

/** Runs a tool body, turning any failure into a refusal result. */
export const guarded = async (body: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await body();
  } catch (error) {
    return refused(asRefusal(error));
  }
};
