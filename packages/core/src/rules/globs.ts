/**
 * Repository path globs, for planning (P7).
 *
 * A plan names where each strand's work is expected to lie, and `plan check`
 * asks two questions of those globs: does a strand's lie inside the program's,
 * and may two strands that run at once share a path. Nothing here confines a
 * job: since the owner's ruling of 2026-10-09 a job carries no path scope.
 *
 * ## Glob containment semantics
 *
 * Deciding whether one arbitrary glob's language is a subset of another's is not
 * tractable in general, so containment here is **segment-wise and deliberately
 * conservative**:
 *
 * - a literal outer segment requires the same literal inner segment;
 * - an outer `*` accepts any single inner segment that is itself single-segment,
 *   which means an inner `**` is never absorbed by an outer `*`;
 * - a trailing outer `**` absorbs every remaining inner segment;
 * - a non-trailing outer `**` is matched against every possible split of the
 *   inner glob's remaining segments.
 *
 * Some genuinely-contained pairs are therefore reported as not contained. A
 * planner who meets one restates the strand's globs in terms the program's
 * literally cover.
 */
const segments = (glob: string): readonly string[] => glob.split("/").filter((s) => s.length > 0);

/**
 * Whether every path matched by `inner` is also matched by `outer`, under the
 * conservative semantics documented above.
 */
export const globContains = (outer: string, inner: string): boolean =>
  containsFrom(segments(outer), 0, segments(inner), 0);

const containsFrom = (
  outer: readonly string[],
  pi: number,
  inner: readonly string[],
  ci: number,
): boolean => {
  if (pi >= outer.length) {
    // The outer pattern is exhausted; it only contains the inner if the inner is too.
    return ci >= inner.length;
  }

  const head = outer[pi];

  if (head === "**") {
    if (pi === outer.length - 1) {
      // A trailing ** absorbs whatever remains, including nothing.
      return true;
    }
    // Try every split of the inner's remaining segments against the rest of the outer.
    for (let skip = ci; skip <= inner.length; skip += 1) {
      if (containsFrom(outer, pi + 1, inner, skip)) return true;
    }
    return false;
  }

  if (ci >= inner.length) {
    // The inner is exhausted but the outer still demands a concrete segment.
    return false;
  }

  const innerHead = inner[ci];

  if (innerHead === "**") {
    // An inner ** spans multiple segments; only an outer ** can cover that.
    return false;
  }

  if (head === undefined || innerHead === undefined) return false;
  if (!segmentContains(head, innerHead)) return false;

  return containsFrom(outer, pi + 1, inner, ci + 1);
};

/**
 * Whether every single segment matched by `inner` is also matched by `outer`.
 *
 * When both sides carry wildcards this falls back to requiring them to be
 * identical. That is the conservative direction: `*.ts` genuinely contains
 * `a*.ts`, but proving so in general means comparing two regular languages, and
 * a planner restating a glob is cheaper than a check that guesses.
 */
const segmentContains = (outer: string, inner: string): boolean => {
  if (outer === "*") return true;

  const outerHasWildcard = outer.includes("*") || outer.includes("?");
  const innerHasWildcard = inner.includes("*") || inner.includes("?");

  if (!outerHasWildcard) return outer === inner;
  if (!innerHasWildcard) return singleSegmentMatches(outer, inner);
  return outer === inner;
};

/**
 * The globs in `inner` that no glob in `outer` contains. `plan check` asks it of
 * a strand's planned paths against the program's: empty means every one lies
 * inside.
 */
export const uncoveredGlobs = (
  outer: readonly string[],
  inner: readonly string[],
): readonly string[] =>
  inner.filter((glob) => !outer.some((candidate) => globContains(candidate, glob)));

/**
 * Whether `path` is matched by one of `globs.includes` and by none of
 * `globs.excludes`: an exclude always wins.
 */
export const globSetMatchesPath = (
  globs: { readonly includes: readonly string[]; readonly excludes: readonly string[] },
  path: string,
): boolean =>
  globs.includes.some((glob) => globMatchesPath(glob, path)) &&
  !globs.excludes.some((glob) => globMatchesPath(glob, path));

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
