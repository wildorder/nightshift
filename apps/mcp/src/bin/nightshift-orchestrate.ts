#!/usr/bin/env node
/**
 * The headless root orchestrator, as a process (P7, D-P7-09).
 *
 *   nightshift-orchestrate --project <id> --program <id> --run <id> --repo <path>
 *                          [--harness <name>] [--model <name>]
 *
 * `nightshift run {id}` starts this and waits. It is a separate binary in this
 * package because only this package's composition root may construct a harness
 * adapter; the CLI is a thin client and stays one.
 *
 * The last line on stdout is one JSON object, which is what the CLI reads.
 * Everything else goes to stderr. The exit code is 0 when the root process ended
 * normally, whatever the run's outcome: the run's outcome is in the JSON, and in
 * the control plane.
 */
import { parseArgs } from "node:util";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import { createRuntime } from "../compose.js";
import { describeHeadlessEnding, HeadlessRefusal, runHeadless } from "../headless.js";

const say = (line: string): void => {
  process.stderr.write(`[nightshift-orchestrate] ${line}\n`);
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      program: { type: "string" },
      run: { type: "string" },
      repo: { type: "string" },
      harness: { type: "string" },
      model: { type: "string" },
    },
    strict: true,
  });
  if (values.repo === undefined) throw new HeadlessRefusal("--repo is required");
  const scope = {
    projectId: ProjectIdSchema.parse(values.project),
    programId: ProgramIdSchema.parse(values.program),
    runId: RunIdSchema.parse(values.run),
  };

  const runtime = await createRuntime(process.env, "orchestrator");
  say(`run ${scope.runId}; control plane ${runtime.endpoint}`);
  const result = await runHeadless(runtime, process.env, {
    scope,
    repoPath: values.repo,
    ...(values.harness === undefined ? {} : { harness: values.harness }),
    ...(values.model === undefined ? {} : { model: values.model }),
  });
  say(describeHeadlessEnding(result));
  process.stdout.write(
    `${JSON.stringify({
      runId: result.run.runId,
      runStatus: result.run.status,
      outcomeReason: result.run.outcomeReason ?? null,
      exit: result.exit.kind,
      agentId: result.agentId,
      transcript: result.transcript,
    })}\n`,
  );
  return result.exit.kind === "completed" ? 0 : 1;
};

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof HeadlessRefusal ? 2 : 1);
  });
