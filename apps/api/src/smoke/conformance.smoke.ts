/**
 * Harness conformance, for real (P5 T5, D-P5-03, SC-P5-17).
 *
 *   AWS_PROFILE=nightshift npm run conformance -- --harness claude|codex|all
 *
 * The same suite `npm test` runs over the scripted harness
 * (`describeAdapterConformance`, from `@nightshift/test/slice`), with two things
 * changed and nothing else: the control plane is the **deployed** one, and the
 * worker is a **real model** behind a real adapter. The three fixture Job
 * Contracts are byte for byte the ones the scripted harness follows.
 *
 * Which adapter runs is a routing pin on `delegate`, against a program whose
 * model policy allows both providers: harness choice is configuration
 * (SC-P5-16), and the `RoutingDecision` records the pin as an override.
 *
 * Never part of `npm test`, never in CI: it needs the operator's signed-in CLIs
 * and AWS. One adapter per process; two runs must not overlap.
 */
import type { ModelPolicy } from "@nightshift/contracts";
import { describeAdapterConformance, startOrchestrator } from "@nightshift/test/slice";
import { afterAll, it } from "vitest";
import { type DeployedSlice, openDeployedSlice } from "./deployed-slice.js";

export const CONFORMANCE_HARNESS_ENV = "NIGHTSHIFT_CONFORMANCE_HARNESS";

/** What each real adapter claims, and which model its workers run. */
const ADAPTERS = {
  claude: { model: "claude-sonnet-5", usage: true, transcript: true },
  codex: { model: "gpt-5.5", usage: true, transcript: true },
} as const;

const POLICY: ModelPolicy = {
  allowedProviders: ["anthropic", "openai"],
  allowedModels: [ADAPTERS.claude.model, ADAPTERS.codex.model],
  forbiddenModels: [],
};

const requested = process.env[CONFORMANCE_HARNESS_ENV];
const startedAt = Date.now();
/** One throwaway project per fixture job, so a failed job's litter is findable. */
const open: DeployedSlice[] = [];
const lines: string[] = [];

if (requested !== "claude" && requested !== "codex") {
  it.skip(`harness conformance — set ${CONFORMANCE_HARNESS_ENV} to claude or codex`, () => {});
} else {
  const adapter = ADAPTERS[requested];

  describeAdapterConformance(`${requested}, against the deployed control plane`, {
    open: async () => {
      const slice = await openDeployedSlice({
        label: `conformance-${requested}`,
        modelPolicy: POLICY,
      });
      open.push(slice);
      return slice.context;
    },
    close: async (context) => {
      const slice = open.find((candidate) => candidate.context === context);
      await slice?.cleanup();
    },
    orchestrate: (context, job) =>
      startOrchestrator({ context, harness: requested, script: job.script }),
    orchestratorModel: "claude-fable-5-1",
    harnessId: requested,
    pin: { harness: requested },
    expects: { usage: adapter.usage, transcript: adapter.transcript },
    // The adapter's grace is ten seconds; the rest is the deployed plane
    // catching up with a worker that has just been killed.
    cancelWithinMs: 45_000,
    firstProgressWithinMs: 180_000,
    jobTimeoutMs: 900_000,
    onRun: (scope) => open.at(-1)?.track(scope),
    report: (line) => {
      lines.push(line);
      process.stdout.write(`[conformance-${requested}] ${line}\n`);
    },
  });

  afterAll(() => {
    process.stdout.write(
      `\n[conformance-${requested}] summary\n${lines.map((line) => `  ${line}`).join("\n")}\n` +
        `[conformance-${requested}] total ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`,
    );
  });
}
