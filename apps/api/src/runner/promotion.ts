/**
 * Keeping the promotion pull request (P26, S-01 J4): one pull request from the
 * line's branch to the branch it promotes to, opened and updated by the
 * publisher after each push of the line and whenever the reconciler sees the
 * target move or an open pull request that may have been closed.
 *
 * Nightshift never merges the pull request, never merges the target into the
 * line, and writes only the line record's `promotion`; the queue, push, batch
 * and waiting of the line are untouched. Nothing here throws: a failure is
 * recorded as `blocked` and logged, and never affects composing.
 */
import type { LineRecord, ProgramId, ProjectId } from "@nightshift/contracts";
import { MAX_PROMOTION_DIVERGED_COMMITS, programsDirectoryOf } from "@nightshift/contracts";
import {
  type Clock,
  divergedCommits,
  GitHubAccessMissing,
  type GitHubAppClient,
  type GitHubPromotionClient,
  installationGranting,
  lineProgramId,
  type NightshiftStores,
  nowIso,
  type PromotionCompare,
  type PromotionProgramFacts,
  type PromotionRepairFacts,
  promotionBody,
  promotionPrograms,
  promotionTitle,
  repositoryNameOf,
} from "@nightshift/core";
import { promotionConfigOf, seedPromotion } from "./line-support.js";

export interface PromotionDeps {
  readonly stores: NightshiftStores;
  readonly clock: Clock;
  /** Absent where nothing may write to GitHub: no call is made. */
  readonly promotions?: GitHubPromotionClient;
  /** Reads the target's head, when the wiring has the App client. */
  readonly github?: Partial<Pick<GitHubAppClient, "branchHead">>;
  readonly log?: (line: string) => void;
}

export type PromotionStep =
  | "not_configured"
  | "no_client"
  | "no_line"
  | "nothing_to_promote"
  | "opened"
  | "updated"
  | "unchanged"
  | "merged"
  | "closed"
  | "blocked"
  | "error";

/** Said when the App may not touch pull requests. */
export const PULL_REQUESTS_GRANT =
  "Give the Nightshift GitHub App 'Pull requests: Read and write' and have the installation accept it";

type PullRequest = NonNullable<Awaited<ReturnType<GitHubPromotionClient["pullRequest"]>>>;

const isAlreadyExists = (error: unknown): boolean =>
  /already exists|\b422\b|Unprocessable/i.test(
    error instanceof Error ? error.message : String(error),
  );

const titleOfObjective = (objective: string): string | undefined => {
  const first = objective.split(/\r?\n/).find((line) => line.trim() !== "");
  return first === undefined ? undefined : first.trim().slice(0, 120);
};

/** What the body says about each program the line holds that the target lacks. */
const programFacts = async (
  deps: PromotionDeps,
  projectId: ProjectId,
  ids: readonly ProgramId[],
): Promise<Map<ProgramId, PromotionProgramFacts>> => {
  const facts = new Map<ProgramId, PromotionProgramFacts>();
  for (const id of ids) {
    const contract = await deps.stores.programContracts.get(projectId, id);
    let latest: { readonly startedAt: string; readonly status: string } | undefined;
    let cursor: string | undefined;
    do {
      const page = await deps.stores.runs.listByProgram(
        { projectId, programId: id },
        cursor === undefined ? {} : { cursor },
      );
      for (const run of page.items) {
        if (latest === undefined || run.startedAt > latest.startedAt) latest = run;
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    const name = (await deps.stores.planDrafts.get(projectId, id))?.name;
    const title = contract === undefined ? undefined : titleOfObjective(contract.objective);
    facts.set(id, {
      ...(title === undefined ? {} : { title }),
      ...(name === undefined ? {} : { name }),
      whole: latest?.status === "succeeded",
      programsDirectory: programsDirectoryOf(contract),
    });
  }
  return facts;
};

/** The decision each repaired composition's job recorded, by job contract id; absent where unreadable. */
const repairFacts = async (
  deps: PromotionDeps,
  record: LineRecord,
  aheadShas: ReadonlySet<string>,
): Promise<Map<string, PromotionRepairFacts>> => {
  const facts = new Map<string, PromotionRepairFacts>();
  for (const composition of record.compositions) {
    const { repair } = composition;
    if (repair === undefined || !aheadShas.has(composition.commit)) continue;
    if (facts.has(repair.jobContractId)) continue;
    try {
      const scope = {
        projectId: record.projectId,
        programId: lineProgramId(record.projectId, record.branch),
        runId: repair.runId,
      };
      const job = await deps.stores.jobContracts.get(scope, repair.jobContractId);
      if (job?.repair === undefined) continue;
      const decision = await deps.stores.decisions.get(scope, job.repair.decisionId);
      if (decision === undefined) continue;
      facts.set(repair.jobContractId, {
        cause: job.repair.cause,
        gates: job.repair.gates,
        choice: decision.choice,
        rationale: decision.rationale,
      });
    } catch (error) {
      deps.log?.(`line ${record.branch}: promotion: repair decision: ${String(error)}`);
    }
  }
  return facts;
};

/** Records `change` on the line's promotion alone; `undefined` leaves the record. */
const writePromotion = async (
  deps: PromotionDeps,
  line: { readonly projectId: ProjectId; readonly branch: string },
  to: string,
  change: (current: NonNullable<LineRecord["promotion"]>) => LineRecord["promotion"],
): Promise<void> => {
  const at = nowIso(deps.clock);
  await deps.stores.lines.update(line.projectId, line.branch, (current) => {
    if (current === undefined) return undefined;
    const base = current.promotion?.to === to ? current.promotion : { to, updatedAt: at };
    const next = change(base);
    return next === undefined ? undefined : { ...current, promotion: next, updatedAt: at };
  });
};

/**
 * Opens or updates the line's one pull request to its promote target, or
 * records why it cannot. Never throws.
 */
export const maintainPromotion = async (
  deps: PromotionDeps,
  line: { readonly projectId: ProjectId; readonly branch: string },
): Promise<PromotionStep> => {
  const log = deps.log ?? (() => undefined);
  try {
    return await maintain(deps, line, log);
  } catch (error) {
    log(`line ${line.branch}: promotion: ${String(error)}`);
    return "error";
  }
};

const maintain = async (
  deps: PromotionDeps,
  line: { readonly projectId: ProjectId; readonly branch: string },
  log: (line: string) => void,
): Promise<PromotionStep> => {
  const { projectId, branch } = line;
  const record = await deps.stores.lines.get(projectId, branch);
  if (record === undefined) return "no_line";
  const config = await promotionConfigOf(deps.stores, projectId, branch);
  if (config === undefined) {
    // No promote: whatever was recorded goes, and GitHub is not asked anything.
    await deps.stores.lines.update(projectId, branch, (current) =>
      current === undefined ? undefined : seedPromotion(current, undefined, nowIso(deps.clock)),
    );
    return "not_configured";
  }
  const { to } = config;
  const client = deps.promotions;
  if (client === undefined) return "no_client";
  const lineHead = record.head;
  if (lineHead === undefined) return "nothing_to_promote";

  const project = await deps.stores.projects.get(projectId);
  const orgConfig =
    project === undefined ? undefined : await deps.stores.orgConfigs.get(project.orgId);
  const repository = repositoryNameOf(record.repositoryUrl);
  const installation =
    repository === undefined
      ? undefined
      : installationGranting(orgConfig?.installations ?? [], repository);
  const previous = record.promotion?.to === to ? record.promotion : undefined;
  let targetHead: string | undefined;
  const blocked = async (
    reason: "pull_requests_permission" | "error",
    detail: string,
  ): Promise<void> => {
    const at = nowIso(deps.clock);
    await writePromotion(deps, line, to, (current) => ({
      ...current,
      blocked: {
        reason,
        detail,
        since: current.blocked?.reason === reason ? current.blocked.since : at,
        at,
        head: lineHead,
        ...(targetHead === undefined ? {} : { targetHead }),
      },
      updatedAt: at,
    }));
  };
  if (repository === undefined || installation === undefined) {
    await blocked(
      "error",
      "the org has no GitHub installation granting the repository, or the line names no GitHub repository",
    );
    return "blocked";
  }
  const { installationId } = installation;

  try {
    targetHead = await deps.github?.branchHead?.(installationId, repository, to);

    // (a) What became of the pull request we know.
    let number = previous?.number;
    let url = previous?.url;
    let state = previous?.state;
    let closedAtHead = previous?.closedAtHead;
    if (number !== undefined) {
      const known: PullRequest | undefined = await client.pullRequest(
        installationId,
        repository,
        number,
      );
      if (known === undefined) {
        number = undefined;
        url = undefined;
        state = undefined;
      } else {
        url = known.url;
        state = known.state;
        // A close describes the head the pull request described, not the line's head now.
        if (known.state === "closed") closedAtHead ??= previous?.head ?? lineHead;
      }
    }

    // (b) What the line holds that the target lacks, and the reverse.
    const ahead: PromotionCompare = await client.compare(installationId, repository, to, lineHead);
    const behindBy = ahead.behindBy;
    const diverged =
      behindBy > 0
        ? divergedCommits(await client.compare(installationId, repository, lineHead, to))
        : undefined;

    // (c) Open, update, or leave.
    let step: PromotionStep = "nothing_to_promote";
    if (ahead.aheadBy > 0) {
      let open: { readonly number: number; readonly url: string } | undefined =
        state === "open" && number !== undefined && url !== undefined ? { number, url } : undefined;
      if (open === undefined) {
        open = await client.findOpenPullRequest(installationId, repository, {
          head: branch,
          base: to,
        });
      }
      const programs = await programFacts(deps, projectId, promotionPrograms(record, ahead));
      const words = {
        title: promotionTitle(record, to),
        body: promotionBody({
          record,
          to,
          repository,
          ahead,
          diverged: diverged ?? { commits: [], count: 0, complete: true },
          programs,
          repairs: await repairFacts(deps, record, new Set(ahead.commits.map((c) => c.sha))),
        }),
      };
      const sameAsDescribed =
        previous?.head === lineHead &&
        previous.targetHead === targetHead &&
        previous.aheadBy === ahead.aheadBy &&
        previous.behindBy === behindBy &&
        previous.state === "open" &&
        previous.number === open?.number;
      if (open !== undefined) {
        if (!sameAsDescribed) {
          await client.updatePullRequest(installationId, repository, open.number, words);
          step = "updated";
        } else step = "unchanged";
        ({ number, url } = open);
        state = "open";
      } else if (state === "closed" && lineHead === closedAtHead) {
        // D-02: a person closed it; a fresh one only once the line moves.
        step = "closed";
      } else if (state === "merged" && previous?.head === lineHead) {
        step = "merged";
      } else {
        let opened: PullRequest;
        try {
          opened = await client.openPullRequest(installationId, repository, {
            head: branch,
            base: to,
            ...words,
          });
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          const found = await client.findOpenPullRequest(installationId, repository, {
            head: branch,
            base: to,
          });
          if (found === undefined) throw error;
          opened = await client.updatePullRequest(installationId, repository, found.number, words);
          step = "updated";
        }
        if (step !== "updated") step = "opened";
        ({ number, url, state } = opened);
        closedAtHead = undefined;
      }
    } else if (state === "merged") step = "merged";
    else if (state === "closed") step = "closed";

    const at = nowIso(deps.clock);
    await writePromotion(deps, line, to, (current) => {
      const since = current.diverged?.since ?? at;
      return {
        to,
        ...(number === undefined ? {} : { number }),
        ...(url === undefined ? {} : { url }),
        ...(state === undefined ? {} : { state }),
        head: lineHead,
        ...(closedAtHead === undefined || state !== "closed" ? {} : { closedAtHead }),
        ...(targetHead === undefined ? {} : { targetHead }),
        aheadBy: ahead.aheadBy,
        behindBy,
        ...(diverged === undefined || diverged.count === 0
          ? {}
          : {
              diverged: {
                commits: diverged.commits.slice(0, MAX_PROMOTION_DIVERGED_COMMITS),
                count: diverged.count,
                since,
              },
            }),
        updatedAt: at,
      };
    });
    return step;
  } catch (error) {
    if (error instanceof GitHubAccessMissing) {
      log(`line ${branch}: promotion to ${to}: ${error.message}`);
      await blocked("pull_requests_permission", PULL_REQUESTS_GRANT);
      return "blocked";
    }
    log(`line ${branch}: promotion to ${to}: ${String(error)}`);
    await blocked("error", String(error instanceof Error ? error.message : error));
    return "blocked";
  }
};

/** How long a permission block stands before the reconciler tries again regardless. */
export const PERMISSION_RETRY_MS = 60 * 60_000;

/** Whether the reconciler should ask the publisher to refresh this line's promotion. */
export const promotionDue = (
  record: LineRecord,
  targetHead: string | undefined,
  now: number,
): boolean => {
  const promotion = record.promotion;
  if (promotion === undefined) return false;
  const blocked = promotion.blocked;
  if (blocked === undefined) {
    return (
      targetHead !== promotion.targetHead ||
      promotion.head !== record.head ||
      promotion.state === "open"
    );
  }
  if (blocked.reason === "error") return true;
  return (
    record.head !== blocked.head ||
    targetHead !== blocked.targetHead ||
    now - Date.parse(blocked.at) > PERMISSION_RETRY_MS
  );
};
