/**
 * The report's P8 sections, rendered from a built report (the gathering is the
 * planning suite's): arbiter rulings lead, each job shows its routes and its
 * examinations, and estimated cost is marked.
 */
import {
  AGGREGATE_EXAMPLES,
  type Decision,
  DecisionSchema,
  type Examination,
  ExaminationSchema,
  type ProgramContract,
  ProgramContractSchema,
  type RoutingDecision,
  RoutingDecisionSchema,
  type Run,
  RunSchema,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { type RunReport, renderReport } from "./report.js";

const program = ProgramContractSchema.parse(
  structuredClone(AGGREGATE_EXAMPLES.ProgramContract) as Record<string, unknown>,
) as ProgramContract;
const run = RunSchema.parse({
  ...(structuredClone(AGGREGATE_EXAMPLES.Run) as Record<string, unknown>),
  status: "succeeded",
}) as Run;
const route = (patch: Partial<RoutingDecision>): RoutingDecision =>
  RoutingDecisionSchema.parse({
    ...(structuredClone(AGGREGATE_EXAMPLES.RoutingDecision) as Record<string, unknown>),
    ...patch,
  }) as RoutingDecision;
const ruling = DecisionSchema.parse({
  ...(structuredClone(AGGREGATE_EXAMPLES.Decision) as Record<string, unknown>),
  choice: "overturn",
  rationale: "the retry is bounded by its caller",
  authority: "agent",
}) as Decision;
const examination = ExaminationSchema.parse(
  structuredClone(AGGREGATE_EXAMPLES.Examination) as Record<string, unknown>,
) as Examination;

const report = (patch: Partial<RunReport> = {}): RunReport => ({
  program: { ...program, strands: [] },
  run,
  strands: [],
  criteria: [],
  pendingPrerequisites: [],
  decisions: [],
  humanDecisions: [],
  usage: [],
  rulings: [],
  ...patch,
});

describe("the report's routing and examination (P8)", () => {
  it("leads with the arbiter's rulings, and how to reverse one", () => {
    const text = renderReport(
      report({
        rulings: [{ ruling, nodeId: "node_x", finding: "F-01 the retry loop never ends" }],
      }),
    );
    const rulingsAt = text.indexOf("## Arbiter rulings");
    expect(rulingsAt).toBeGreaterThan(0);
    expect(rulingsAt).toBeLessThan(text.indexOf("## Strands"));
    expect(text).toContain("**Overturned** F-01 the retry loop never ends on node_x");
    expect(text).toContain("nightshift ruling reverse");
    expect(text).toContain("replays nothing");
  });

  it("names the arbiter's model, and counts how often one on a side's model sided with it (2026-09-26)", () => {
    const upheld = { ...ruling, choice: "uphold" };
    const text = renderReport(
      report({
        rulings: [
          {
            ruling: upheld,
            nodeId: "node_a",
            finding: "F-01 a",
            arbiterModel: "gpt-6-astra",
            sharesModelWith: "examiner",
          },
          {
            ruling,
            nodeId: "node_b",
            finding: "F-01 b",
            arbiterModel: "gpt-6-astra",
            sharesModelWith: "examiner",
          },
          { ruling, nodeId: "node_c", finding: "F-01 c", arbiterModel: "claude-opus-5-5" },
        ],
      }),
    );
    expect(text).toContain(
      "**Upheld** by gpt-6-astra, the examiner's model in a fresh context F-01 a",
    );
    expect(text).toContain("**Overturned** by claude-opus-5-5 F-01 c");
    expect(text).toContain("2 of these rulings came from an arbiter on one side's own model");
    expect(text).toContain("it sided with that side 1 of 2 time(s).");
  });

  it("shows every route a job ran on and every examination of it", () => {
    const strand = {
      id: "S-01",
      name: "The module",
      outcome: "succeeded" as const,
      acceptance: ["It works."],
      reason: undefined,
      blockedBy: [],
      departures: [],
      attempts: 1,
      waitingOn: [],
      jobs: [
        {
          nodeId: "node_j",
          objective: "Add the module",
          status: "integrated",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          attempts: 2,
          reason: undefined,
          routes: [
            route({
              attempt: 1,
              outcome: "unavailable",
              ladder: "claude",
              rung: { tier: "cheap", index: 0 },
            }),
            route({
              attempt: 2,
              outcome: "verified",
              ladder: "codex",
              rung: { tier: "cheap", index: 0 },
            }),
          ],
          examinations: [examination],
        },
      ],
    };
    const text = renderReport(report({ strands: [strand] }));
    expect(text).toContain("a fallback is `unavailable`");
    expect(text).toMatch(/1\. .* unavailable/);
    expect(text).toContain("Examined by gpt-6-sol");
    expect(text).toContain("Asked: Is the index meant to be irreversible?");
  });

  it("marks an estimated cost, and totals the run against its budget", () => {
    const text = renderReport(
      report({
        program: { ...program, strands: [], costPolicy: { maxUsd: 10 } },
        usage: [
          {
            harness: "codex",
            model: "gpt-6-sol",
            purpose: "work",
            attempts: 1,
            inputTokens: 100,
            outputTokens: 10,
            costUsd: 1.5,
            estimated: true,
            unpriced: 0,
          },
        ],
      }),
    );
    expect(text).toContain("| 1.50* |");
    expect(text).toContain("Budget: $1.50 (partly estimated) of $10.");
  });

  it("says a cost is unknown, never $0.00, when neither the harness nor the price table gave one", () => {
    const row = {
      harness: "codex",
      model: "gpt-6-astra",
      purpose: "examine",
      attempts: 2,
      inputTokens: 900_000,
      outputTokens: 3_000,
      costUsd: 0,
      estimated: false,
      unpriced: 2,
    };
    const text = renderReport(
      report({
        program: { ...program, strands: [], costPolicy: { maxUsd: 10 } },
        usage: [row, { ...row, purpose: "work", attempts: 3, costUsd: 1.25, unpriced: 1 }],
      }),
    );
    expect(text).toContain("| examine | 2 | 900000 | 3000 | unknown |");
    expect(text).toContain("| work | 3 | 900000 | 3000 | 1.25 + 1 unknown |");
    expect(text).not.toContain("| 0.00 |");
    expect(text).toContain("Budget: $1.25 (3 route(s) unpriced and not counted) of $10.");
  });
});
