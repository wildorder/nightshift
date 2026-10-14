import type { Dispatch, PublicationIntent } from "@nightshift/contracts";
import { createFixtures, makeDispatch } from "@nightshift/core";
import { describe, expect, it } from "vitest";
import {
  fullyPublished,
  SETTLE_DEADLINE_MS,
  settlePublication,
  unpublishedReason,
} from "./publication-settle.js";

const f = createFixtures();
const AT = "2026-10-14T05:00:00.000Z";
const sha = (n: number) => n.toString(16).padStart(40, "0");
const intent = (n: number, status: PublicationIntent["status"], detail?: string) =>
  ({
    head: sha(n),
    expectedPredecessor: sha(n - 1),
    bundleKey: `b/${n}`,
    status,
    requestedAt: new Date(Date.parse(AT) + n * 1000).toISOString(),
    ...(detail === undefined ? {} : { detail }),
  }) as PublicationIntent;
const withIntents = (intents: PublicationIntent[], blocked?: string): Dispatch => {
  const dispatch = makeDispatch(f, { status: "running" });
  return {
    ...dispatch,
    publication: {
      ...(blocked === undefined ? {} : { blocked }),
      intents,
      ...(intents.some((i) => i.status === "published")
        ? { head: intents.filter((i) => i.status === "published").at(-1)?.head }
        : {}),
    },
  } as Dispatch;
};

/** A clock the waits advance, so the deadline is reached without waiting. */
const fakeTime = () => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
};

describe("settling publication before a remote run ends (2026-10-14)", () => {
  it("asks for the branch head once more, then waits while the publisher works", async () => {
    const reads = [
      withIntents([intent(1, "published"), intent(2, "pending")]),
      withIntents([intent(1, "published"), intent(2, "pending")]),
      withIntents([intent(1, "published"), intent(2, "published")]),
    ];
    let republished = 0;
    const time = fakeTime();
    const state = await settlePublication({
      read: async () => reads.shift(),
      republishHead: async () => {
        republished += 1;
      },
      ...time,
    });
    expect(republished).toBe(1);
    expect(state?.kind).toBe("published");
    expect(fullyPublished(state)).toBe(true);
  });

  it("answers a block at once, and the reason names the cause and the way out", async () => {
    const blocked = withIntents(
      [intent(1, "published"), intent(2, "forbidden", "no workflows"), intent(3, "held")],
      "GitHub refused program/x: no workflows",
    );
    const state = await settlePublication({
      read: async () => blocked,
      republishHead: async () => undefined,
      ...fakeTime(),
    });
    expect(state?.kind).toBe("blocked");
    expect(fullyPublished(state)).toBe(false);
    const reason = unpublishedReason(state);
    expect(reason).toContain("2 landings could not be published");
    expect(reason).toContain("GitHub refused program/x: no workflows");
    expect(reason).toContain("nightshift resume");
  });

  it("gives up waiting at the deadline and says the work is not yet at GitHub", async () => {
    const time = fakeTime();
    const state = await settlePublication({
      read: async () => withIntents([intent(1, "pending")]),
      republishHead: async () => undefined,
      ...time,
    });
    expect(time.now()).toBeGreaterThanOrEqual(SETTLE_DEADLINE_MS);
    expect(state?.kind).toBe("pending");
    expect(fullyPublished(state)).toBe(false);
    expect(unpublishedReason(state)).toContain("does not yet have");
  });

  it("never takes an unreadable dispatch for a confirmation", async () => {
    const state = await settlePublication({
      read: async () => {
        throw new Error("503");
      },
      republishHead: async () => {
        throw new Error("no git");
      },
      ...fakeTime(),
    });
    expect(state).toBeUndefined();
    expect(fullyPublished(state)).toBe(false);
    expect(unpublishedReason(state)).toContain("could not be read");
  });

  it("counts a run that landed nothing as fully published", async () => {
    const state = await settlePublication({
      read: async () => withIntents([]),
      republishHead: async () => undefined,
      ...fakeTime(),
    });
    expect(state?.kind).toBe("none");
    expect(fullyPublished(state)).toBe(true);
  });
});
