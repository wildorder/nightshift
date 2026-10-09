/**
 * The gated, real-CLI conformance run (T8 deliverable 7).
 *
 * T1's shared suite lives in `@nightshift/test` as `describeHarnessConformance`,
 * and `@nightshift/test` is **not** a dependency of this package — adding one
 * would mean editing `package.json` and `tsconfig.json`, which T8 is not
 * authorised to do. So the halves are split at the natural seam: this module
 * exports everything the suite needs about *Claude Code* — the gate, and a
 * fixture that starts real workers — and the wiring
 *
 * ```ts
 * const gate = claudeConformanceGate();
 * if (gate.enabled) {
 *   describeHarnessConformance("claude", createClaudeHarness(), claudeConformanceFixture({…}));
 * } else {
 *   it.skip(`claude harness conformance — ${gate.reason}`, () => {});
 * }
 * ```
 *
 * belongs in `test/` where both imports are legal. `conformance.test.ts` in this
 * package asserts the gate itself, so a misconfigured gate fails offline rather
 * than being discovered the first time somebody runs `npm run slice`.
 *
 * **Nothing here runs without the environment variable.** The fixture builds
 * inputs; building them spawns nothing. The gate is the only thing that decides,
 * and a disabled gate carries the reason in prose so a skipped suite says why it
 * skipped rather than passing silently (D-P3-11: `npm test` must stay runnable
 * with no Claude Code sign-in, no credentials and no network).
 */
import type { ExecutionNode, RouteTarget } from "@nightshift/contracts";
import {
  createFixtures,
  makeAgent,
  makeJobContract,
  makeProgramContract,
  makeRootNode,
} from "@nightshift/core";
import type { Duration, HarnessStartInput, McpLaunch } from "@nightshift/harness";
import { millis, refusingWorkerTools } from "@nightshift/harness";

/** The variable that opts a machine in to driving the real CLI. */
export const CLAUDE_CONFORMANCE_ENV = "NIGHTSHIFT_SLICE_HARNESS";

/** The value it must hold. Matches the P3 contract §8. */
export const CLAUDE_CONFORMANCE_VALUE = "claude";

export interface ConformanceGate {
  readonly enabled: boolean;
  /** Why, in prose. Shown on a skipped suite so the skip is never silent. */
  readonly reason: string;
}

/**
 * Whether the real-CLI conformance run is enabled, and why not when it is not.
 *
 * Takes the environment as a parameter so a test can check both answers without
 * mutating the process.
 */
export const claudeConformanceGate = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConformanceGate => {
  const value = env[CLAUDE_CONFORMANCE_ENV];
  if (value === CLAUDE_CONFORMANCE_VALUE) {
    return {
      enabled: true,
      reason: `${CLAUDE_CONFORMANCE_ENV}=${CLAUDE_CONFORMANCE_VALUE}: driving the installed Claude Code CLI`,
    };
  }
  const seen = value === undefined ? "unset" : `set to ${JSON.stringify(value)}`;
  return {
    enabled: false,
    reason:
      `skipped: this suite drives the installed Claude Code CLI, which needs a Claude Code ` +
      `sign-in, a model and network access, none of which CI has. ` +
      `${CLAUDE_CONFORMANCE_ENV} is ${seen}; set ${CLAUDE_CONFORMANCE_ENV}=${CLAUDE_CONFORMANCE_VALUE} ` +
      `(as \`npm run slice\` does) to run it. It is skipped, not passed.`,
  };
};

/** Everything a start input needs except the sink, which T1's suite supplies. */
export type ConformanceStartInput = Omit<HarnessStartInput, "sink">;

/** The shape T1's `HarnessConformanceFixture` asks for, expressed without importing it. */
export interface ClaudeConformanceFixture {
  completing(): ConformanceStartInput;
  longRunning(): ConformanceStartInput;
  readonly cancelGrace: Duration;
  readonly completionTimeout: Duration;
}

export interface ClaudeConformanceFixtureOptions {
  /** An existing directory the worker may use as its worktree. */
  readonly worktree: string;
  /**
   * The worker's MCP server. Defaults to a process that exits immediately: the
   * CLI reports the server as failed and carries on, which is enough for a suite
   * that asserts start, exit, cancel and status and nothing about tools. Pass a
   * real `McpLaunch` when the caller has one.
   */
  readonly mcp?: McpLaunch;
  /** Defaults to Claude Code with an alias the CLI resolves itself. */
  readonly model?: RouteTarget;
  /** What the quick worker is asked to do. Must finish in seconds. */
  readonly completingObjective?: string;
  /** What the slow worker is asked to do. Must still be running when cancel arrives. */
  readonly longRunningObjective?: string;
  readonly cancelGrace?: Duration;
  readonly completionTimeout?: Duration;
}

/**
 * Inputs for the two workers T1's suite needs.
 *
 * Their program forbids committing and pushing, which their briefs say, and
 * their objectives ask for nothing but text: the suite's assertions are about
 * the adapter rather than about a model's behaviour.
 *
 * The long-running worker is a long *generation* rather than a `sleep`: a
 * `shell.exec` worker asked to sleep was observed backgrounding the command and
 * ending its turn at once, which (before sessions were kept open for their
 * background work) ended the run and made the cancel assertions vacuous. A long
 * essay keeps the process streaming for as long as the suite needs and requires
 * no permission at all.
 */
export const claudeConformanceFixture = (
  options: ClaudeConformanceFixtureOptions,
): ClaudeConformanceFixture => {
  const mcp: McpLaunch = options.mcp ?? {
    name: "nightshift",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: {},
  };
  const model: RouteTarget = options.model ?? {
    harness: "claude",
    provider: "anthropic",
    model: "sonnet",
  };

  const build = (objective: string): ConformanceStartInput => {
    const fixtures = createFixtures();
    const program = makeProgramContract(fixtures, {
      scope: { includes: ["**"], excludes: [], forbiddenActions: ["commit", "push"] },
    });
    const node: ExecutionNode = makeRootNode(fixtures);
    return {
      agent: makeAgent(fixtures, node.executionNodeId),
      node,
      job: makeJobContract(fixtures, { objective, acceptance: ["The worker started and ended."] }),
      program,
      worktree: options.worktree,
      model,
      mcp,
      // A local adapter reaches the worker operations through the MCP launch, and
      // these inputs describe no real job.
      tools: refusingWorkerTools("this fixture describes no real job"),
    };
  };

  return {
    completing: () =>
      build(
        options.completingObjective ??
          "Reply with the single word READY and stop. Do not call any tool.",
      ),
    longRunning: () =>
      build(
        options.longRunningObjective ??
          "Write a 20000 word essay on the history of the semicolon in programming " +
            "languages. Do not call any tool; write it out in full in your reply.",
      ),
    cancelGrace: options.cancelGrace ?? millis(5_000),
    completionTimeout: options.completionTimeout ?? millis(120_000),
  };
};
