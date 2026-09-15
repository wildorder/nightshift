/**
 * Path and query parsing, and the ownership check that makes A-23 real.
 *
 * The ownership chain comes from the **path**. A body whose chain disagrees is
 * refused, because otherwise a caller could write into another project by lying in
 * the payload. The organisation is the exception: it never appears in a path or a
 * body, only in the token (D-P2-13).
 */
import { ID_SCHEMAS, type IdOf, type IdPrefix, type ProjectId } from "@nightshift/contracts";
import {
  OwnershipViolationError,
  type PageRequest,
  type ProgramScope,
  type ProjectScope,
  type RunScope,
} from "@nightshift/core";
import { HttpError } from "./http.js";

export type PathParams = Readonly<Record<string, string>>;

export const pathId = <P extends IdPrefix>(
  prefix: P,
  params: PathParams,
  name: string,
): IdOf<P> => {
  const result = ID_SCHEMAS[prefix].safeParse(params[name]);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_path",
      `path parameter ${name} is not a valid ${prefix}_ identifier`,
      result.error.issues,
    );
  }
  return result.data as IdOf<P>;
};

export const projectIdFrom = (params: PathParams): ProjectId => pathId("proj", params, "projectId");

export const programScopeFrom = (params: PathParams): ProgramScope => ({
  projectId: projectIdFrom(params),
  programId: pathId("prog", params, "programId"),
});

export const runScopeFrom = (params: PathParams): RunScope => ({
  ...programScopeFrom(params),
  runId: pathId("run", params, "runId"),
});

const CHAIN_FIELDS = ["projectId", "programId", "runId"] as const;

/** Throws `OwnershipViolationError` (403) unless the body sits in the path's chain. */
export const assertChainMatches = (
  path: ProjectScope | ProgramScope | RunScope,
  body: Partial<Record<(typeof CHAIN_FIELDS)[number], string>>,
): void => {
  const expected: Partial<Record<(typeof CHAIN_FIELDS)[number], string>> = path;
  for (const field of CHAIN_FIELDS) {
    const fromPath = expected[field];
    if (fromPath === undefined) continue;
    if (body[field] !== fromPath) {
      throw new OwnershipViolationError(field, fromPath, String(body[field]));
    }
  }
};

/** The record's own identifier must match the path. Not an ownership question, so 400. */
export const assertIdentifierMatches = (
  field: string,
  fromPath: string,
  fromBody: string,
): void => {
  if (fromPath !== fromBody) {
    throw new HttpError(
      400,
      "identifier_mismatch",
      `${field} in the body is ${fromBody}, but the path names ${fromPath}`,
    );
  }
};

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 1000;

const parseNonNegativeInt = (name: string, raw: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, "invalid_query", `${name} must be a non-negative integer`);
  }
  return Number.parseInt(raw, 10);
};

/** `limit` (1…1000, default 100) and an opaque `cursor`. */
export const parsePageQuery = (
  query: Readonly<Record<string, string | undefined>>,
): PageRequest => {
  const limit =
    query.limit === undefined ? DEFAULT_PAGE_LIMIT : parseNonNegativeInt("limit", query.limit);
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new HttpError(400, "invalid_query", `limit must be between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return query.cursor === undefined || query.cursor === ""
    ? { limit }
    : { limit, cursor: query.cursor };
};

export const parseAfterSequence = (
  query: Readonly<Record<string, string | undefined>>,
): number | undefined =>
  query.afterSequence === undefined
    ? undefined
    : parseNonNegativeInt("afterSequence", query.afterSequence);
