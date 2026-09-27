/**
 * Where a job runs, for everything this app routes (P8, D-P8-04 … D-P8-07).
 *
 * One function, used by the root's `delegate` and `strand.delegate`, by the
 * engine for what a sub-program's orchestrator delegates, for a retry and for a
 * fallback, and by the headless root: the run's effective policy (what it
 * recorded when it started, `policyOfRun`), the program's `modelPolicy`, and
 * the job's own classification (`classificationOf`), handed to `ruleRoute`.
 */
import {
  defaultOrgConfig,
  type JobContract,
  type ProgramContract,
  type RouteChoice,
  type Run,
} from "@nightshift/contracts";
import { classificationOf, policyOfRun } from "@nightshift/core";
import type {
  ExaminationServices,
  RouteContext,
  WorkerLaunchIdentity,
} from "@nightshift/execution";
import type { McpLaunch } from "@nightshift/harness";
import { arbiterRoute, examinerRoute, ruleRoute } from "@nightshift/routing";

/** The seeded default a run that recorded no policy is read against (a run started before P8). */
const SEEDED = defaultOrgConfig(
  "org_00000000000000000000000000" as never,
  "1970-01-01T00:00:00.000Z",
);

export const routeJob = (
  run: Pick<Run, "policy">,
  program: ProgramContract,
  job: Pick<JobContract, "risk" | "ambiguity" | "testability" | "kind">,
  context: RouteContext = { unavailable: [] },
): RouteChoice => {
  const policy = policyOfRun(run, program, SEEDED);
  return ruleRoute({
    policy: policy.routingPolicy,
    policyVersion: policy.orgConfigVersion,
    modelPolicy: program.modelPolicy,
    classification: classificationOf(job),
    pins: context.pins,
    unavailable: context.unavailable,
    previous: context.previous,
  });
};

/** Who examines and who arbitrates, over the run's own ladders (D-P8-10, D-P8-13). */
export const examinationServices = (
  run: Pick<Run, "policy">,
  program: ProgramContract,
  mcp: (identity: WorkerLaunchIdentity) => McpLaunch,
): ExaminationServices => {
  const policy = policyOfRun(run, program, SEEDED);
  const base = {
    policy: policy.routingPolicy,
    policyVersion: policy.orgConfigVersion,
    modelPolicy: program.modelPolicy,
  };
  return {
    examinerRoute: (input) => examinerRoute({ ...base, ...input }),
    arbiterRoute: (input) => arbiterRoute({ ...base, ...input }),
    mcp,
  };
};
