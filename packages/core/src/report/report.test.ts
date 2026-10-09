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
import { environmentFaultOf, renderEnvironmentFault } from "./environment-fault.js";
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
  graph: [],
  corrections: [],
  usage: [],
  rulings: [],
  gateHealth: { audit: undefined, red: undefined, repairs: [], flakes: [] },
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
      nodeIds: [],
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

describe("the report's stories (P14, SC-P14-09)", () => {
  it("leads with each story, the human's words, and its criteria met or not, before strands", () => {
    const text = renderReport(
      report({
        criteria: [
          { id: "SC-01", outcome: "Tenant billing data is isolated.", met: true, by: ["S-01"] },
          { id: "SC-02", outcome: "Existing customers remain compatible.", met: false, by: [] },
        ],
      }),
    );
    const storiesAt = text.indexOf("## Stories");
    expect(storiesAt).toBeGreaterThan(0);
    expect(storiesAt).toBeLessThan(text.indexOf("## Strands"));
    expect(text).toContain(
      "### US-01 They only ever see their own company's invoices, and a cross-tenant read is refused: done",
    );
    expect(text).toContain("- **Who:** A customer's billing admin");
    expect(text).toContain(
      `> "an admin must never see another company's invoices, not even by accident"`,
    );
    expect(text).toContain("Criteria: SC-01 met.");
    expect(text).toContain("Criteria: SC-02 NOT met.");
  });

  it("has no stories section for a program planned before stories", () => {
    const { stories: _stories, ...before } = program;
    expect(renderReport(report({ program: { ...before, strands: [] } }))).not.toContain(
      "## Stories",
    );
  });
});

describe("the report's gate health (P15, D-P15-09, SC-P15-09)", () => {
  const repairDecision = DecisionSchema.parse({
    ...(structuredClone(AGGREGATE_EXAMPLES.Decision) as Record<string, unknown>),
    context: "The build gate was red on the base commit.",
    choice: "point the build at tsconfig.build.json",
    rationale: "the base config pulled the tests into the build",
  }) as Decision;
  const departure = DecisionSchema.parse({
    ...(structuredClone(AGGREGATE_EXAMPLES.Decision) as Record<string, unknown>),
    context: "DEPARTURE: kept the old index",
    choice: "keep it",
    rationale: "the migration is not reversible",
  }) as Decision;
  const gateHealth: RunReport["gateHealth"] = {
    audit: {
      verdict: "repairing",
      commit: "0123456789abcdef0123456789abcdef01234567",
      auditedAt: "2026-10-06T09:00:00.000Z",
      findings: [{ id: "F-01", rule: 3, found: "Two gates write to dist/.", decisionId: "D-01" }],
    },
    red: { baseCommit: "fedcba9876543210fedcba9876543210fedcba98", failing: ["build"] },
    repairs: [
      {
        jobContractId: "job_repair",
        cause: "red_base",
        gates: ["build"],
        objective: "Make the build gate green",
        status: "integrated",
        decision: repairDecision,
        definitionsChanged: true,
        verification: [
          { id: "build", command: "npm run build -- -p tsconfig.build.json" },
          { id: "test", command: "npm test" },
        ],
      },
    ],
    flakes: [
      {
        stepId: "test",
        jobContractId: "job_flaky",
        executionNodeId: "node_flaky",
        commitSha: "aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa",
        verificationId: "ver_flaky",
        firstExitCode: 1,
      },
    ],
  };
  const strand = {
    id: "S-01",
    name: "The module",
    outcome: "succeeded" as const,
    acceptance: ["It works."],
    reason: undefined,
    blockedBy: [],
    departures: [departure],
    attempts: 1,
    waitingOn: [],
    nodeIds: [],
    jobs: [],
  };

  it("shows the audit, the red base, each repair with its decision and new definitions, and each flake", () => {
    const text = renderReport(report({ strands: [strand], gateHealth }));
    expect(text).toContain("Audit: **repairing** at `01234567`, 2026-10-06T09:00:00.000Z:");
    expect(text).toContain("- F-01 (rule 3): Two gates write to dist/. Decided by `D-01`.");
    expect(text).toContain("The base was red: build failed on `fedcba98`");
    expect(text).toContain("- **Repair `job_repair`** (red base) of build: integrated");
    expect(text).toContain(`Decision \`${repairDecision.decisionId}\`: point the build at`);
    expect(text).toContain("Why: the base config pulled the tests into the build");
    // F-01: the commands that landed, not only how many.
    expect(text).toContain("- `build`: `npm run build -- -p tsconfig.build.json`");
    expect(text).toContain("- `test`: `npm test`");
    expect(text).toContain(
      "- `test` on job `job_flaky` (node `node_flaky`) at `aaaaaaaa`: first run exited 1",
    );
  });

  it("puts departures first, then gate health, then the strands (F-02)", () => {
    const text = renderReport(report({ strands: [strand], gateHealth }));
    const departures = text.indexOf("## Departures from the plan");
    const gates = text.indexOf("## Gate health");
    const strands = text.indexOf("## Strands");
    expect(departures).toBeGreaterThan(0);
    expect(text.indexOf("kept the old index")).toBeLessThan(gates);
    expect(departures).toBeLessThan(gates);
    expect(gates).toBeLessThan(strands);
    // Repairs sit outside every strand: the strand count is the plan's alone.
    expect(text).toContain("1 of 1 strands succeeded");
  });

  it("says so in one line when there is nothing", () => {
    const text = renderReport(report());
    expect(text).toContain(
      "## Gate health\n\nNo gate-health record, no red base, no repairs and no flakes.\n\n## Strands",
    );
    expect(text).not.toContain("Repairs:");
    expect(text).not.toContain("Flakes");
  });

  it("names a missing record and an unchanged repair plainly", () => {
    const text = renderReport(
      report({
        gateHealth: {
          ...gateHealth,
          audit: undefined,
          red: undefined,
          flakes: [],
          repairs: [
            {
              ...(gateHealth.repairs[0] as RunReport["gateHealth"]["repairs"][number]),
              cause: "flaky",
              status: "running",
              decision: undefined,
              definitionsChanged: false,
            },
          ],
        },
      }),
    );
    expect(text).toContain("Audit: no gate-health record for this project.");
    expect(text).toContain("(flaky) of build: running");
    expect(text).toContain("Decision: not on the record.");
    expect(text).not.toContain("New gate definitions");
  });
});

describe("the report's environment fault (P16 S-02, D-07)", () => {
  const environmentFault: NonNullable<RunReport["gateHealth"]["environmentFault"]> = {
    baseCommit: "c".repeat(40) as never,
    referenceNode: "24.4.1",
    machineNode: "18.20.4",
    gates: [
      {
        id: "unit",
        command: "npm test",
        kind: "check",
        reference: "passed",
        machine: "failed",
        referenceTail: "Tests  12 passed (12)",
        machineTail: "TypeError: fetch is not a function\n Tests  1 failed | 11 passed (12)",
      },
      { id: "e2e", command: "npm run e2e", kind: "check", reference: "passed", machine: "failed" },
    ],
  };

  it("shows each gate, both verdicts, both tails and both Nodes side by side", () => {
    const text = renderReport(
      report({
        gateHealth: { audit: undefined, red: undefined, environmentFault, repairs: [], flakes: [] },
      }),
    );
    const section = text.slice(text.indexOf("## Gate health"), text.indexOf("## Strands"));
    expect(section).not.toContain("No gate-health record, no red base");
    expect(section).toContain(
      "Environment fault: 2 gates passed in the reference audit of `cccccccc`",
    );
    expect(section).toContain(
      "| Gate | Command | Reference (Node 24.4.1) | Machine (Node 18.20.4) |",
    );
    expect(section).toContain("| `unit` | `npm test` | passed | failed |");
    expect(section).toContain("| `e2e` | `npm run e2e` | passed | failed |");
    expect(section).toContain(
      "`unit`, the reference (Node 24.4.1), passed:\n\n```text\nTests  12 passed (12)\n```",
    );
    expect(section).toContain(
      "`unit`, the machine (Node 18.20.4), failed:\n\n```text\nTypeError: fetch is not a function\n Tests  1 failed | 11 passed (12)\n```",
    );
    expect(section).toContain("`e2e`, the machine (Node 18.20.4), failed:\n\n(no output was kept)");
  });

  it("gathers every part of a fault written as several events, each gate once", () => {
    const [unit, e2e] = environmentFault.gates;
    const part = (n: number, gates: unknown[]) => ({
      type: "environment.fault" as const,
      payload: { ...environmentFault, gates, part: n, parts: 2 },
    });
    const gathered = environmentFaultOf([
      part(2, [e2e]),
      { type: "gate.red" as const, payload: { baseCommit: "x", failing: [] } },
      part(1, [unit]),
    ]);
    expect(gathered).toEqual(environmentFault);
    expect(environmentFaultOf([])).toBeUndefined();
  });

  it("puts a fence around a tail no backtick in it can close", () => {
    const text = renderEnvironmentFault({
      ...environmentFault,
      gates: environmentFault.gates.slice(0, 1).map((gate) => ({
        ...gate,
        machineTail: "see ```code```",
      })),
    }).join("\n");
    expect(text).toContain("````text\nsee ```code```\n````");
  });
});
