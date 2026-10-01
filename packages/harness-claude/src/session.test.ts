import { describe, expect, it } from "vitest";
import { createSessionCloser } from "./session.js";

/** A closer on a hand-cranked clock. */
const rig = () => {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  let closed = 0;
  const closer = createSessionCloser({
    close: () => {
      closed += 1;
    },
    graceMs: 10,
    maxBackgroundWaitMs: 1_000,
    setTimer: (run, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  return { closer, advance, closed: () => closed };
};

const idle = (backgroundTasks: number, finished = false) => ({
  idle: true,
  backgroundTasks,
  finished,
});
const running = { idle: false, backgroundTasks: 0, finished: false };

describe("when a streaming session is over", () => {
  it("is over once idle with nothing in the background, after the grace", () => {
    const r = rig();
    r.closer.onActivity(idle(0));
    r.advance(9);
    expect(r.closed()).toBe(0);
    r.advance(1);
    expect(r.closed()).toBe(1);
  });

  it("is not over when a turn starts inside the grace", () => {
    const r = rig();
    r.closer.onActivity(idle(0));
    r.advance(5);
    r.closer.onActivity(running);
    r.advance(100);
    expect(r.closed()).toBe(0);
  });

  it("waits to be woken while background work runs, but not forever", () => {
    const r = rig();
    r.closer.onActivity(idle(1));
    r.advance(999);
    expect(r.closed()).toBe(0);
    r.advance(1);
    expect(r.closed()).toBe(1);
  });

  it("starts the wait over once a woken turn has run", () => {
    const r = rig();
    r.closer.onActivity(idle(1));
    r.advance(900);
    r.closer.onActivity(running);
    r.closer.onActivity(idle(1));
    r.advance(900);
    expect(r.closed()).toBe(0);
  });

  it("is over after a finishing call, whatever is left running", () => {
    const r = rig();
    r.closer.onActivity(idle(2, true));
    r.advance(10);
    expect(r.closed()).toBe(1);
  });

  it("closes once, and never after it was disposed", () => {
    const r = rig();
    r.closer.onActivity(idle(0));
    r.advance(10);
    r.closer.onActivity(idle(0));
    r.advance(10);
    expect(r.closed()).toBe(1);
    const s = rig();
    s.closer.onActivity(idle(0));
    s.closer.dispose();
    s.advance(100);
    expect(s.closed()).toBe(0);
  });
});
