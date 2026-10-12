/**
 * Which routes cannot serve in this run, and until when (P8, D-P8-06, as
 * amended 2026-10-12).
 *
 * A route that could not start because nobody is signed in, or because the
 * provider does not offer the model, stays out for the rest of the run: nothing
 * will change that while it runs. A route stopped by a usage or rate limit stays
 * out only until the limit resets, at the time the provider gave, or after
 * {@link DEFAULT_LIMIT_COOLDOWN_MS} when it gave none. Then the preferred route
 * is the first choice again.
 *
 * One record per run, shared by everything that routes in it: the engine's
 * fallbacks and retries, the root's first delegations, the examiner and the
 * arbiter. Kept in memory: a run that restarts learns again, by trying.
 */
import type { RouteTarget } from "@nightshift/contracts";
import type { Clock } from "@nightshift/core";
import type { HarnessExit } from "@nightshift/harness";

/** How long a limited route stays out when its provider did not say when it resets. */
export const DEFAULT_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

type RouteKey = Pick<RouteTarget, "harness" | "model">;

export interface UnavailableRoute extends RouteKey {
  /** When it may serve again (ISO 8601); absent for the rest of the run. */
  readonly until?: string;
}

export interface RouteAvailability {
  /** Records `route` as unable to serve, until `until` when given, else for the run. */
  markUnavailable(route: RouteKey, until?: string): void;
  /** The routes out of service now, for a router's `unavailable`. */
  unavailable(): readonly RouteKey[];
  /** When the earliest of `routes` that is out now comes back; `undefined` when one is in, or one never will. */
  earliestReturn(routes: readonly RouteKey[]): string | undefined;
}

const same = (a: RouteKey, b: RouteKey): boolean => a.harness === b.harness && a.model === b.model;

export const createRouteAvailability = (clock: Clock): RouteAvailability => {
  const entries: UnavailableRoute[] = [];
  const active = (entry: UnavailableRoute): boolean =>
    entry.until === undefined || Date.parse(entry.until) > clock.now();
  const current = (route: RouteKey): UnavailableRoute | undefined =>
    entries.find((entry) => same(entry, route) && active(entry));
  return {
    markUnavailable(route, until) {
      const index = entries.findIndex((entry) => same(entry, route));
      const entry: UnavailableRoute = {
        harness: route.harness,
        model: route.model,
        ...(until === undefined ? {} : { until }),
      };
      if (index < 0) {
        entries.push(entry);
        return;
      }
      const existing = entries[index];
      // A route out for the run stays out, whatever a later limit says.
      if (existing !== undefined && existing.until === undefined && active(existing)) return;
      entries[index] = entry;
    },
    unavailable() {
      return entries.filter(active).map(({ harness, model }) => ({ harness, model }));
    },
    earliestReturn(routes) {
      let earliest: number | undefined;
      for (const route of routes) {
        const entry = current(route);
        if (entry === undefined) return undefined;
        if (entry.until === undefined) continue;
        const at = Date.parse(entry.until);
        if (earliest === undefined || at < earliest) earliest = at;
      }
      return earliest === undefined ? undefined : new Date(earliest).toISOString();
    },
  };
};

/**
 * Until when a route that ended with `exit` is out: the provider's reset for a
 * usage limit, a default cooldown for a limit that gave none, and `undefined`
 * (the rest of the run) for any other route that could not start.
 */
export const unavailableUntil = (
  exit: Extract<HarnessExit, { kind: "failed" }>,
  clock: Clock,
): string | undefined => {
  if (exit.availableAgainAt !== undefined) return exit.availableAgainAt;
  if (exit.unavailable === undefined || !/\banswered 429\b/.test(exit.unavailable))
    return undefined;
  return new Date(clock.now() + DEFAULT_LIMIT_COOLDOWN_MS).toISOString();
};
