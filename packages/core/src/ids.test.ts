import { ID_PREFIXES, idPrefixOf } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createCountingIdGenerator, createUlidIdGenerator } from "./ids.js";
import { createFixedClock, createSeededRandom, createSteppingClock } from "./time.js";

describe("createUlidIdGenerator", () => {
  it("mints a valid identifier for every prefix", () => {
    const ids = createUlidIdGenerator(createFixedClock(1_700_000_000_000), createSeededRandom(1));
    for (const prefix of ID_PREFIXES) {
      expect(idPrefixOf(ids.next(prefix))).toBe(prefix);
    }
  });

  // D-P1-07 — injected clock and randomness make the sequence replayable.
  it("is deterministic for the same clock and seed", () => {
    const build = () =>
      createUlidIdGenerator(createFixedClock(1_700_000_000_000), createSeededRandom(42));
    const first = build();
    const second = build();
    const a = [first.next("node"), first.next("node"), first.next("job")];
    const b = [second.next("node"), second.next("node"), second.next("job")];
    expect(a).toEqual(b);
  });

  it("differs for a different seed", () => {
    const clock = () => createFixedClock(1_700_000_000_000);
    const a = createUlidIdGenerator(clock(), createSeededRandom(1)).next("node");
    const b = createUlidIdGenerator(clock(), createSeededRandom(2)).next("node");
    expect(a).not.toBe(b);
  });

  it("never repeats within one millisecond", () => {
    const ids = createUlidIdGenerator(createFixedClock(1_700_000_000_000), createSeededRandom(7));
    const minted = Array.from({ length: 500 }, () => ids.next("evt"));
    expect(new Set(minted).size).toBe(500);
  });

  it("sorts lexicographically in creation order", () => {
    const ids = createUlidIdGenerator(
      createSteppingClock(1_700_000_000_000),
      createSeededRandom(3),
    );
    const minted = Array.from({ length: 50 }, () => ids.next("evt"));
    expect([...minted].sort()).toEqual(minted);
  });
});

describe("createCountingIdGenerator", () => {
  it("mints readable, stable identifiers per prefix", () => {
    const ids = createCountingIdGenerator();
    expect(ids.next("node")).toBe("node_00000000000000000000000001");
    expect(ids.next("node")).toBe("node_00000000000000000000000002");
    // Counters are per prefix, so each aggregate reads from 1.
    expect(ids.next("job")).toBe("job_00000000000000000000000001");
  });

  it("stays within the Crockford alphabet past the first 32 values", () => {
    const ids = createCountingIdGenerator();
    for (let i = 0; i < 200; i += 1) {
      const id = ids.next("evt");
      expect(idPrefixOf(id), `${id} is not a valid evt identifier`).toBe("evt");
      expect(id).not.toMatch(/[ILOU]/);
    }
  });

  it("restarts from one for each new generator", () => {
    expect(createCountingIdGenerator().next("run")).toBe(createCountingIdGenerator().next("run"));
  });
});
