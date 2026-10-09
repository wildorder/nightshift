/**
 * The gate on the real-CLI conformance run (T8 deliverable 7).
 *
 * This file never spawns `claude`. It asserts that the gate is closed by default
 * and says why, because the failure mode worth guarding against is a suite that
 * silently passes on a machine with no sign-in — which would make
 * `describeHarnessConformance` look green while proving nothing.
 *
 * The suite itself is wired in `test/`, where importing both `@nightshift/test`
 * and this package is legal; `conformance.ts` explains the split.
 */
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./adapter.js";
import {
  CLAUDE_CONFORMANCE_ENV,
  CLAUDE_CONFORMANCE_VALUE,
  claudeConformanceFixture,
  claudeConformanceGate,
} from "./conformance.js";

describe("the conformance gate", () => {
  it("is closed when the variable is unset, and says why", () => {
    const gate = claudeConformanceGate({});
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("skipped");
    expect(gate.reason).toContain("sign-in");
    expect(gate.reason).toContain(CLAUDE_CONFORMANCE_ENV);
    expect(gate.reason).toContain("It is skipped, not passed.");
  });

  it("is closed for another harness's value, and names the value it saw", () => {
    const gate = claudeConformanceGate({ [CLAUDE_CONFORMANCE_ENV]: "codex" });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('"codex"');
  });

  it("is open only for exactly this harness's value", () => {
    expect(
      claudeConformanceGate({ [CLAUDE_CONFORMANCE_ENV]: CLAUDE_CONFORMANCE_VALUE }).enabled,
    ).toBe(true);
    expect(claudeConformanceGate({ [CLAUDE_CONFORMANCE_ENV]: "Claude" }).enabled).toBe(false);
    expect(claudeConformanceGate({ [CLAUDE_CONFORMANCE_ENV]: "claude " }).enabled).toBe(false);
  });

  it("is closed in this process, which is how `npm test` stays credential-free", () => {
    // D-P3-11: `npm test` runs with no Claude Code sign-in and no network. If
    // this ever fails on CI, something set the opt-in variable there.
    expect(claudeConformanceGate().enabled).toBe(false);
  });
});

describe("the conformance fixture", () => {
  const fixture = claudeConformanceFixture({
    worktree: "/state/nightshift/worktrees/run_1/node_1",
  });

  it("builds inputs without spawning anything", () => {
    expect(fixture.completing().worktree).toBe("/state/nightshift/worktrees/run_1/node_1");
    expect(fixture.longRunning().worktree).toBe("/state/nightshift/worktrees/run_1/node_1");
  });

  it("tells both workers the program forbids committing and pushing, and limits no path", () => {
    for (const input of [fixture.completing(), fixture.longRunning()]) {
      expect(input.program.scope.forbiddenActions).toEqual(["commit", "push"]);
      expect(input.node).not.toHaveProperty("scope");
    }
  });

  it("gives each worker its own identity, as the execution layer would", () => {
    const first = fixture.completing();
    const second = fixture.completing();
    expect(first.agent.agentId).not.toBe(second.agent.agentId);
    expect(first.agent.executionNodeId).toBe(first.node.executionNodeId);
  });

  it("asks the two workers for genuinely different things", () => {
    expect(fixture.completing().job.objective).not.toBe(fixture.longRunning().job.objective);
  });

  it("bounds both waits, so a hung CLI fails the suite rather than the run", () => {
    expect(fixture.cancelGrace.ms).toBeGreaterThan(0);
    expect(fixture.completionTimeout.ms).toBeGreaterThan(fixture.cancelGrace.ms);
  });

  it("targets the adapter this package exports", () => {
    expect(fixture.completing().model.harness).toBe(createClaudeHarness().id);
  });
});
