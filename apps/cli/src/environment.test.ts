import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type PasteInput, pasteSourceFor } from "./environment.js";

const terminalLike = (): PassThrough & { isTTY: boolean } =>
  Object.assign(new PassThrough(), { isTTY: true });

describe("pasteSourceFor", () => {
  it("resolves with the pasted line, not with undefined, when a line arrives", async () => {
    const input = terminalLike();
    const paste = pasteSourceFor(input)();
    input.write("http://localhost:47821/callback?code=abc&state=xyz\n");
    await expect(paste.line).resolves.toBe("http://localhost:47821/callback?code=abc&state=xyz");
  });

  it("resolves undefined when the terminal closes without a line", async () => {
    const input = terminalLike();
    const paste = pasteSourceFor(input)();
    input.end();
    await expect(paste.line).resolves.toBeUndefined();
  });

  it("resolves undefined at once when stdin is not a terminal", async () => {
    const input: PasteInput = new PassThrough();
    const paste = pasteSourceFor(input)();
    await expect(paste.line).resolves.toBeUndefined();
  });

  it("cancel releases the input and settles the promise", async () => {
    const input = terminalLike();
    const paste = pasteSourceFor(input)();
    paste.cancel();
    await expect(paste.line).resolves.toBeUndefined();
    expect(input.isPaused()).toBe(true);
  });

  it("reads one line per source, so a retry reads the next line", async () => {
    const input = terminalLike();
    const source = pasteSourceFor(input);
    const first = source();
    input.write("first\n");
    await expect(first.line).resolves.toBe("first");
    const second = source();
    input.write("second\n");
    await expect(second.line).resolves.toBe("second");
  });
});
