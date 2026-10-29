import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRunnerLog, createRunnerLog } from "./runner-log.js";

const fakeClock = () => {
  let now = 0;
  const waiting: { at: number; resolve: () => void }[] = [];
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waiting.push({ at: now + ms, resolve });
      }),
    advance: async (ms: number) => {
      now += ms;
      for (const w of waiting.filter((entry) => entry.at <= now)) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve();
      }
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
  };
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("runner log upload", () => {
  it("uploads every ten minutes and once more at the end", async () => {
    const clock = fakeClock();
    const recorded: string[] = [];
    const log = createRunnerLog({
      file: "runner.log",
      log: () => undefined,
      sleep: clock.sleep,
      read: async () => bytes("line\n"),
    });
    log.attach(async (b) => {
      recorded.push(new TextDecoder().decode(b));
    });
    log.start();
    await clock.advance(9 * 60_000);
    expect(recorded).toHaveLength(0);
    await clock.advance(60_000);
    expect(recorded).toHaveLength(1);
    await clock.advance(10 * 60_000);
    expect(recorded).toHaveLength(2);
    await log.finish();
    expect(recorded).toHaveLength(3);
    await clock.advance(10 * 60_000);
    expect(recorded).toHaveLength(3);
  });

  it("uploads nothing before a recorder is attached", async () => {
    const said: string[] = [];
    const log = createRunnerLog({
      file: "x",
      log: (l) => said.push(l),
      read: async () => bytes("a"),
    });
    await expect(log.finish()).resolves.toBeUndefined();
    expect(said).toEqual([]);
  });

  it("swallows a throwing recorder", async () => {
    const said: string[] = [];
    const log = createRunnerLog({
      file: "x",
      log: (l) => said.push(l),
      read: async () => bytes("a"),
    });
    log.attach(async () => {
      throw new Error("plane down");
    });
    await expect(log.finish()).resolves.toBeUndefined();
    expect(said.join()).toContain("plane down");
  });

  it("swallows a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runner-log-"));
    const said: string[] = [];
    let called = false;
    const log = createRunnerLog({ file: join(dir, "none.log"), log: (l) => said.push(l) });
    log.attach(async () => {
      called = true;
    });
    await expect(log.finish()).resolves.toBeUndefined();
    expect(called).toBe(false);
    expect(said).toHaveLength(1);
  });

  it("bounds the final upload by a timeout", async () => {
    const clock = fakeClock();
    const said: string[] = [];
    const log = createRunnerLog({
      file: "x",
      log: (l) => said.push(l),
      sleep: clock.sleep,
      read: async () => bytes("a"),
    });
    log.attach(() => new Promise<void>(() => undefined));
    const done = log.finish();
    await clock.advance(20_000);
    await done;
    expect(said.join()).toContain("timed out");
  });

  it("appends lines, creating the directory, and never throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runner-log-"));
    const file = join(dir, "deep", "runner.log");
    await appendRunnerLog(file, "one");
    await appendRunnerLog(file, "two");
    expect(await readFile(file, "utf8")).toBe("one\ntwo\n");
    await expect(appendRunnerLog(dir, "x")).resolves.toBeUndefined();
  });
});
