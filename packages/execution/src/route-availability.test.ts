import { describe, expect, it } from "vitest";
import {
  createRouteAvailability,
  DEFAULT_LIMIT_COOLDOWN_MS,
  unavailableUntil,
} from "./route-availability.js";

const OPUS = { harness: "claude", model: "claude-opus-5-5" };
const ASTRA = { harness: "codex", model: "gpt-6-astra" };

const clockAt = (iso: string) => {
  let now = Date.parse(iso);
  return {
    now: () => now,
    set: (to: string) => {
      now = Date.parse(to);
    },
  };
};

describe("route availability (D-P8-06, as amended 2026-10-12)", () => {
  it("keeps a limited route out until its reset, then lets it back", () => {
    const clock = clockAt("2026-10-12T10:00:00.000Z");
    const routes = createRouteAvailability(clock);
    routes.markUnavailable(OPUS, "2026-10-12T12:00:00.000Z");
    expect(routes.unavailable()).toEqual([OPUS]);
    clock.set("2026-10-12T12:00:00.000Z");
    expect(routes.unavailable()).toEqual([]);
  });

  it("keeps a route that could not start for any other reason out for the run", () => {
    const clock = clockAt("2026-10-12T10:00:00.000Z");
    const routes = createRouteAvailability(clock);
    routes.markUnavailable(OPUS);
    routes.markUnavailable(OPUS, "2026-10-12T11:00:00.000Z");
    clock.set("2026-10-13T10:00:00.000Z");
    expect(routes.unavailable()).toEqual([OPUS]);
  });

  it("takes a route's latest limit once its earlier one has passed", () => {
    const clock = clockAt("2026-10-12T10:00:00.000Z");
    const routes = createRouteAvailability(clock);
    routes.markUnavailable(OPUS, "2026-10-12T11:00:00.000Z");
    clock.set("2026-10-12T11:30:00.000Z");
    routes.markUnavailable(OPUS, "2026-10-12T16:30:00.000Z");
    expect(routes.unavailable()).toEqual([OPUS]);
  });

  it("says when the first of some limited routes returns, and nothing when one is free or none will", () => {
    const routes = createRouteAvailability(clockAt("2026-10-12T10:00:00.000Z"));
    routes.markUnavailable(OPUS, "2026-10-12T14:00:00.000Z");
    routes.markUnavailable(ASTRA, "2026-10-12T12:00:00.000Z");
    expect(routes.earliestReturn([OPUS, ASTRA])).toBe("2026-10-12T12:00:00.000Z");
    expect(routes.earliestReturn([OPUS, { harness: "codex", model: "gpt-6-sol" }])).toBe(undefined);
    const forGood = createRouteAvailability(clockAt("2026-10-12T10:00:00.000Z"));
    forGood.markUnavailable(OPUS);
    expect(forGood.earliestReturn([OPUS])).toBeUndefined();
  });

  it("dates a limit by the provider's reset, a default cooldown without one, and the run otherwise", () => {
    const clock = clockAt("2026-10-12T10:00:00.000Z");
    expect(
      unavailableUntil(
        {
          kind: "failed",
          exitCode: 1,
          unavailable: "the provider answered 429 after work began: limit",
          availableAgainAt: "2026-10-12T15:00:00.000Z",
        },
        clock,
      ),
    ).toBe("2026-10-12T15:00:00.000Z");
    expect(
      unavailableUntil(
        {
          kind: "failed",
          exitCode: 1,
          unavailable: "the provider answered 429 before any work began: x",
        },
        clock,
      ),
    ).toBe(new Date(clock.now() + DEFAULT_LIMIT_COOLDOWN_MS).toISOString());
    expect(
      unavailableUntil(
        {
          kind: "failed",
          exitCode: 1,
          unavailable: "the provider answered 404 before any work began: x",
        },
        clock,
      ),
    ).toBeUndefined();
  });
});
