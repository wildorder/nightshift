import { describe, expect, it } from "vitest";
import {
  type ConversationSession,
  emptyConversation,
  humanSaid,
  keepMessages,
  maskCredentials,
  parseConversation,
  parseSelection,
  renderConversation,
} from "./conversation.js";

/**
 * Credential-shaped test values, joined at run time, so that no string shaped
 * like a real credential is ever in the source (push protection is right to
 * refuse one). None of them is, or was, a credential.
 */
const shaped = (...parts: string[]): string => parts.join("");
const AWS_KEY = shaped("AK", "IA", "ABCDEFGHIJKLMNOP");
const GITHUB_TOKEN = shaped("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789AB");

const session: ConversationSession = {
  harness: "claude",
  sessionId: "91be3293-fd2e-4518-866f-f0448fab471d",
  messages: [
    {
      index: 1,
      role: "human",
      text: "can we plan the billing thing?",
      at: "2026-09-30T14:00:05.000Z",
    },
    { index: 2, role: "assistant", text: "Yes. Who is it for?", at: "2026-09-30T14:00:09.000Z" },
    { index: 3, role: "human", text: "unrelated: what's for lunch" },
    { index: 4, role: "assistant", text: "No idea." },
    {
      index: 5,
      role: "human",
      text: "an admin must never see another company's invoices.\n\n## not a heading of ours",
    },
  ],
};

describe("parseSelection", () => {
  it("reads numbers and ranges, sorted and once each", () => {
    expect(parseSelection("5, 1-2,2", 5)).toEqual([1, 2, 5]);
  });

  it("refuses a number the session does not have, or nonsense", () => {
    expect(() => parseSelection("6", 5)).toThrow(/1 to 5/);
    expect(() => parseSelection("0-2", 5)).toThrow(/outside/);
    expect(() => parseSelection("a", 5)).toThrow(/not a message number/);
  });
});

describe("the conversation file (SC-P14-05)", () => {
  const kept = keepMessages(
    emptyConversation("p1-billing"),
    session,
    [1, 2, 5],
    "The owner wants isolation.",
  );

  it("keeps exactly the chosen messages, word for word, and says how many it left out", () => {
    const text = renderConversation(kept);
    expect(text).toContain("can we plan the billing thing?");
    expect(text).toContain("an admin must never see another company's invoices.");
    expect(text).not.toContain("lunch");
    expect(text).toContain("*Kept 3 of 5 messages; the rest led to nothing in the plan.*");
    expect(text).toContain("**Human** · 2026-09-30 14:00 UTC");
    expect(text).toContain("**Claude** · 2026-09-30 14:00 UTC");
    expect(text).toContain("## Summary\n\nThe owner wants isolation.");
  });

  it("reads back what it wrote", () => {
    expect(parseConversation("p1-billing", renderConversation(kept))).toEqual(kept);
  });

  it("extends a session already kept from, never duplicating, and keeps the human's cut", () => {
    const cut = renderConversation(kept).replace("can we plan the billing thing?", "can we plan?");
    const again = keepMessages(parseConversation("p1-billing", cut), session, [1, 3]);
    expect(again.sessions).toHaveLength(1);
    expect(again.sessions[0]?.kept.map((message) => message.index)).toEqual([1, 2, 3, 5]);
    expect(again.sessions[0]?.kept[0]?.text).toBe("can we plan?");
    expect(again.summary).toBe("The owner wants isolation.");
  });

  it("adds a second session after the first", () => {
    const second: ConversationSession = { ...session, harness: "codex", sessionId: "rollout-2" };
    const both = keepMessages(kept, second, [2]);
    expect(both.sessions.map((entry) => entry.sessionId)).toEqual([session.sessionId, "rollout-2"]);
    expect(renderConversation(both)).toContain("**Codex**");
  });

  it("still reads when the human removes a whole message with its marker", () => {
    const text = renderConversation(kept);
    const start = text.indexOf("<!-- nightshift:message 2 ");
    const end = text.indexOf("<!-- nightshift:message 5 ");
    const parsed = parseConversation("p1-billing", text.slice(0, start) + text.slice(end));
    expect(parsed.sessions[0]?.kept.map((message) => message.index)).toEqual([1, 5]);
  });

  it("masks anything shaped like a credential before it is kept", () => {
    const secret: ConversationSession = {
      ...session,
      messages: [
        {
          index: 1,
          role: "human",
          text: `use ${AWS_KEY} and ${GITHUB_TOKEN} please`,
        },
      ],
    };
    const text = renderConversation(keepMessages(emptyConversation("p"), secret, [1]));
    expect(text).not.toContain(AWS_KEY);
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).toContain("use [masked AWS access key] and [masked GitHub token] please");
  });
});

describe("maskCredentials", () => {
  it.each([
    [
      shaped("-----BEGIN RSA PRI", "VATE KEY-----\nMIIE\n-----END RSA PRI", "VATE KEY-----"),
      "private key",
    ],
    [
      shaped("aws_secret_", "access_key = ", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234"),
      "AWS secret key",
    ],
    [shaped("sk-", "ant-api03-", "abcdefghijklmnopqrstuvwxyz"), "Anthropic key"],
    [shaped("sk-", "proj-", "abcdefghijklmnopqrstuvwxyz"), "OpenAI key"],
    [shaped("sk_", "live_", "abcdefghijklmnop1234"), "Stripe key"],
    [shaped("xo", "xb-", "1234567890-abcdef"), "Slack token"],
    [
      shaped(
        "eyJhbGciOiJIUzI1NiJ9",
        ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
      "JWT",
    ],
  ])("masks %s", (text, kind) => {
    expect(maskCredentials(text)).toEqual({
      text: expect.stringContaining(`[masked ${kind}]`),
      masked: 1,
    });
  });

  it("leaves ordinary prose alone", () => {
    const prose = "the task-ask flow uses sk as a prefix and AKIA is an acronym";
    expect(maskCredentials(prose)).toEqual({ text: prose, masked: 0 });
  });
});

describe("humanSaid (D-P14-04)", () => {
  const kept = keepMessages(emptyConversation("p"), session, [1, 2, 5]);

  it("finds the human's words across whitespace and nothing the assistant said", () => {
    expect(humanSaid(kept, "an admin must   never see\nanother company's invoices")).toBe(true);
    expect(humanSaid(kept, "Who is it for?")).toBe(false);
    expect(humanSaid(kept, "an admin may see")).toBe(false);
    expect(humanSaid(kept, "   ")).toBe(false);
  });
});
