import { createFixtures } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  MAX_RENEWAL_INTERVAL_MS,
  renewalDelayMs,
  startTokenRenewal,
  type WorkerTokenFiles,
} from "./worker-tokens.js";

const f = createFixtures();
const agentId = f.ids.next("agent");
const T0 = Date.parse("2026-10-04T00:00:00.000Z");
const hours = (n: number) => n * 60 * 60_000;

/** A schedule under test control: due callbacks fire when told to. */
const fakeSchedule = () => {
  const due: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    due,
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false };
      due.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    /** Fires the next pending entry and waits for its work. */
    fire: async () => {
      const next = due.find((entry) => !entry.cancelled && !(entry as { fired?: boolean }).fired);
      if (next === undefined) throw new Error("nothing is due");
      (next as { fired?: boolean }).fired = true;
      next.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
};

describe("a worker's token, renewed before it expires (P10, T4)", () => {
  it("waits half the token's life, never more than four hours, never less than a second", () => {
    const at = (h: number) => new Date(T0 + hours(h)).toISOString();
    expect(renewalDelayMs(at(8), T0)).toBe(hours(4));
    expect(renewalDelayMs(at(2), T0)).toBe(hours(1));
    expect(renewalDelayMs(at(24), T0)).toBe(MAX_RENEWAL_INTERVAL_MS);
    expect(renewalDelayMs(at(-1), T0)).toBe(1_000);
    expect(renewalDelayMs("not a date", T0)).toBe(MAX_RENEWAL_INTERVAL_MS);
  });

  it("mints a new token at each due time, writes it over the old one, and stops when told", async () => {
    const placed: string[] = [];
    const files: WorkerTokenFiles = {
      place: async (_scope, _agentId, token) => {
        placed.push(token);
        return "/dev/shm/nightshift/run/agents/a/token";
      },
      remove: async () => undefined,
    };
    let minted = 0;
    const clock = fakeSchedule();
    const lines: string[] = [];
    const renewal = startTokenRenewal({
      scope: f.scope,
      agentId,
      minted: { token: "t0", expiresAt: new Date(T0 + hours(8)).toISOString() },
      tokens: {
        mint: async () => {
          minted += 1;
          return { token: `t${minted}`, expiresAt: new Date(T0 + hours(8 + minted)).toISOString() };
        },
      },
      files,
      now: () => T0,
      log: (line) => lines.push(line),
      schedule: clock.schedule,
    });
    expect(clock.due[0]?.ms).toBe(hours(4));
    await clock.fire();
    expect(placed).toEqual(["t1"]);
    expect(lines[0]).toContain("renewed the token");
    // The next due time follows from the new token's expiry (nine hours: half, capped at four).
    expect(clock.due[1]?.ms).toBe(hours(4));
    renewal.stop();
    expect(clock.due[1]?.cancelled).toBe(true);
  });

  it("logs a failed renewal and tries again in a minute; the old token still stands", async () => {
    const clock = fakeSchedule();
    const lines: string[] = [];
    let attempts = 0;
    startTokenRenewal({
      scope: f.scope,
      agentId,
      minted: { token: "t0", expiresAt: new Date(T0 + hours(8)).toISOString() },
      tokens: {
        mint: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("plane unreachable");
          return { token: "t1", expiresAt: new Date(T0 + hours(8)).toISOString() };
        },
      },
      files: { place: async () => "/p", remove: async () => undefined },
      now: () => T0,
      log: (line) => lines.push(line),
      schedule: clock.schedule,
    });
    await clock.fire();
    expect(lines[0]).toContain("could not renew");
    expect(clock.due[1]?.ms).toBe(60_000);
    await clock.fire();
    expect(lines[1]).toContain("renewed the token");
  });
});
