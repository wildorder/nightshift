/**
 * The reconciler's work (P10, D-P10-18, D-P10-15; Pipkin M1b), as functions over
 * ports so the offline suite drives them with fakes and the Lambda
 * (`lambda/runner-reconciler.ts`) only composes them.
 *
 * Run dispatches: a `requested` one the API's invocation never reached is
 * provisioned; a `stopping` one whose runner went quiet is terminated; a
 * `stopped` one has its volume snapshotted into the project's warm cache and
 * deleted; a live one whose lease lapsed is replaced on its volume; and any
 * dispatch that still holds a pending publication intent, or owes the line a
 * range, has the publisher asked again.
 *
 * A line's owner is a run of its line program, so its dispatch is walked with
 * the rest. Lines with work and no live run have one started again (`startLineRun`),
 * which restores a start that was lost or a month that rolled over.
 */
import type { LineRecord, ProgramContract, ProjectId } from "@nightshift/contracts";
import { DispatchStatusSchema } from "@nightshift/contracts";
import { hasPendingIntent, lineQueueOwed } from "@nightshift/core";
import type { ApiDeps } from "../http.js";
import { cleanupStopped, enforceStop } from "./cleanup.js";
import { followLineRun } from "./line-lifecycle.js";
import { startLineRun } from "./line-run.js";
import { type ProvisionDeps, provisionDispatch } from "./provision.js";
import { recoverLostLease } from "./recover.js";

/** A `requested` dispatch older than this was not picked up by the API's invocation. */
export const REQUESTED_GRACE_MS = 2 * 60_000;

/** What the publisher is asked about: a run's intents, or the line's push. */
export type PublisherRequest =
  | { readonly projectId: string; readonly programId: string; readonly runId: string }
  | { readonly kind: "line"; readonly projectId: string; readonly branch: string };

export interface ReconcileDeps {
  readonly provision: ProvisionDeps;
  /** The control plane's wiring, through which a line run is started as any dispatch is admitted. */
  readonly plane: ApiDeps;
  readonly askPublisher: (request: PublisherRequest) => Promise<void>;
}

const ALL_STATUSES = DispatchStatusSchema.options;

type Counter = (key: string) => void;

/** Run dispatches: provision, recover, stop and clean up; ask the publisher for what it owes. */
export const reconcileRuns = async (deps: ReconcileDeps, count: Counter): Promise<void> => {
  const { provision } = deps;
  const { stores, compute, clock, stage } = provision;
  const cleanup = { stores, compute, clock, stage };
  for (const dispatch of await stores.dispatches.listByStatus(ALL_STATUSES)) {
    const scope = {
      projectId: dispatch.projectId,
      programId: dispatch.programId,
      runId: dispatch.runId,
    };
    try {
      if (
        (dispatch.status === "requested" &&
          clock.now() - Date.parse(dispatch.updatedAt) > REQUESTED_GRACE_MS) ||
        (dispatch.status === "provisioning" && dispatch.instanceId === undefined)
      ) {
        count(`provision:${(await provisionDispatch(provision, scope)).kind}`);
      } else if (
        dispatch.status === "ready" ||
        dispatch.status === "running" ||
        (dispatch.status === "provisioning" && dispatch.instanceId !== undefined)
      ) {
        // T6: a live machine whose lease lapsed is replaced, on the same volume,
        // in the same tick when there is an attempt left.
        const step = await recoverLostLease(cleanup, dispatch);
        count(`lease:${step}`);
        if (step === "replacing") {
          count(`provision:${(await provisionDispatch(provision, scope)).kind}`);
        }
      } else if (dispatch.status === "stopping") {
        count(`stop:${await enforceStop(cleanup, dispatch)}`);
      } else if (dispatch.status === "stopped" || dispatch.status === "failed") {
        if (!dispatch.cleanup.volumeDeleted)
          count(`cleanup:${await cleanupStopped(cleanup, dispatch)}`);
        // A line run has no engine to end it: the plane ends it with its dispatch.
        await followLineRun(stores, clock, dispatch);
      }
      // A push that failed for a passing reason is retried, the last landing of
      // a run is never left waiting for a next one that will not come, and a
      // range the run owes the line is queued.
      if (hasPendingIntent(dispatch) || lineQueueOwed(dispatch)) {
        await deps.askPublisher(scope);
        count("publish:asked");
      }
    } catch (error) {
      count("error");
      console.error(`reconciler: ${dispatch.runId}:`, error);
    }
  }
};

/**
 * Lines with work: a run of the line program is started for each that has none
 * live, which restores a start that was lost or a month that rolled over, and
 * their pending pushes are asked after.
 */
export const reconcileLinesWithWork = async (
  deps: ReconcileDeps,
  count: Counter,
): Promise<void> => {
  const { stores } = deps.provision;
  const records: readonly LineRecord[] = await stores.lines.listWithWork();
  for (const record of records) {
    const line = { projectId: record.projectId as ProjectId, branch: record.branch };
    try {
      // The one-live-run guard answers `live` when the line already has a run.
      const naming = await namingProgramOf(stores, line);
      if (naming !== undefined) {
        const result = await startLineRun(deps.plane, { ...line, naming });
        count(`line-admit:${result.kind}`);
      }
      if (record.push?.status === "pending") {
        await deps.askPublisher({ kind: "line", ...line });
        count("publish:line-asked");
      }
    } catch (error) {
      count("error");
      console.error(`reconciler: line ${line.projectId}/${line.branch}:`, error);
    }
  }
};

/** A program of the project that names the line's branch: the line program is made from it. */
const namingProgramOf = async (
  stores: Pick<ProvisionDeps["stores"], "programContracts">,
  line: { readonly projectId: ProjectId; readonly branch: string },
): Promise<ProgramContract | undefined> => {
  let cursor: string | undefined;
  do {
    const page = await stores.programContracts.listByProject(
      line.projectId,
      cursor === undefined ? {} : { cursor },
    );
    const found = page.items.find(
      (contract) => contract.kind !== "line" && contract.line?.branch === line.branch,
    );
    if (found !== undefined) return found;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return undefined;
};

export const reconcile = async (deps: ReconcileDeps): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  const count: Counter = (key) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  await reconcileRuns(deps, count);
  await reconcileLinesWithWork(deps, count);
  return counts;
};
