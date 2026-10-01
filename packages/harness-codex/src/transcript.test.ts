import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexTranscriptSource,
  currentCodexTranscript,
  parseCodexTranscript,
} from "./transcript.js";

/**
 * A planning session in codex-cli 0.159's rollout format: injected
 * instructions, environment and skill, a developer message, reasoning, a tool
 * call and its output, and `event_msg` lines that repeat messages.
 */
const TID = "01a0f407-20bd-7112-9990-0d70ab4e349a";
const RECORDING = readFileSync(
  new URL("./__fixtures__/codex-planning-rollout.jsonl", import.meta.url),
  "utf8",
);

describe("parseCodexTranscript (SC-P14-05)", () => {
  const session = parseCodexTranscript(RECORDING, `/x/rollout-2026-09-30T15-00-00-${TID}.jsonl`);

  it("reads the user's and the assistant's messages once each, and nothing injected", () => {
    expect(session.harness).toBe("codex");
    expect(session.sessionId).toBe(TID);
    expect(session.messages.map(({ index, role, text }) => ({ index, role, text }))).toEqual([
      {
        index: 1,
        role: "human",
        text: "$plan-program invoices: customers keep every invoice they already have",
      },
      { index: 2, role: "assistant", text: "Reading the invoice module." },
      { index: 3, role: "assistant", text: "Old invoices total with the old rounding. Keep it?" },
      { index: 4, role: "human", text: "yes, never change a total a customer has already seen" },
    ]);
    const all = session.messages.map((message) => message.text).join("\n");
    expect(all).not.toContain("TOOL-OUTPUT-MARKER");
    expect(all).not.toContain("AGENTS.md");
    expect(all).not.toContain("environment_context");
  });

  it("recognises its own format", () => {
    expect(codexTranscriptSource.recognises(RECORDING.split("\n")[0] ?? "")).toBe(true);
    expect(codexTranscriptSource.recognises('{"type":"user","message":{}}')).toBe(false);
  });
});

describe("currentCodexTranscript", () => {
  it("finds the rollout of the thread named by CODEX_THREAD_ID", async () => {
    const home = await mkdtemp(join(tmpdir(), "ns-codex-"));
    const dir = join(home, ".codex", "sessions", "2026", "09", "30");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-09-30T15-00-00-${TID}.jsonl`);
    await writeFile(file, RECORDING);
    expect(await currentCodexTranscript({ env: { CODEX_THREAD_ID: TID }, cwd: "/", home })).toBe(
      file,
    );
    expect(await currentCodexTranscript({ env: {}, cwd: "/", home })).toBeUndefined();
    expect(
      await currentCodexTranscript({ env: { CODEX_THREAD_ID: "nope" }, cwd: "/", home }),
    ).toBeUndefined();
  });
});
