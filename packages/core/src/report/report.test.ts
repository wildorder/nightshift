/**
 * The report's P8 sections, rendered from a built report (the gathering is the
 * planning suite's): arbiter rulings lead, each job shows its routes and its
 * examinations, and estimated cost is marked.
 */
import {
  AGGREGATE_EXAMPLES,
  type Decision,
  DecisionSchema,
  type Event,
  type Examination,
  ExaminationSchema,
  type ExecutionNode,
  type IsoTimestamp,
  type LifecycleObservation,
  type MeasurementSummary,
  type ProgramContract,
  ProgramContractSchema,
  type RoutingDecision,
  RoutingDecisionSchema,
  type Run,
  RunSchema,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import type { ProjectStores } from "../ports/stores.js";
import {
  createFixtures,
  makeAgent,
  makeDispatch,
  makeEvent,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeRootNode,
  makeRun,
} from "../testing/factories.js";
import { emptyMeasuredReport } from "../testing/report-defaults.js";
import { environmentFaultOf, renderEnvironmentFault } from "./environment-fault.js";
import { gatherReport, type RunReport, renderReport } from "./report.js";
import { DISPOSITION_NOTE } from "./review.js";

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
  gateHealth: {
    audit: undefined,
    red: undefined,
    repairs: [],
    flakes: [],
    verificationTime: { steps: [], landings: 0, verifications: 0, totalMs: 0, recommendations: [] },
  },
  stepAdjustments: { skipped: [], raised: [] },
  ...emptyMeasuredReport(run),
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
    verificationTime: {
      steps: [
        {
          id: "build",
          kind: "landing",
          runs: 12,
          totalMs: 12 * 41_000,
          quietMs: 0,
          byPhase: {
            queue: { runs: 10, totalMs: 10 * 41_000 },
            candidate: { runs: 2, totalMs: 2 * 41_000 },
            run: { runs: 0, totalMs: 0 },
          },
          forecastMs: 39_000,
        },
        {
          id: "e2e",
          kind: "landing",
          runs: 12,
          totalMs: 12 * 700_000,
          quietMs: 12 * 30_000,
          byPhase: {
            queue: { runs: 10, totalMs: 10 * 700_000 },
            candidate: { runs: 2, totalMs: 2 * 700_000 },
            run: { runs: 0, totalMs: 0 },
          },
        },
      ],
      landings: 10,
      verifications: 12,
      totalMs: 12 * 41_000 + 12 * 700_000,
      forecast: {
        machine: "darwin arm64",
        landings: 12,
        landingMs: 739_000,
        projectedMs: 8_868_000,
      },
      recommendations: [
        {
          rule: 9,
          title: "e2e at the end",
          stepId: "e2e",
          evidence: ["e2e resolves to package.json → scripts.test:e2e: `playwright test`"],
          formula: "11m 40s × 10 landings − 11m 40s × 2 runs at the end",
          savingMs: 700_000 * 8,
          fix: "declare it an end gate",
          edit: { stepId: "e2e", set: { at: "end" } },
        },
      ],
    },
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

  it("shows where the verification time went, the forecast beside it, and what would save time (P17)", () => {
    const text = renderReport(report({ strands: [strand], gateHealth }));
    expect(text).toContain("### Verification time");
    expect(text).toContain(
      "2h 28m across 12 verifications and 10 landings; the forecast assumed 12 landings at 12m 19s each, ≈ 2h 27m, measured on darwin arm64.",
    );
    expect(text).toContain("| `e2e` | 12 | 2h 20m | 11m 40s | 30.0s | 10 / 2 / 0 | — |");
    expect(text).toContain("| `build` | 12 | 8m 12s | 41.0s | 0.0s | 10 / 2 / 0 | 39.0s |");
    expect(text).toContain(
      "- **e2e at the end** (rule 9): saves ≈ 1h 33m — 11m 40s × 10 landings − 11m 40s × 2 runs at the end.",
    );
    expect(text).toContain('Edit the contract: on `e2e`, set `"at": "end"`.');
  });

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
        gateHealth: {
          audit: undefined,
          red: undefined,
          environmentFault,
          repairs: [],
          flakes: [],
          verificationTime: {
            steps: [],
            landings: 0,
            verifications: 0,
            totalMs: 0,
            recommendations: [],
          },
        },
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

describe("the report's publication (2026-10-14)", () => {
  const sha = (digit: string) => digit.repeat(40);
  const intent = (digit: string, status: string, detail?: string) => ({
    head: sha(digit),
    expectedPredecessor: sha("0"),
    bundleKey: `b/${digit}`,
    status,
    requestedAt: "2026-10-14T05:00:00.000Z",
    ...(detail === undefined ? {} : { detail }),
  });

  it("leads with NOT ON GITHUB when landings were refused, before rulings, with each one and the way out", () => {
    const text = renderReport(
      report({
        rulings: [{ ruling, nodeId: "node_x", finding: "F-01 a finding" }],
        publication: {
          branch: "program/edge",
          state: {
            kind: "blocked",
            head: sha("1") as never,
            tip: sha("3") as never,
            blocked: "GitHub refused program/edge: no workflows",
            unpublished: [
              intent("2", "forbidden", "GitHub refused program/edge: no workflows"),
              intent("3", "held", "waiting behind 222222222222"),
            ] as never,
          },
          unlanded: [],
        },
      }),
    );
    const publication = text.indexOf("## NOT ON GITHUB");
    expect(publication).toBeGreaterThan(0);
    expect(publication).toBeLessThan(text.indexOf("## Arbiter rulings"));
    expect(text).toContain("2 landings of this run are not on GitHub's `program/edge`.");
    expect(text).toContain("GitHub refused program/edge: no workflows");
    expect(text).toContain("`nightshift resume <program>` publishes them");
    expect(text).toContain("| `222222222222` | forbidden |");
    expect(text).toContain("| `333333333333` | held | behind the block above |");
  });

  it("says in one line that GitHub has every landing", () => {
    const text = renderReport(
      report({
        publication: {
          branch: "program/edge",
          state: { kind: "published", head: sha("3") as never, unpublished: [] },
          unlanded: [],
        },
      }),
    );
    expect(text).toContain("GitHub has every landing: `program/edge` is at `333333333333`.");
    expect(text).not.toContain("NOT ON GITHUB");
    expect(text).not.toContain("did not land");
  });

  it("says where the work of a strand that did not land is kept, and that the next run continues it (A-60)", () => {
    const text = renderReport(
      report({
        publication: {
          branch: "program/edge",
          state: { kind: "published", head: sha("3") as never, unpublished: [] },
          unlanded: [
            {
              branch: "nightshift/run_1/node_s01",
              head: sha("4") as never,
              bundleKey: "k",
              status: "published",
              requestedAt: "2026-10-18T00:00:00.000Z",
            },
          ],
        },
      }),
    );
    expect(text).toContain("## Work that did not land is kept at GitHub");
    expect(text).toContain("The next run of this plan continues each of these strands");
    expect(text).toContain("| `nightshift/run_1/node_s01` | `444444444444` | at GitHub |");
  });

  it("says nothing about GitHub for a local run", () => {
    expect(renderReport(report())).not.toContain("GitHub has");
  });
});

describe("the report's Not verified section (P19)", () => {
  const heading = "## Not verified — read this first";

  it("leads the report when a step was skipped, naming step, decision, commits and reason", () => {
    const text = renderReport(
      report({
        stepAdjustments: {
          skipped: [
            {
              stepId: "e2e",
              decisionId: "dec_skip",
              reason: "it hangs on the runner",
              commits: ["abcdef1234567890", "1234567890abcdef"],
              applied: true,
              inForce: true,
            },
          ],
          raised: [],
        },
      }),
    );
    expect(text).toContain(heading);
    expect(text).toContain(
      "- **e2e was not run**: skipped by decision dec_skip on abcdef123456, 1234567890ab, because it hangs on the runner",
    );
    expect(text.indexOf(heading)).toBeGreaterThan(text.indexOf("strands succeeded"));
    expect(text.indexOf(heading)).toBeLessThan(text.indexOf("## Strands"));
  });

  const skipOf = (extra: object) => ({
    stepId: "e2e",
    decisionId: "dec_skip",
    reason: "it hangs",
    commits: [],
    applied: false,
    inForce: true,
    ...extra,
  });
  const rendered = (skip: object) =>
    renderReport(report({ stepAdjustments: { skipped: [skipOf(skip) as never], raised: [] } }));

  it("lists a skip with its commits, even when it is no longer in force", () => {
    const text = rendered({ commits: ["bbbbbbbbbbbbbbbb"], applied: true, inForce: false });
    expect(text).toContain(
      "- **e2e was not run**: skipped by decision dec_skip on bbbbbbbbbbbb, because it hangs (no longer in force)",
    );
    expect(text).not.toContain("skip not applied");
  });

  it("lists a skip in force without the suffix", () => {
    const text = rendered({ commits: ["bbbbbbbbbbbbbbbb"], applied: true });
    expect(text).toContain("on bbbbbbbbbbbb, because it hangs\n");
  });

  it("lists a skip that was not applied", () => {
    const text = rendered({ notApplied: "e2e ran and failed with exit 1; fix it" });
    expect(text).toContain(
      "- **e2e skip not applied**: decision dec_skip; e2e ran and failed with exit 1; fix it",
    );
    expect(text).not.toContain("e2e was not run");
  });

  it("lists a skip no verification has met yet", () => {
    expect(rendered({})).toContain(
      "- **e2e is skipped**: by decision dec_skip, no verification has run since, because it hangs",
    );
  });

  it("is absent when there is nothing", () => {
    expect(renderReport(report())).not.toContain("Not verified");
  });
});

describe("the report's S-05 sections (P20)", () => {
  it("prints each section from the test builder, with the caveat, coverage tallies and 'not observed'", () => {
    const empty = report();
    const text = renderReport(
      report({
        delivery: {
          ...empty.delivery,
          firstAttempt: {
            ...empty.delivery.firstAttempt,
            succeeded: 1,
            denominator: 2,
            unfinished: 3,
            coverage: "partial",
            reasons: ["1 attempt(s) have no measurement"],
          },
        },
      }),
    );
    for (const heading of ["## Where the time went", "## Delivery", "## Review", "## Machine"]) {
      expect(text).toContain(heading);
    }
    expect(text.indexOf("## Usage")).toBeLessThan(text.indexOf("## Where the time went"));
    expect(text).toContain("Elapsed not observed");
    expect(text).toContain("all jobs: 1/2 (not observed), 3 unfinished; coverage partial");
    expect(text).toContain("1 attempt(s) have no measurement");
    expect(text).toContain("(complete coverage)");
    expect(text).toContain(DISPOSITION_NOTE);
    expect(text).toContain("Local machine expense is not reported");
    expect(text).toContain("input not observed");
  });

  it("fills operations, delivery, review and infrastructure from a small run", async () => {
    const f = createFixtures();
    const at = (ms: number): IsoTimestamp =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + ms).toISOString() as IsoTimestamp;
    const programRun = makeRun(f, { startedAt: at(0), endedAt: at(20_000), status: "succeeded" });
    const root = makeRootNode(f);
    const jobs = [makeJobContract(f), makeJobContract(f)];
    const nodes: ExecutionNode[] = [
      root,
      ...jobs.map((job) =>
        makeNode(f, f.rootNodeId, { jobContractId: job.jobContractId, status: "integrated" }),
      ),
    ];
    const jobNodes = nodes.slice(1);
    const events: Event[] = [];
    let n = 0;
    const span = (node: ExecutionNode, phase: string, from: number, to: number): void => {
      for (const [transition, when] of [
        ["start", from],
        ["end", to],
      ] as const) {
        n += 1;
        const observation = {
          schemaVersion: 1,
          ...f.scope,
          observationId: `obs-${n}`,
          executionNodeId: node.executionNodeId,
          source: "engine",
          provenance: { adapter: "engine" },
          occurredAt: at(when),
          receivedAt: at(when),
          inclusion: "self",
          kind: "lifecycle",
          operationId: `${phase}:${node.executionNodeId}`,
          phase,
          transition,
          blockers: [],
          ...(transition === "end" && phase === "integration" ? { reason: "integrated" } : {}),
        } as LifecycleObservation;
        events.push(
          makeEvent(f, {
            type: "lifecycle.observed",
            sequence: n,
            executionNodeId: node.executionNodeId,
            payload: observation as unknown as Record<string, unknown>,
            occurredAt: at(when),
            recordedAt: at(when),
          }),
        );
      }
    };
    const [a, b] = jobNodes as [ExecutionNode, ExecutionNode];
    span(a, "work", 0, 6000);
    span(a, "integration", 6000, 8000);
    span(b, "work", 2000, 10_000);
    span(b, "integration", 10_000, 12_000);
    // An examiner runs after the implementation: busy, not idle.
    span(b, "examination", 12_000, 15_000);

    const examination = ExaminationSchema.parse({
      ...(structuredClone(AGGREGATE_EXAMPLES.Examination) as Record<string, unknown>),
      ...f.scope,
      executionNodeId: a.executionNodeId,
      findings: [],
      outcome: "passed",
    }) as Examination;
    const summary = {
      measurementVersion: 1,
      ...f.scope,
      measurementSummaryId: "meas-1",
      executionNodeId: a.executionNodeId,
      agentId: "agent-1",
      role: "worker",
      routingDecisionId: null,
      route: { harness: "claude", provider: "anthropic", model: "m" },
      observedModels: [],
      segments: [],
      totals: { inputTokens: 100, outputTokens: 20 },
      coverage: "complete",
      gaps: [],
      ledger: { chunks: 0, artifactIds: [], observationCount: 0, publishedCount: 0 },
      valuation: { source: "unknown" },
      createdAt: at(0),
      updatedAt: at(0),
    } as unknown as MeasurementSummary;
    const dispatch = makeDispatch(f, {
      status: "stopped",
      requestedAt: at(0),
      attempts: [
        {
          generation: 1,
          reason: "dispatch",
          startedAt: at(0),
          readyAt: at(1000),
          endedAt: at(20_000),
          endReason: "stopped",
        },
      ],
    });
    const agent = makeAgent(f, a.executionNodeId, { startedAt: at(0), endedAt: at(6000) });

    const page = <T>(items: readonly T[]) => ({ items });
    const calls: string[] = [];
    const stub = (name: string, value: unknown) => (): Promise<unknown> => {
      calls.push(name);
      return Promise.resolve(value);
    };
    const stores = {
      programContracts: {
        get: stub("programContracts.get", makeProgramContract(f, { strands: [] })),
        listByProject: stub("programContracts.listByProject", page([])),
      },
      runs: { get: stub("runs.get", programRun) },
      executionNodes: { listByRun: stub("executionNodes.listByRun", page(nodes)) },
      jobContracts: { listByRun: stub("jobContracts.listByRun", page(jobs)) },
      decisions: { listByRun: stub("decisions.listByRun", page([])), get: stub("d", undefined) },
      events: { listByRun: stub("events.listByRun", page(events)) },
      measurements: { listByRun: stub("measurements.listByRun", page([summary])) },
      dispatches: { get: stub("dispatches.get", dispatch) },
      computeUtilizations: { get: stub("computeUtilizations.get", undefined) },
      agents: { listByNode: stub("agents.listByNode", [agent]) },
      routingDecisions: { listByNode: stub("routingDecisions.listByNode", []) },
      examinations: {
        listByNode: (_scope: unknown, nodeId: string) =>
          Promise.resolve(nodeId === a.executionNodeId ? [examination] : []),
      },
      verifications: { listByNode: stub("verifications.listByNode", []) },
      gateHealth: { get: stub("gateHealth.get", undefined) },
    } as unknown as ProjectStores;

    const gathered = await gatherReport(stores, f.scope);
    expect(calls.filter((c) => c === "events.listByRun")).toHaveLength(1);
    expect(calls.filter((c) => c === "dispatches.get")).toHaveLength(1);

    const { operations, delivery, review, infrastructure } = gathered;
    expect(gathered.asOf).toBe(at(20_000));
    expect(operations.elapsedMs).toBe(20_000);
    expect(operations.unions.work).toBe(10_000);
    expect(operations.unions.integration).toBe(4000);
    expect(operations.concurrency.peak).toBe(2);
    expect(operations.endings.integrated).toBe(2);
    expect(delivery.workItems).toBe(2);
    expect(delivery.firstAttempt.denominator).toBe(2);
    expect(delivery.outcomes.counts.landed).toBe(2);
    expect(review.coverage.examinedNodes).toBe(1);
    expect(review.coverage.examinations.total).toBe(1);
    expect(review.coverage.landedUnexamined).toBe(1);
    expect(infrastructure?.occupancy.peakConcurrentOccupants).toBe(2);
    expect(infrastructure?.occupancy.busyMs).toBe(15_000);

    const text = renderReport(gathered);
    expect(text).toContain("## Where the time went");
    expect(text).toContain("Peak concurrency 2");
    expect(text).toContain("## Machine");
    expect(text).not.toContain("Local machine expense is not reported");
  });
});
