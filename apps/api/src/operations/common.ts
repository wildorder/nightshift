/**
 * Shared steps: referential checks, create-or-confirm semantics, and paging.
 */
import type { ProgramContract, Project, ProjectId, Run } from "@nightshift/contracts";
import type { NightshiftStores, Page, PageRequest, ProgramScope, RunScope } from "@nightshift/core";
import { type ApiResponse, HttpError, sameRecord } from "../http.js";

export const requireProject = async (
  stores: NightshiftStores,
  projectId: ProjectId,
): Promise<Project> => {
  const project = await stores.projects.get(projectId);
  if (project === undefined) {
    throw new HttpError(404, "not_found", `project ${projectId} does not exist`);
  }
  return project;
};

export const requireProgram = async (
  stores: NightshiftStores,
  scope: ProgramScope,
): Promise<ProgramContract> => {
  const program = await stores.programContracts.get(scope.projectId, scope.programId);
  if (program === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `program ${scope.programId} does not exist in project ${scope.projectId}`,
    );
  }
  return program;
};

export const requireRun = async (stores: NightshiftStores, scope: RunScope): Promise<Run> => {
  const run = await stores.runs.get(scope, scope.runId);
  if (run === undefined) {
    throw new HttpError(
      404,
      "not_found",
      `run ${scope.runId} does not exist in program ${scope.programId} of project ${scope.projectId}`,
    );
  }
  return run;
};

/**
 * Create semantics for a client-minted identifier: absent → store, 201; present
 * and identical → 200, so a retry is safe; present and different → 409.
 *
 * Read-then-write: two concurrent first writes of different bodies can both see
 * nothing and the later one wins. Acceptable while identifiers are client-minted
 * ULIDs that no two writers share.
 */
export const createOrConfirm = async <T>(
  existing: T | undefined,
  record: T,
  store: () => Promise<void>,
): Promise<ApiResponse> => {
  if (existing === undefined) {
    await store();
    return { status: 201, body: record };
  }
  if (sameRecord(existing, record)) return { status: 200, body: existing };
  throw new HttpError(409, "conflict", "a different record already exists under this identifier");
};

export const pageAt = (cursor: string | undefined): PageRequest =>
  cursor === undefined ? {} : { cursor };

/** Follows cursors to the end. For whole-run reads, not for responses to clients. */
export const readAll = async <T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};

/**
 * Runs a paged read, turning a rejected cursor into a 400. Adapters signal an
 * unusable cursor with `RangeError`; anything else is a real failure.
 */
export const withCursor = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new HttpError(400, "invalid_cursor", "the cursor is not valid for this listing");
    }
    throw error;
  }
};

/** A page as the API returns it: no `cursor` key at all on the last page. */
export const pageBody = <T>(page: Page<T>) =>
  page.cursor === undefined ? { items: page.items } : { items: page.items, cursor: page.cursor };
