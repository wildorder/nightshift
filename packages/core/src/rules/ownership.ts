/**
 * Project ownership (A-07, SC-P1-12).
 *
 * Every aggregate below `Project` carries `projectId` / `programId` / `runId`.
 * These assertions are how a job is prevented from moving between projects: not
 * by a database constraint that a later adapter might forget, but by a domain
 * rule every write path goes through.
 */
import type { ProgramId, ProjectId, RunId } from "@nightshift/contracts";
import { OwnershipViolationError } from "../errors.js";

export interface ProjectScope {
  readonly projectId: ProjectId;
}

export interface ProgramScope extends ProjectScope {
  readonly programId: ProgramId;
}

export interface RunScope extends ProgramScope {
  readonly runId: RunId;
}

/** Anything carrying at least a project identifier. */
export type ProjectScoped = ProjectScope;

/** Throws unless both records belong to the same project. */
export const assertSameProject = (expected: ProjectScoped, actual: ProjectScoped): void => {
  if (expected.projectId !== actual.projectId) {
    throw new OwnershipViolationError("projectId", expected.projectId, actual.projectId);
  }
};

/** Throws unless both records belong to the same project and program. */
export const assertSameProgram = (expected: ProgramScope, actual: ProgramScope): void => {
  assertSameProject(expected, actual);
  if (expected.programId !== actual.programId) {
    throw new OwnershipViolationError("programId", expected.programId, actual.programId);
  }
};

/** Throws unless both records belong to the same project, program and run. */
export const assertSameRun = (expected: RunScope, actual: RunScope): void => {
  assertSameProgram(expected, actual);
  if (expected.runId !== actual.runId) {
    throw new OwnershipViolationError("runId", expected.runId, actual.runId);
  }
};

/**
 * Throws unless `child` sits in exactly the same ownership chain as `parent`.
 *
 * A child never belongs to a different project, program or run than its parent.
 * Re-parenting across any of the three is not a supported operation; it is the
 * defect SC-P1-12 exists to catch.
 */
export const assertOwnershipChain = (parent: RunScope, child: RunScope): void => {
  assertSameRun(parent, child);
};

/** Non-throwing counterpart to {@link assertSameRun}. */
export const sameRun = (a: RunScope, b: RunScope): boolean =>
  a.projectId === b.projectId && a.programId === b.programId && a.runId === b.runId;

/** Non-throwing counterpart to {@link assertSameProject}. */
export const sameProject = (a: ProjectScoped, b: ProjectScoped): boolean =>
  a.projectId === b.projectId;

/** Narrows any run-scoped record to just its ownership chain. */
export const runScopeOf = (record: RunScope): RunScope => ({
  projectId: record.projectId,
  programId: record.programId,
  runId: record.runId,
});
