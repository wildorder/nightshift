import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { transcriptSources } from "./compose.js";
import { readTranscript, TranscriptNotFound } from "./transcript.js";

const fixture = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const CLAUDE = fixture(
  "../../../packages/harness-claude/src/__fixtures__/claude-planning-session.jsonl",
);
const CODEX = fixture(
  "../../../packages/harness-codex/src/__fixtures__/codex-planning-rollout.jsonl",
);
const base = { sources: transcriptSources(), env: {}, cwd: "/", home: "/nonexistent" };

describe("readTranscript (D-P14-07)", () => {
  it("tells a Claude Code transcript from a Codex rollout by its first line", async () => {
    expect((await readTranscript({ ...base, session: CLAUDE })).harness).toBe("claude");
    expect((await readTranscript({ ...base, session: CODEX })).harness).toBe("codex");
  });

  it("says how to name a transcript when the environment names no session", async () => {
    await expect(readTranscript(base)).rejects.toThrow(TranscriptNotFound);
    await expect(readTranscript(base)).rejects.toThrow(/--session <path>/);
    await expect(readTranscript({ ...base, session: "/no/such/file" })).rejects.toThrow(
      /cannot read/,
    );
  });
});
