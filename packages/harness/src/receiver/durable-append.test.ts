import { describe, expect, it } from "vitest";
import { durableAppend } from "./durable-append.js";

describe("durableAppend", () => {
  it("writes then fsyncs, and resolves only after the fsync", async () => {
    const events: string[] = [];
    let releaseFsync: () => void = () => {};
    const fs = {
      write: async (fd: number, text: string) => {
        events.push(`write:${fd}:${text}`);
      },
      fsync: (fd: number) =>
        new Promise<void>((resolve) => {
          events.push(`fsync:${fd}`);
          releaseFsync = () => {
            events.push("fsync-done");
            resolve();
          };
        }),
    };
    let resolved = false;
    const done = durableAppend(fs, 7, "x\n").then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["write:7:x\n", "fsync:7"]);
    expect(resolved).toBe(false);
    releaseFsync();
    await done;
    expect(resolved).toBe(true);
    expect(events).toEqual(["write:7:x\n", "fsync:7", "fsync-done"]);
  });

  it("does not fsync when the write fails", async () => {
    const fsync: number[] = [];
    await expect(
      durableAppend(
        {
          write: async () => {
            throw new Error("disk");
          },
          fsync: async (fd) => {
            fsync.push(fd);
          },
        },
        1,
        "x",
      ),
    ).rejects.toThrow("disk");
    expect(fsync).toEqual([]);
  });
});
