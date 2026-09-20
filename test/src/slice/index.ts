/**
 * The slice suite's shared machinery, for a driver that lives outside `test`.
 *
 * The deployed slice (T9 deliverable 4) needs the AWS SDK — a machine token, S3
 * reads, and cleanup — and `test` may not import it (AR-4). So the *shape* of a
 * slice context lives here and the AWS-specific construction lives in
 * `apps/api/src/smoke/`, which is the one package allowed to reach AWS. Both
 * drive the same orchestrator, against the same fixture, with the same
 * assertions.
 */

export {
  type AdapterConformanceOptions,
  describeAdapterConformance,
} from "../conformance/adapter.js";
export {
  CANCELLED_JOB,
  COMPLETING_JOB,
  type ConformanceJob,
  FAILING_JOB,
} from "../conformance/fixture.js";
export { SCRIPT_NAMES, type ScriptName } from "../harness/scripted.js";
export {
  assertBuilt,
  configuredUrls,
  createLocalContext,
  HARNESS_ENV,
  killPid,
  type Orchestrator,
  type OrchestratorOptions,
  type SliceContext,
  type SliceHarness,
  type SliceTarget,
  type Structured,
  scriptedHarnessModule,
  serverBinary,
  sliceHarness,
  sliceTarget,
  startOrchestrator,
  TARGET_ENV,
  waitFor,
} from "./context.js";
export {
  authoredProgram,
  CONTRACT_FILE,
  fixturePath,
  type MaterialisedRepo,
  type MaterialiseOptions,
  materialiseFixtureRepo,
  PROGRAM_BRANCH,
} from "./fixture-repo.js";
