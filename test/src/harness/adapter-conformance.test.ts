/**
 * The v1 conformance suite over the scripted harness, on both transports
 * (SC-P5-13, T1 deliverable 7).
 *
 * Before any real adapter is asked to pass the suite, the suite has to be shown
 * passable, offline and with no model. And the function transport, which no
 * local adapter uses, has to be shown working now rather than discovered broken
 * in P9: `functions` runs the same scripts over `HarnessStartInput.tools`.
 */
import { writeFile } from "node:fs/promises";
import { it } from "vitest";
import { describeAdapterConformance } from "../conformance/adapter.js";
import { createLocalContext, startOrchestrator } from "../slice/context.js";
import { TRANSPORT_ENV } from "./scripted.js";

for (const transport of ["mcp", "functions"] as const) {
  describeAdapterConformance(`the scripted harness over ${transport}`, {
    open: () => createLocalContext(),
    close: (context) => context.close(),
    orchestrate: (context, job) =>
      startOrchestrator({
        context,
        harness: "scripted",
        script: job.script,
        env: { [TRANSPORT_ENV]: transport },
      }),
    orchestratorModel: "claude-sonnet-5",
    expects: { usage: false, transcript: transport === "mcp" },
    cancelWithinMs: 15_000,
  });
}

/**
 * The same suite over a **real adapter**, against the local control plane, for
 * whoever is working on one (T3 deliverable 7). Opt-in and skipped by name: it
 * spends the operator's own login, so `npm test` and CI never run it. The exit
 * gate is `npm run conformance`, which is this against the deployed plane.
 */
const REAL_HARNESS_ENV = "NIGHTSHIFT_CONFORMANCE_HARNESS";
const real = process.env[REAL_HARNESS_ENV];

if (real === "claude" || real === "codex") {
  describeAdapterConformance(`${real}, against the local control plane`, {
    open: () =>
      createLocalContext({
        // A real worker takes real minutes; see `LocalContextOptions.realTime`.
        realTime: true,
        modelPolicy: {
          allowedProviders: ["anthropic", "openai"],
          allowedModels: ["claude-sonnet-5", "gpt-5.5"],
          forbiddenModels: [],
        },
      }),
    close: (context) => context.close(),
    orchestrate: (context, job) =>
      startOrchestrator({ context, harness: real, script: job.script }),
    orchestratorModel: "claude-fable-5-1",
    harnessId: real,
    pin: { harness: real },
    expects: { usage: true, transcript: true },
    cancelWithinMs: 30_000,
    firstProgressWithinMs: 180_000,
    jobTimeoutMs: 900_000,
    // For recording an adapter's stream fixture from a real run.
    onTranscript: async (text) => {
      const keep = process.env.NIGHTSHIFT_CONFORMANCE_KEEP;
      if (keep !== undefined && keep !== "") await writeFile(keep, text, "utf8");
    },
    report: (line) => process.stdout.write(`[conformance-${real}] ${line}\n`),
  });
} else {
  it.skip(`real-adapter conformance (claude, codex) — set ${REAL_HARNESS_ENV} to run one`, () => {});
}
