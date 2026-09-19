/**
 * The v1 conformance suite over the scripted harness, on both transports
 * (SC-P5-13, T1 deliverable 7).
 *
 * Before any real adapter is asked to pass the suite, the suite has to be shown
 * passable, offline and with no model. And the function transport, which no
 * local adapter uses, has to be shown working now rather than discovered broken
 * in P9: `functions` runs the same scripts over `HarnessStartInput.tools`.
 */
import { describeAdapterConformance } from "../conformance/adapter.js";
import { createLocalContext, startOrchestrator } from "../slice/context.js";
import { TRANSPORT_ENV } from "./scripted.js";

for (const transport of ["mcp", "functions"] as const) {
  describeAdapterConformance(`the scripted harness over ${transport}`, {
    open: createLocalContext,
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
