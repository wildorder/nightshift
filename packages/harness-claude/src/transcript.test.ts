import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeTranscriptSource,
  currentClaudeTranscript,
  parseClaudeTranscript,
} from "./transcript.js";

/**
 * A planning session in Claude Code 2.1's transcript format, with one of each
 * kind of entry that is not the conversation: a slash-command echo, a skill's
 * body, an injected reminder, reasoning, a tool call and its output, a side
 * chain, a task notification, an interruption, a compaction summary, an
 * attachment.
 */
const PATH = "/x/.claude/projects/-repo/0f0e0d0c-1111-4222-8333-944455556666.jsonl";
const RECORDING = readFileSync(
  new URL("./__fixtures__/claude-planning-session.jsonl", import.meta.url),
  "utf8",
);

describe("parseClaudeTranscript (SC-P14-05)", () => {
  const session = parseClaudeTranscript(RECORDING, PATH);

  it("reads the human's messages and the assistant's text, and nothing else", () => {
    expect(session.harness).toBe("claude");
    expect(session.sessionId).toBe("0f0e0d0c-1111-4222-8333-944455556666");
    expect(session.messages.map(({ index, role, text }) => ({ index, role, text }))).toEqual([
      {
        index: 1,
        role: "human",
        text: "let's plan tenant billing. an admin must never see another company's invoices, not even by accident",
      },
      {
        index: 2,
        role: "assistant",
        text: [
          "I'll read the billing module first.",
          "Invoices are read with no tenant filter.",
          [
            "Where is the tenant enforced?",
            "- In the query layer: Every read filters by tenant.",
            "- In the API: Checked per route.",
          ].join("\n"),
        ].join("\n\n"),
      },
      { index: 3, role: "human", text: "In the query layer\n\nand support staff get no bypass" },
      { index: 4, role: "human", text: "unrelated: what's the weather" },
      { index: 5, role: "assistant", text: "I can't see the weather." },
    ]);
  });

  it("never carries a tool's output, reasoning or a side chain", () => {
    const all = session.messages.map((message) => message.text).join("\n");
    expect(all).not.toContain("TOOL-OUTPUT-MARKER");
    expect(all).not.toContain("secret reasoning");
    expect(all).not.toContain("sub-agent");
    expect(all).not.toContain("skill body");
    expect(all).not.toContain("injected");
  });

  it("keeps each message's time", () => {
    expect(session.messages[0]?.at).toBe("2026-09-30T14:00:03.000Z");
    expect(session.messages[1]?.at).toBe("2026-09-30T14:00:06.000Z");
  });

  it("recognises its own format and not a Codex rollout's", () => {
    expect(claudeTranscriptSource.recognises(RECORDING.split("\n")[0] ?? "")).toBe(true);
    expect(
      claudeTranscriptSource.recognises('{"timestamp":"t","type":"session_meta","payload":{}}'),
    ).toBe(false);
  });
});

describe("currentClaudeTranscript", () => {
  it("finds the session named by CLAUDE_CODE_SESSION_ID in whichever project holds it", async () => {
    const home = await mkdtemp(join(tmpdir(), "ns-claude-"));
    const dir = join(home, ".claude", "projects", "-some-repo");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "abc-123.jsonl"), RECORDING);
    const env = { CLAUDE_CODE_SESSION_ID: "abc-123" };
    expect(await currentClaudeTranscript({ env, cwd: "/elsewhere", home })).toBe(
      join(dir, "abc-123.jsonl"),
    );
    expect(await currentClaudeTranscript({ env: {}, cwd: "/", home })).toBeUndefined();
    expect(
      await currentClaudeTranscript({
        env: { CLAUDE_CODE_SESSION_ID: "../../etc" },
        cwd: "/",
        home,
      }),
    ).toBeUndefined();
    expect(
      await currentClaudeTranscript({
        env: { CLAUDE_CODE_SESSION_ID: "abc-123", CLAUDE_CONFIG_DIR: join(home, "none") },
        cwd: "/",
        home,
      }),
    ).toBeUndefined();
  });
});
