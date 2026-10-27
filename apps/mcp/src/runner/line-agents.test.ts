import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type EffectivePolicy,
} from "@nightshift/contracts";
import { createCountingIdGenerator } from "@nightshift/core";
import type {
  Harness,
  HarnessExit,
  HarnessHandle,
  HarnessLineStartInput,
} from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import { createLineAgents, parseVerdict } from "./line-agents.js";

const POLICY: EffectivePolicy = {
  routingPolicy: DEFAULT_ROUTING_POLICY,
  examinationPolicy: DEFAULT_EXAMINATION_POLICY,
  orgConfigVersion: 0,
};

const WORKTREE = { path: "/line/wt" };
const FAR = "2999-01-01T00:00:00.000Z";

/** A harness whose launches finish with the given exit, or never. */
const fakeHarness = (id: string, exits: (HarnessExit | "never")[] = []) => {
  const starts: HarnessLineStartInput[] = [];
  const cancelled: HarnessHandle[] = [];
  const harness: Harness = {
    id,
    capabilities: { usage: true },
    start: async () => {
      throw new Error("the run path is not used by the line");
    },
    startLine: async (input) => {
      starts.push(input);
      const next = exits.shift() ?? { kind: "completed" as const };
      const exit =
        next === "never" ? new Promise<HarnessExit>(() => {}) : Promise.resolve<HarnessExit>(next);
      return { agentId: input.agentId, exit };
    },
    cancel: async (handle) => {
      cancelled.push(handle);
    },
    status: async () => "started",
  };
  return { harness, starts, cancelled };
};

const registry = (...fakes: { harness: Harness }[]) =>
  new Map(fakes.map((fake) => [fake.harness.id, fake.harness]));

const setup = (
  options: {
    claude?: (HarnessExit | "never")[];
    codex?: (HarnessExit | "never")[];
    announce?: (agent: { agentId: string; role: string; model: string }) => Promise<void>;
    policy?: EffectivePolicy;
  } = {},
) => {
  const claude = fakeHarness("claude", options.claude);
  const codex = fakeHarness("codex", options.codex);
  const order: string[] = [];
  const announced: { agentId: string; role: string; model: string }[] = [];
  const agents = createLineAgents({
    harnesses: registry(claude, codex),
    policy: options.policy ?? POLICY,
    ids: createCountingIdGenerator(),
    runAs: { user: "proj", grant: async () => undefined },
    env: { PROJECT: "1" },
    announce: async (agent) => {
      order.push("announce");
      announced.push(agent);
      await options.announce?.(agent);
    },
  });
  for (const fake of [claude, codex]) {
    const start = fake.harness.startLine;
    fake.harness.startLine = async (input) => {
      order.push("launch");
      return (start as NonNullable<typeof start>)(input);
    };
  }
  return { agents, claude, codex, order, announced };
};

const examineInput = (avoidModel: string, deadline = FAR) => ({
  brief: "examine",
  worktree: WORKTREE,
  commit: "c" as never,
  base: "b" as never,
  verification: {} as never,
  avoidModel,
  deadline,
});

const verdictExit = (text: string): HarnessExit => ({ kind: "completed", result: text });

describe("resolve", () => {
  it("announces before launching, with an id from the generator, and returns model and finished", async () => {
    const { agents, claude, order, announced } = setup({
      claude: [{ kind: "completed", result: "merged a.ts by hand" }],
    });
    const result = await agents.resolve({ brief: "fix it", worktree: WORKTREE, deadline: FAR });
    expect(result).toEqual({
      model: "claude-sonnet-5",
      status: "finished",
      summary: "merged a.ts by hand",
    });
    expect(order).toEqual(["announce", "launch"]);
    expect(announced[0]).toMatchObject({ role: "line_resolver", model: "claude-sonnet-5" });
    const start = claude.starts[0];
    expect(start?.agentId).toBe(announced[0]?.agentId);
    expect(String(start?.agentId)).toMatch(/^agent_/);
    expect(start).toMatchObject({
      role: "line_resolver",
      worktree: "/line/wt",
      env: { PROJECT: "1" },
      task: { kind: "line_resolve", brief: "fix it" },
    });
    expect(start?.runAs?.user).toBe("proj");
  });

  it("reports failed when the agent fails", async () => {
    const { agents } = setup({ claude: [{ kind: "failed", exitCode: 1 }] });
    const result = await agents.resolve({ brief: "x", worktree: WORKTREE, deadline: FAR });
    expect(result).toMatchObject({ model: "claude-sonnet-5", status: "failed" });
  });

  it("does not launch when announce throws", async () => {
    const { agents, claude, order } = setup({
      announce: async () => {
        throw new Error("store down");
      },
    });
    const result = await agents.resolve({ brief: "x", worktree: WORKTREE, deadline: FAR });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("store down");
    expect(claude.starts).toHaveLength(0);
    expect(order).toEqual(["announce"]);
  });

  it("returns failed and cancels the agent at the deadline", async () => {
    const { agents, claude } = setup({ claude: ["never"] });
    const result = await agents.resolve({
      brief: "x",
      worktree: WORKTREE,
      deadline: new Date(Date.now() + 30).toISOString(),
    });
    expect(result.status).toBe("failed");
    expect(claude.cancelled).toHaveLength(1);
  });

  it("mints a fresh id for each launch", async () => {
    const { agents, announced } = setup();
    await agents.resolve({ brief: "x", worktree: WORKTREE, deadline: FAR });
    await agents.resolve({ brief: "x", worktree: WORKTREE, deadline: FAR });
    expect(announced[0]?.agentId).not.toBe(announced[1]?.agentId);
  });
});

describe("examine", () => {
  it("never runs avoidModel: the first other model on the examiner list", async () => {
    const { agents, codex, claude, announced } = setup({
      claude: [verdictExit('```json\n{"verdict":"approved","findings":[]}\n```')],
    });
    const result = await agents.examine(examineInput("gpt-6-astra"));
    expect(codex.starts).toHaveLength(0);
    expect(claude.starts[0]).toMatchObject({
      role: "line_examiner",
      task: { kind: "line_examine", brief: "examine" },
    });
    expect(announced[0]).toMatchObject({ role: "line_examiner", model: "claude-opus-5-5" });
    expect(result).toEqual({ model: "claude-opus-5-5", verdict: "approved", findings: [] });
  });

  it("takes the top of the list when it is not the model to avoid", async () => {
    const { agents } = setup({
      codex: [verdictExit('{"verdict":"rejected","findings":["drops b.ts"]}')],
    });
    const result = await agents.examine(examineInput("claude-sonnet-5"));
    expect(result).toEqual({ model: "gpt-6-astra", verdict: "rejected", findings: ["drops b.ts"] });
  });

  it("rejects, without launching, when no other model is routable", async () => {
    const only = {
      ...POLICY,
      routingPolicy: {
        ...DEFAULT_ROUTING_POLICY,
        roles: {
          ...DEFAULT_ROUTING_POLICY.roles,
          examiner: [{ harness: "codex", model: "gpt-6-astra" }],
        },
      },
    };
    const { agents, codex, claude } = setup({ policy: only });
    const result = await agents.examine(examineInput("gpt-6-astra"));
    expect(result.verdict).toBe("rejected");
    expect(result.findings[0]).toContain("no model other than gpt-6-astra");
    expect(codex.starts.length + claude.starts.length).toBe(0);
  });

  it("rejects garbage output, a failed agent, a deadline and a refused announce", async () => {
    const garbage = setup({ codex: [verdictExit("looks fine to me")] });
    expect((await garbage.agents.examine(examineInput("claude-sonnet-5"))).verdict).toBe(
      "rejected",
    );

    const failed = setup({ codex: [{ kind: "failed", exitCode: 2 }] });
    const failedResult = await failed.agents.examine(examineInput("claude-sonnet-5"));
    expect(failedResult.verdict).toBe("rejected");
    expect(failedResult.findings[0]).toContain("failed");

    const slow = setup({ codex: ["never"] });
    const late = await slow.agents.examine(
      examineInput("claude-sonnet-5", new Date(Date.now() + 30).toISOString()),
    );
    expect(late.verdict).toBe("rejected");

    const refused = setup({
      announce: async () => {
        throw new Error("no");
      },
    });
    const result = await refused.agents.examine(examineInput("claude-sonnet-5"));
    expect(result.verdict).toBe("rejected");
    expect(refused.codex.starts).toHaveLength(0);
  });
});

describe("parseVerdict", () => {
  it("reads the last fenced block", () => {
    const text =
      'first {"verdict":"approved","findings":[]}\n```json\n{"verdict":"rejected","findings":["a"]}\n```\nbye';
    expect(parseVerdict(text)).toEqual({ verdict: "rejected", findings: ["a"] });
  });
  it("reads bare JSON and refuses malformed shapes", () => {
    expect(parseVerdict('{"verdict":"approved","findings":[]}')).toEqual({
      verdict: "approved",
      findings: [],
    });
    expect(parseVerdict('{"verdict":"maybe","findings":[]}')).toBeUndefined();
    expect(parseVerdict('{"verdict":"approved","findings":[1]}')).toBeUndefined();
    expect(parseVerdict(undefined)).toBeUndefined();
  });
  it("gives a rejection with no findings one saying why", () => {
    expect(parseVerdict('{"verdict":"rejected","findings":[]}')?.findings).toHaveLength(1);
  });
});
