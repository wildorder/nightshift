/**
 * The line owner's resolver and examiner agents (strand S-04), launched through
 * the harness without run-scoped records.
 *
 * A line dispatch has no run, so no `Agent`, node or contract is invented: the
 * identity is an ordinary `agent_<ULID>` minted here from the injected
 * generator and announced durably (`announce`, awaited) before the launch,
 * which never happens if the announcement throws. Routing is the run path's
 * (`roleRoute`, `examinerRoute`) over the policy the caller passes. The process
 * runs as the project user (`runAs`) with the environment handed in; nothing is
 * read from the engine's own.
 */
import type {
  AgentId,
  EffectivePolicy,
  ModelPolicy,
  RouteChoice,
  RouteTarget,
} from "@nightshift/contracts";
import type { Clock, IdGenerator } from "@nightshift/core";
import { systemClock } from "@nightshift/core";
import type { LineResolverAgentPort, LineWorktree } from "@nightshift/execution";
import {
  type Harness,
  type HarnessExit,
  type HarnessHandle,
  type HarnessLineStartInput,
  millis,
  type RunAs,
} from "@nightshift/harness";
import { compatiblePairs, examinerRoute, roleRoute } from "@nightshift/routing";

/** How long a line agent gets between the cooperative stop and the hard kill at its deadline. */
const DEADLINE_GRACE = millis(5_000);

/** The longest a timer can wait. A farther deadline is waited for in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export type LineAgentRole = HarnessLineStartInput["role"];

export interface LineAgentsOptions {
  /** The harnesses by `RouteTarget.harness`. A `Map<string, Harness>` fits. */
  readonly harnesses: { get(harness: string): Harness | undefined };
  /** The line view's or the contracts' defaults. */
  readonly policy: EffectivePolicy;
  readonly ids: IdGenerator;
  /** The project user's execution context, as workers get it. */
  readonly runAs?: RunAs | undefined;
  /** Project env and provider credentials, handed in whole. */
  readonly env: Readonly<Record<string, string>>;
  /** Durably records the agent before it launches. A throw prevents the launch. */
  readonly announce: (agent: {
    agentId: AgentId;
    role: LineAgentRole;
    model: string;
    /** The whole route the agent runs on, which the plane records. */
    target: RouteTarget;
  }) => Promise<void> | void;
  /** The worktree's own temp directory, when it has one. */
  readonly tmpDirOf?: (worktree: LineWorktree) => string | undefined;
  /** Narrows routing further; absent, every provider and model the policy lists may serve. */
  readonly modelPolicy?: ModelPolicy;
  readonly clock?: Clock;
}

type Launched =
  | { readonly kind: "exit"; readonly exit: HarnessExit }
  | { readonly kind: "deadline" }
  | { readonly kind: "not_launched"; readonly reason: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createLineAgents = (options: LineAgentsOptions): LineResolverAgentPort => {
  const clock = options.clock ?? systemClock;
  const modelPolicy: ModelPolicy = options.modelPolicy ?? {
    allowedProviders: [...new Set(compatiblePairs().map((pair) => pair.provider))],
    allowedModels: [],
    forbiddenModels: [],
  };
  const routing = {
    policy: options.policy.routingPolicy,
    policyVersion: options.policy.orgConfigVersion,
    modelPolicy,
  };

  /** Announces, launches, and waits for the exit or the deadline. */
  const launch = async (
    choice: RouteChoice,
    role: LineAgentRole,
    task: HarnessLineStartInput["task"],
    worktree: LineWorktree,
    deadline: string,
  ): Promise<Launched> => {
    const target: RouteTarget = choice.target;
    const harness = options.harnesses.get(target.harness);
    if (harness?.startLine === undefined) {
      return {
        kind: "not_launched",
        reason: `the ${target.harness} harness cannot launch a line agent`,
      };
    }
    const agentId = options.ids.next("agent");
    try {
      await options.announce({ agentId, role, model: target.model, target });
    } catch (error) {
      return {
        kind: "not_launched",
        reason: `the agent could not be announced: ${messageOf(error)}`,
      };
    }
    const tmpDir = options.tmpDirOf?.(worktree);
    let handle: HarnessHandle;
    try {
      handle = await harness.startLine({
        agentId,
        role,
        worktree: worktree.path,
        ...(tmpDir === undefined ? {} : { tmpDir }),
        model: target,
        ...(options.runAs === undefined ? {} : { runAs: options.runAs }),
        env: options.env,
        deadline,
        task,
      });
    } catch (error) {
      return { kind: "not_launched", reason: `the agent could not start: ${messageOf(error)}` };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer = false;
    const atDeadline = new Promise<"deadline">((resolve) => {
      const until = Date.parse(deadline);
      const arm = (): void => {
        const left = Number.isNaN(until) ? 0 : until - clock.now();
        if (left > 0 && !stopTimer) {
          timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
          timer.unref?.();
          return;
        }
        resolve("deadline");
      };
      arm();
    });
    try {
      const first = await Promise.race([handle.exit, atDeadline]);
      if (first !== "deadline") return { kind: "exit", exit: first };
      await harness.cancel(handle, DEADLINE_GRACE).catch(() => undefined);
      return { kind: "deadline" };
    } finally {
      stopTimer = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    resolve: async ({ brief, worktree, deadline }) => {
      let choice: RouteChoice;
      try {
        choice = roleRoute({
          ...routing,
          role: "implementer",
          classification: {
            risk: "medium",
            ambiguity: "medium",
            testability: "strong",
            kind: "fix",
          },
        });
      } catch (error) {
        return { model: "", status: "failed", summary: `no route: ${messageOf(error)}` };
      }
      const model = choice.target.model;
      const launched = await launch(
        choice,
        "line_resolver",
        { kind: "line_resolve", brief },
        worktree,
        deadline,
      );
      if (launched.kind === "not_launched") {
        return { model, status: "failed", summary: launched.reason };
      }
      if (launched.kind === "deadline") {
        return { model, status: "failed", summary: "the resolver reached its deadline" };
      }
      const exit = launched.exit;
      if (exit.kind === "completed") {
        return {
          model,
          status: "finished",
          ...(exit.result === undefined ? {} : { summary: exit.result }),
        };
      }
      return { model, status: "failed", summary: `the resolver ${describe(exit)}` };
    },

    examine: async ({ brief, worktree, avoidModel, deadline }) => {
      let choice: RouteChoice;
      try {
        choice = examinerRoute({
          ...routing,
          implementer: { harness: "", provider: "", model: avoidModel },
          mustDifferModel: true,
          mustDifferProvider: false,
        });
      } catch (error) {
        return rejected(
          "",
          `no model other than ${avoidModel} can examine now: ${messageOf(error)}`,
        );
      }
      const model = choice.target.model;
      const launched = await launch(
        choice,
        "line_examiner",
        { kind: "line_examine", brief },
        worktree,
        deadline,
      );
      if (launched.kind === "not_launched") return rejected(model, launched.reason);
      if (launched.kind === "deadline") {
        return rejected(model, "the examiner reached its deadline");
      }
      const exit = launched.exit;
      if (exit.kind !== "completed") return rejected(model, `the examiner ${describe(exit)}`);
      const verdict = parseVerdict(exit.result);
      return verdict === undefined
        ? rejected(model, "the examiner's final answer held no readable verdict")
        : { model, ...verdict };
    },
  };
};

const rejected = (model: string, finding: string) => ({
  model,
  verdict: "rejected" as const,
  findings: [finding],
});

const describe = (exit: HarnessExit): string => {
  switch (exit.kind) {
    case "completed":
      return "finished";
    case "failed":
      return `failed (exit ${exit.exitCode})`;
    case "interrupted":
      return `was killed by ${exit.signal}`;
    case "cancelled":
      return "was cancelled";
  }
};

const FENCE = /```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;

/**
 * The verdict of an examiner's final output: the last fenced block that holds
 * `{"verdict": "approved"|"rejected", "findings": string[]}`, or the output
 * itself when it is only that JSON. Anything else is no verdict.
 */
export const parseVerdict = (
  output: string | undefined,
): { verdict: "approved" | "rejected"; findings: string[] } | undefined => {
  if (output === undefined) return undefined;
  const candidates = [...output.matchAll(FENCE)].map((match) => match[1] ?? "").reverse();
  candidates.push(output);
  for (const candidate of candidates) {
    const parsed = readVerdict(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const readVerdict = (
  text: string,
): { verdict: "approved" | "rejected"; findings: string[] } | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { verdict, findings } = value as { verdict?: unknown; findings?: unknown };
  if (verdict !== "approved" && verdict !== "rejected") return undefined;
  if (!Array.isArray(findings) || !findings.every((item) => typeof item === "string")) {
    return undefined;
  }
  const list = findings as string[];
  return verdict === "rejected" && list.length === 0
    ? { verdict, findings: ["the examiner rejected the resolution without saying why"] }
    : { verdict, findings: list };
};
