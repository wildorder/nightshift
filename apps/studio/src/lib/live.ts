/**
 * Following a live run (D-P11-05): poll the run's events after the last
 * sequence seen, and invalidate what each new event names. Stops when the run
 * settles. Events with `sequence: null` are not yet numbered and never advance
 * the cursor, so nothing is skipped: the cursor lags, as A-22 says it may.
 */
import type { Event, RunStatus } from "@nightshift/contracts";
import { isSequenced, orderEvents, type ProjectStores, type RunScope } from "@nightshift/core";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { readAll } from "./read-all.js";

export const LIVE_STATUSES: ReadonlySet<RunStatus> = new Set(["pending", "running"]);

/** What a new event says has changed, by query key prefix. */
export const keysNamedBy = (event: Event, runId: string): (readonly unknown[])[] => {
  const node = event.executionNodeId;
  const keys: (readonly unknown[])[] = [["report", runId]];
  if (event.type.startsWith("run.")) keys.push(["run", runId]);
  if (event.type.startsWith("node.") || event.type.startsWith("strand."))
    keys.push(["nodes", runId]);
  if (event.type === "node.delegated" || event.type === "node.queued") keys.push(["jobs", runId]);
  if (event.type.startsWith("agent.") && node !== null) keys.push(["agents", runId, node]);
  if (event.type.startsWith("verification.") && node !== null)
    keys.push(["verifications", runId, node]);
  if (event.type.startsWith("examination.") || event.type.startsWith("finding.")) {
    if (node !== null) keys.push(["examinations", runId, node]);
  }
  if (event.type === "routing.decided" && node !== null) keys.push(["routes", runId, node]);
  if (event.type.startsWith("decision.")) keys.push(["decisions", runId]);
  if (event.type === "checkpoint.created") keys.push(["checkpoints", runId]);
  if (event.type === "artifact.recorded") keys.push(["artifacts", runId]);
  if (event.type === "integration.conflict" || event.type === "node.integrated")
    keys.push(["nodes", runId]);
  return keys;
};

export interface LiveEvents {
  readonly events: readonly Event[];
  /** The highest sequence seen. */
  readonly cursor: number | undefined;
  readonly polling: boolean;
}

const invalidateAll = async (client: QueryClient, keys: (readonly unknown[])[]): Promise<void> => {
  const seen = new Set<string>();
  for (const key of keys) {
    const id = JSON.stringify(key);
    if (seen.has(id)) continue;
    seen.add(id);
    await client.invalidateQueries({ queryKey: key });
  }
};

/**
 * The run's events, complete on first read and then extended by polling while
 * `status` is live.
 */
export const useLiveEvents = (
  stores: ProjectStores,
  scope: RunScope,
  status: RunStatus | undefined,
  pollMs: number,
): LiveEvents => {
  const client = useQueryClient();
  const initial = useQuery({
    queryKey: ["events", scope.runId],
    queryFn: () => readAll((page) => stores.events.listByRun(scope, page)),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [extra, setExtra] = useState<readonly Event[]>([]);
  const cursorRef = useRef<number | undefined>(undefined);
  const seenIds = useRef(new Set<string>());

  const initialEvents = initial.data;
  useEffect(() => {
    if (initialEvents === undefined) return;
    for (const event of initialEvents) {
      seenIds.current.add(event.eventId);
      if (isSequenced(event)) {
        cursorRef.current = Math.max(cursorRef.current ?? -1, event.sequence);
      }
    }
  }, [initialEvents]);

  const polling = status !== undefined && LIVE_STATUSES.has(status) && initialEvents !== undefined;
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    const tick = async (): Promise<void> => {
      const after = cursorRef.current;
      const page = await stores.events.listByRun(scope, {
        limit: 200,
        ...(after === undefined ? {} : { afterSequence: after }),
      });
      if (stopped) return;
      const fresh = page.items.filter((event) => !seenIds.current.has(event.eventId));
      if (fresh.length === 0) return;
      for (const event of fresh) {
        seenIds.current.add(event.eventId);
        if (isSequenced(event)) {
          cursorRef.current = Math.max(cursorRef.current ?? -1, event.sequence);
        }
      }
      setExtra((current) => [...current, ...fresh]);
      await invalidateAll(
        client,
        fresh.flatMap((event) => keysNamedBy(event, scope.runId)),
      );
    };
    const timer = setInterval(() => void tick(), pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [polling, pollMs, stores, scope, client]);

  return {
    events: orderEvents([...(initialEvents ?? []), ...extra]),
    cursor: cursorRef.current,
    polling,
  };
};
