#!/usr/bin/env node
/**
 * `nightshift resume`'s landing, as a process (P8, D-P8-14).
 *
 *   nightshift-resume --project <id> --program <id> --run <id> --repo <path>
 *
 * The CLI runs preflight, then starts this and waits. A separate binary in this
 * package for the reason `nightshift-orchestrate` is one: an examiner is an
 * agent, and only this package's composition root may construct a harness
 * adapter.
 *
 * The last line on stdout is the `ResumeResult` as one JSON object, which is
 * what the CLI reads. Everything else goes to stderr. Exit 0 when the resume
 * ran, whatever it landed; 2 when it could not begin.
 */
import { parseArgs } from "node:util";
import { ProgramIdSchema, ProjectIdSchema, RunIdSchema } from "@nightshift/contracts";
import { createRuntime } from "../compose.js";
import { ResumeRefusal, runResume } from "../resume.js";

const say = (line: string): void => {
  process.stderr.write(`[nightshift-resume] ${line}\n`);
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      program: { type: "string" },
      run: { type: "string" },
      repo: { type: "string" },
    },
    strict: true,
  });
  if (values.repo === undefined) throw new ResumeRefusal("--repo is required");
  const scope = {
    projectId: ProjectIdSchema.parse(values.project),
    programId: ProgramIdSchema.parse(values.program),
    runId: RunIdSchema.parse(values.run),
  };
  const runtime = await createRuntime(process.env, "orchestrator");
  say(`run ${scope.runId}; control plane ${runtime.endpoint}`);
  const result = await runResume(runtime, { scope, repoPath: values.repo });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
};

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof ResumeRefusal ? 2 : 1);
  });
