/**
 * Scope inheritance and authority narrowing (A-11, SC-P1-10).
 *
 * Children may narrow inherited authority. They may never widen it. This is the
 * one rule the whole delegation model rests on, so it is enforced structurally
 * here rather than asked for in a prompt.
 *
 * ## Glob containment semantics
 *
 * Deciding whether one arbitrary glob's language is a subset of another's is not
 * tractable in general, so containment here is **segment-wise and deliberately
 * conservative**:
 *
 * - a literal parent segment requires the same literal child segment;
 * - a parent `*` accepts any single child segment that is itself single-segment,
 *   which means a child `**` is never absorbed by a parent `*`;
 * - a trailing parent `**` absorbs every remaining child segment;
 * - a non-trailing parent `**` is matched against every possible split of the
 *   child's remaining segments.
 *
 * The consequence is that some genuinely-contained pairs are reported as not
 * contained. That direction is safe: the rule refuses a delegation rather than
 * granting authority it cannot prove was inherited. A caller that hits a false
 * refusal restates the child scope in terms the parent literally covers.
 */
import type { Scope, ScopeRequest } from "@nightshift/contracts";
import { ScopeWideningError } from "../errors.js";

const segments = (glob: string): readonly string[] => glob.split("/").filter((s) => s.length > 0);

/**
 * Whether every path matched by `child` is also matched by `parent`, under the
 * conservative semantics documented above.
 */
export const globContains = (parent: string, child: string): boolean =>
  containsFrom(segments(parent), 0, segments(child), 0);

const containsFrom = (
  parent: readonly string[],
  pi: number,
  child: readonly string[],
  ci: number,
): boolean => {
  if (pi >= parent.length) {
    // The parent pattern is exhausted; it only contains the child if the child is too.
    return ci >= child.length;
  }

  const head = parent[pi];

  if (head === "**") {
    if (pi === parent.length - 1) {
      // A trailing ** absorbs whatever remains, including nothing.
      return true;
    }
    // Try every split of the child's remaining segments against the rest of the parent.
    for (let skip = ci; skip <= child.length; skip += 1) {
      if (containsFrom(parent, pi + 1, child, skip)) return true;
    }
    return false;
  }

  if (ci >= child.length) {
    // Child is exhausted but the parent still demands a concrete segment.
    return false;
  }

  const childHead = child[ci];

  if (childHead === "**") {
    // A child ** spans multiple segments; only a parent ** can cover that.
    return false;
  }

  if (head === undefined || childHead === undefined) return false;
  if (!segmentContains(head, childHead)) return false;

  return containsFrom(parent, pi + 1, child, ci + 1);
};

/**
 * Whether every single segment matched by `child` is also matched by `parent`.
 *
 * When both sides carry wildcards this falls back to requiring them to be
 * identical. That is the conservative direction: `*.ts` genuinely contains
 * `a*.ts`, but proving so in general means comparing two regular languages, and
 * refusing a delegation is safer than granting unproven authority.
 */
const segmentContains = (parent: string, child: string): boolean => {
  if (parent === "*") return true;

  const parentHasWildcard = parent.includes("*") || parent.includes("?");
  const childHasWildcard = child.includes("*") || child.includes("?");

  if (!parentHasWildcard) return parent === child;
  if (!childHasWildcard) return singleSegmentMatches(parent, child);
  return parent === child;
};

/** Whether `child` is covered by at least one of the parent's include globs. */
const includeIsCovered = (parentIncludes: readonly string[], child: string): boolean =>
  parentIncludes.some((parent) => globContains(parent, child));

/** Includes the child claims that no parent include covers. */
const includeWidenings = (parent: Scope, request: ScopeRequest): readonly string[] =>
  request.includes
    .filter((include) => !includeIsCovered(parent.includes, include))
    .map(
      (include) =>
        `include "${include}" is not covered by the parent's includes [${parent.includes.join(", ")}]`,
    );

/** Parent excludes the child dropped. Dropping an exclude widens authority. */
const excludeWidenings = (parent: Scope, request: ScopeRequest): readonly string[] => {
  if (request.excludes === undefined) return [];
  const childExcludes = request.excludes;
  return parent.excludes
    .filter((exclude) => !childExcludes.includes(exclude))
    .map((exclude) => `exclude "${exclude}" is required by the parent but absent from the child`);
};

/** Permissions the child claims that the parent does not hold. */
const permissionWidenings = (parent: Scope, request: ScopeRequest): readonly string[] => {
  if (request.permissions === undefined) return [];
  return request.permissions
    .filter((permission) => !parent.permissions.includes(permission))
    .map((permission) => `permission "${permission}" is not held by the parent`);
};

/** Parent forbidden actions the child dropped. */
const forbiddenWidenings = (parent: Scope, request: ScopeRequest): readonly string[] => {
  if (request.forbiddenActions === undefined) return [];
  const childForbidden = request.forbiddenActions;
  return parent.forbiddenActions
    .filter((forbidden) => !childForbidden.includes(forbidden))
    .map(
      (forbidden) =>
        `forbidden action "${forbidden}" is required by the parent but absent from the child`,
    );
};

/**
 * Every way in which `request` would widen `parent`. Empty means the request is
 * a legal narrowing (or an exact inheritance).
 *
 * All four dimensions are reported together rather than short-circuiting, so a
 * caller can fix an entire delegation request in one pass.
 */
export const explainWidening = (parent: Scope, request: ScopeRequest): readonly string[] => [
  ...includeWidenings(parent, request),
  ...excludeWidenings(parent, request),
  ...permissionWidenings(parent, request),
  ...forbiddenWidenings(parent, request),
];

/** Whether `request` is a legal narrowing of `parent`. */
export const isNarrowing = (parent: Scope, request: ScopeRequest): boolean =>
  explainWidening(parent, request).length === 0;

/**
 * Resolves a child's effective scope from its parent's, throwing
 * {@link ScopeWideningError} when the request would widen authority.
 *
 * An omitted request field inherits the parent's value unchanged, which is
 * deliberately different from an empty array (narrow to nothing).
 */
export const narrow = (parent: Scope, request: ScopeRequest): Scope => {
  const reasons = explainWidening(parent, request);
  if (reasons.length > 0) throw new ScopeWideningError(reasons);

  return {
    includes: [...request.includes],
    excludes: [...(request.excludes ?? parent.excludes)],
    permissions: [...(request.permissions ?? parent.permissions)],
    forbiddenActions: [...(request.forbiddenActions ?? parent.forbiddenActions)],
  };
};

/** The scope a node inherits when it requests no narrowing at all. */
export const inheritScope = (parent: Scope): Scope => ({
  includes: [...parent.includes],
  excludes: [...parent.excludes],
  permissions: [...parent.permissions],
  forbiddenActions: [...parent.forbiddenActions],
});

/**
 * Whether `path` falls inside `scope`: covered by an include and not knocked out
 * by an exclude. Excludes always win, which is what makes an exclude authority
 * rather than a hint.
 */
export const scopeAllowsPath = (scope: Scope, path: string): boolean => {
  if (!scope.includes.some((glob) => globMatchesPath(glob, path))) return false;
  return !scope.excludes.some((glob) => globMatchesPath(glob, path));
};

/** Whether a concrete repository-relative path matches a glob. */
export const globMatchesPath = (glob: string, path: string): boolean =>
  matchFrom(segments(glob), 0, segments(path), 0);

const matchFrom = (
  glob: readonly string[],
  gi: number,
  path: readonly string[],
  pi: number,
): boolean => {
  if (gi >= glob.length) return pi >= path.length;

  const head = glob[gi];

  if (head === "**") {
    if (gi === glob.length - 1) return true;
    for (let skip = pi; skip <= path.length; skip += 1) {
      if (matchFrom(glob, gi + 1, path, skip)) return true;
    }
    return false;
  }

  if (pi >= path.length) return false;

  const segment = path[pi];
  if (segment === undefined || head === undefined) return false;
  if (!singleSegmentMatches(head, segment)) return false;

  return matchFrom(glob, gi + 1, path, pi + 1);
};

/** `*` matches any run of characters within one segment; `?` matches exactly one. */
export const singleSegmentMatches = (pattern: string, segment: string): boolean => {
  if (pattern === "*") return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === segment;

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = `^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`;
  return new RegExp(expression).test(segment);
};
