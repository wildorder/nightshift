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
 * Line dispatches: the same machine rules, with the line's own provisioning
 * (`provision-line.ts`), cap re-check on replacement and cleanup
 * (`line-cleanup.ts`). Lines with work and no live dispatch are admitted again,
 * which restores a start that was lost or a month that rolled over.
 */
import type { LineDispatch, LineRecord, ProjectId } from "@nightshift/contracts";
import { DispatchStatusSchema } from "@nightshift/contracts";
import {
  type EnsureLineDispatchDeps,
  ensureLineDispatch,
  hasPendingIntent,
  isDispatchTerminal,
  lineAdmission,
  lineQueueOwed,
} from "@nightshift/core";
import { cleanupStopped, enforceStop } from "./cleanup.js";
import { cleanupLineDispatch, type LineCleanupDeps } from "./line-cleanup.js";
import { failureCodeOf, lineCapUsd, recordLineWaiting } from "./line-support.js";
import { type ProvisionDeps, provisionDispatch } from "./provision.js";
import { launchLineDispatch, provisionLineDispatch } from "./provision-line.js";
import { recoverLease, recoverLostLease } from "./recover.js";

/** A `requested` dispatch older than this was not picked up by the API's invocation. */
export const REQUESTED_GRACE_MS = 2 * 60_000;

/** What the publisher is asked about: a run's intents, or the line's push. */
export type PublisherRequest =
  | { readonly projectId: string; readonly programId: string; readonly runId: string }
  | { readonly kind: "line"; readonly projectId: string; readonly branch: string };

export interface ReconcileDeps {
  readonly provision: ProvisionDeps;
  readonly ids: EnsureLineDispatchDeps["ids"];
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

/** Replaces a line dispatch whose lease lapsed, or ends it failed. */
const recoverLineDispatch = async (
  deps: ReconcileDeps,
  dispatch: LineDispatch,
  count: Counter,
): Promise<void> => {
  const { provision } = deps;
  const { stores, compute, clock } = provision;
  const line = { projectId: dispatch.projectId, branch: dispatch.branch };
  const { step, dispatch: after } = await recoverLease<LineDispatch>(
    {
      compute,
      clock,
      label: `${dispatch.projectId}/${dispatch.branch}`,
      save: async (next, original) => {
        let applied = false;
        await stores.lineDispatches.update(line.projectId, line.branch, (current) => {
          applied = current.version === original.version;
          return applied ? next : undefined;
        });
        return applied;
      },
    },
    dispatch,
    {
      // Spend may have reached the cap while the owner ran.
      refuseReplacement: async () => {
        const project = await stores.projects.get(line.projectId);
        if (project === undefined) return undefined;
        const admission = await lineAdmission(provision, {
          ...line,
          capUsd: await lineCapUsd(stores, line.projectId, line.branch),
          orgId: project.orgId,
        });
        if (admission.ok) return undefined;
        await recordLineWaiting(stores, clock, line, {
          reason: admission.reason,
          detail: admission.detail,
        });
        return {
          code: failureCodeOf(admission.reason) ?? "provisioning_failed",
          message: admission.detail,
        };
      },
    },
  );
  count(`line-lease:${step}`);
  if (step === "replacing") {
    const stored = (await stores.lineDispatches.get(line.projectId, line.branch)) ?? after;
    count(`line-provision:${(await launchLineDispatch(provision, stored)).kind}`);
  }
};

/** Line dispatches: provision, recover, stop and clean up, and restart what has work. */
export const reconcileLineDispatches = async (
  deps: ReconcileDeps,
  count: Counter,
): Promise<void> => {
  const { provision } = deps;
  const { stores, compute, clock } = provision;
  const cleanup: LineCleanupDeps = {
    stores,
    compute,
    clock,
    ids: deps.ids,
    startMachine: async (line) => {
      count(`line-provision:${(await provisionLineDispatch(provision, line)).kind}`);
    },
  };
  for (const dispatch of await stores.lineDispatches.listByStatus(ALL_STATUSES)) {
    const line = { projectId: dispatch.projectId, branch: dispatch.branch };
    try {
      if (dispatch.status === "requested") {
        // Past the grace, the invocation was lost; or the dispatch was put back
        // for the org's concurrency, which may have freed since.
        const record = await stores.lines.get(line.projectId, line.branch);
        if (
          clock.now() - Date.parse(dispatch.updatedAt) > REQUESTED_GRACE_MS ||
          record?.waiting?.reason === "org_concurrency"
        ) {
          count(`line-provision:${(await provisionLineDispatch(provision, line)).kind}`);
        }
      } else if (dispatch.status === "provisioning" && dispatch.instanceId === undefined) {
        count(`line-provision:${(await provisionLineDispatch(provision, line)).kind}`);
      } else if (!isDispatchTerminal(dispatch.status) && dispatch.status !== "stopping") {
        await recoverLineDispatch(deps, dispatch, count);
      } else {
        count(`line-cleanup:${await cleanupLineDispatch(cleanup, dispatch)}`);
      }
    } catch (error) {
      count("error");
      console.error(`reconciler: line ${line.projectId}/${line.branch}:`, error);
    }
  }
};

/** Lines with work: admitted again when no dispatch is live, and their pending pushes asked after. */
export const reconcileLinesWithWork = async (
  deps: ReconcileDeps,
  count: Counter,
): Promise<void> => {
  const { provision } = deps;
  const { stores, clock } = provision;
  const records: readonly LineRecord[] = await stores.lines.listWithWork();
  for (const record of records) {
    const line = { projectId: record.projectId as ProjectId, branch: record.branch };
    try {
      const dispatch = await stores.lineDispatches.get(line.projectId, line.branch);
      if (dispatch === undefined || isDispatchTerminal(dispatch.status)) {
        const result = await ensureLineDispatch(
          {
            stores,
            clock,
            ids: deps.ids,
            startMachine: async (target) => {
              count(`line-provision:${(await provisionLineDispatch(provision, target)).kind}`);
            },
          },
          { ...line, capUsd: await lineCapUsd(stores, line.projectId, line.branch) },
        );
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

export const reconcile = async (deps: ReconcileDeps): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  const count: Counter = (key) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  await reconcileRuns(deps, count);
  await reconcileLineDispatches(deps, count);
  await reconcileLinesWithWork(deps, count);
  return counts;
};
