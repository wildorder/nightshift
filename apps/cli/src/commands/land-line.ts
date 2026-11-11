/**
 * `nightshift land` for a project's line program (the binding ruling on F-01).
 *
 * A line program is made by the plane, not planned: it has no draft, no plan
 * and no dispatch intents. Its refused push lives on the line record, so the
 * retry is the plane's `publication.retry` on the line program's run, and what
 * it did is read from the line record, not from a dispatch's publication.
 * The program is the project's line branch's, found from `nightshift.config.json`.
 */
import {
  type LineRecord,
  type LineView,
  LineViewSchema,
  type NightshiftConfig,
} from "@nightshift/contracts";
import { lineHeldByRefusal } from "@nightshift/core";
import { routes, send } from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";
import type { Session } from "../session.js";
import { POLL_MS, REPUBLISH_DEADLINE_MS } from "./republish.js";

type LineConfig = NonNullable<NightshiftConfig["line"]>;

const readView = async (
  session: Session,
  projectId: NightshiftConfig["projectId"],
  branch: string,
) =>
  LineViewSchema.parse(
    await send(session.transport, { method: "GET", path: routes.line(projectId, branch) }),
  );

/**
 * The line view when `id` names the project's line program: the line's branch,
 * or the program id the plane gave it. Otherwise undefined, and `land` goes on
 * as for an ordinary program.
 */
export const lineProgramNamed = async (
  session: Session,
  config: Pick<NightshiftConfig, "projectId"> & { readonly line?: LineConfig | undefined },
  id: string,
): Promise<LineView | undefined> => {
  if (config.line === undefined) return undefined;
  if (id !== config.line.branch && !id.startsWith("prog_")) return undefined;
  const view = await readView(session, config.projectId, config.line.branch).catch(() => undefined);
  if (view === undefined) return undefined;
  return id === config.line.branch || id === view.programId ? view : undefined;
};

/** Retries the line's refused push once and waits for the publisher; 0 when it is published. */
export const landLine = async (
  environment: CliEnvironment,
  session: Session,
  config: Pick<NightshiftConfig, "projectId"> & { readonly line: LineConfig },
  view: LineView,
  run?: string,
): Promise<number> => {
  if (run !== undefined && run !== view.runId) {
    throw new UsageError(
      view.runId === undefined
        ? `run ${run} is not the line ${config.line.branch}'s run: the line has no run of its program`
        : `run ${run} is not the line ${config.line.branch}'s current run (${view.runId}); nothing was retried`,
    );
  }
  const { projectId } = config;
  const branch = config.line.branch;
  let record: LineRecord = view.record;
  if (
    record.push === undefined ||
    (record.push.status !== "pending" && !lineHeldByRefusal(record))
  ) {
    environment.out(`nothing to retry: the push to the line ${branch} is not held or pending`);
    return 0;
  }
  if (lineHeldByRefusal(record)) {
    if (view.runId === undefined) {
      environment.err(
        `the line ${branch} has no run of its program to retry through; run \`nightshift line requeue --all\``,
      );
      return 1;
    }
    environment.out(`line ${branch}: asking the publisher to push the held line once more`);
    await send(session.transport, {
      method: "POST",
      path: routes.publicationRetry({
        projectId,
        programId: view.programId,
        runId: view.runId,
      }),
    });
  }
  const deadline = environment.clock.now() + REPUBLISH_DEADLINE_MS;
  for (;;) {
    record = (await readView(session, projectId, branch)).record;
    if (record.push?.status !== "pending") break;
    if (environment.clock.now() >= deadline) {
      environment.err(
        `the publisher has not finished after ${REPUBLISH_DEADLINE_MS / 60_000} minutes: the push to ${branch} is still waiting. Run this again to see where it got to.`,
      );
      return 1;
    }
    await environment.sleep(POLL_MS);
  }
  const push = record.push;
  if (push?.status === "published") {
    environment.out(`GitHub has the line: ${branch} is at ${push.head.slice(0, 12)}`);
    return 0;
  }
  const reason = push?.detail ?? record.waiting?.detail ?? "the push was refused";
  environment.err(`the push to ${branch} is still ${push?.status ?? "not made"}: ${reason}`);
  environment.err("Fix that, then run this again. Nothing was forced, and nothing is lost.");
  return 1;
};
