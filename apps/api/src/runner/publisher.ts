/**
 * The publisher (P10, T4, D-P10-22): resolves a run's publication intents, in
 * order, by pushing the program branch at GitHub with a lease at the Git
 * transport. Holds the GitHub App's key; nothing on a machine ever does.
 *
 * For each pending intent, oldest first: the branch's current head is read from
 * the remote's advertisement. If it is already the intent's head, the push
 * happened and the reply was lost: `published`. If it is not the intent's
 * predecessor, something else moved the branch: `conflict`, recorded with the
 * remote head, never retried with force, and every later intent in the chain is
 * a conflict too. Otherwise the pack is fetched from the artifact bucket and
 * pushed as `<predecessor> <head> refs/heads/<branch>`, which the remote accepts
 * only if the ref still holds the predecessor. A refusal names its reason:
 * `non-fast-forward` is a conflict, a protection rule is `protected`, anything
 * else is an error that is retried on the next invocation, three times, then
 * blocks. Two invocations for one run never push at once: the first takes a
 * lock row for the run, resolves every pending intent, releases, and looks
 * once more, so an intent recorded while it held the lock is not left behind.
 */
import type { Dispatch, PublicationIntent } from "@nightshift/contracts";
import {
  type Clock,
  type GitHubAppClient,
  installationGranting,
  type NightshiftStores,
  nextPendingIntent,
  nowIso,
  type RunScope,
  repositoryNameOf,
  resolveIntent,
} from "@nightshift/core";
import {
  advertiseReceivePack,
  installationAuthorization,
  type PushOutcome,
  pushReceivePack,
  ZERO_OID,
} from "../github/smart-http.js";

/** Where the packs the engine uploaded are read back from. */
export interface BundleStore {
  get(key: string): Promise<Uint8Array>;
}

/**
 * One publisher per run at a time. `acquire` succeeds when no one holds the
 * run, or the holder's lease has lapsed (a Lambda that died mid-push); the
 * lease is the function's timeout.
 */
export interface PublishLock {
  acquire(scope: RunScope, leaseMs: number): Promise<boolean>;
  release(scope: RunScope): Promise<void>;
}

/** A lock for one process: the tests' and the local plane's. */
export const createLocalPublishLock = (): PublishLock => {
  const held = new Map<string, number>();
  return {
    acquire: async (scope, leaseMs) => {
      const now = Date.now();
      const until = held.get(scope.runId);
      if (until !== undefined && until > now) return false;
      held.set(scope.runId, now + leaseMs);
      return true;
    },
    release: async (scope) => {
      held.delete(scope.runId);
    },
  };
};

/** How long a holder may keep the run: the publisher function's timeout. */
export const PUBLISH_LEASE_MS = 5 * 60_000;

/** The two transport calls, so the offline suite can stand in for GitHub with a local server. */
export interface GitRemote {
  advertise(repositoryUrl: string, authorization: string): Promise<ReadonlyMap<string, string>>;
  push(input: {
    readonly repositoryUrl: string;
    readonly authorization: string;
    readonly ref: string;
    readonly expectedOld: string;
    readonly newOid: string;
    readonly pack: Uint8Array;
  }): Promise<PushOutcome>;
}

export const smartHttpRemote: GitRemote = {
  advertise: async (repositoryUrl, authorization) =>
    (await advertiseReceivePack({ repositoryUrl, authorization })).refs,
  push: (input) => pushReceivePack(input),
};

export interface PublisherDeps {
  readonly stores: NightshiftStores;
  readonly clock: Clock;
  readonly github: Pick<GitHubAppClient, "writeToken">;
  readonly bundles: BundleStore;
  readonly lock?: PublishLock;
  readonly remote?: GitRemote;
  /** Rewrites a contract's repository URL into the one the remote serves; the tests point it at a local server. */
  readonly remoteUrlOf?: (repositoryUrl: string) => string;
  readonly log?: (line: string) => void;
}

/** How many times a transient push failure is tried before the intent blocks. */
export const PUBLISH_ATTEMPTS = 3;

export type PublishStep =
  | "locked"
  | "nothing_pending"
  | "published"
  | "already_published"
  | "conflict"
  | "protected"
  | "retrying"
  | "error"
  | "not_configured";

const attemptOf = (intent: PublicationIntent): number => {
  const match = /^attempt (\d+)/.exec(intent.detail ?? "");
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
};

const classify = (reason: string): "conflict" | "protected" | "error" => {
  const lowered = reason.toLowerCase();
  if (lowered.includes("non-fast-forward") || lowered.includes("fetch first")) return "conflict";
  if (lowered.includes("failed to lock") || lowered.includes("stale info")) return "conflict";
  if (lowered.includes("protected") || lowered.includes("hook declined")) return "protected";
  return "error";
};

/** The GitHub clone URL a contract's `repository.url` means. */
export const cloneUrlOf = (repositoryUrl: string): string =>
  `${repositoryUrl.replace(/\.git$/, "").replace(/\/$/, "")}.git`;

/**
 * Resolves the oldest pending intent of the run's dispatch. Returns what
 * happened; the caller loops until `nothing_pending` or a block.
 */
export const publishNext = async (deps: PublisherDeps, scope: RunScope): Promise<PublishStep> => {
  const log = deps.log ?? (() => undefined);
  const remote = deps.remote ?? smartHttpRemote;
  const dispatch = await deps.stores.dispatches.get(scope);
  if (dispatch === undefined) return "nothing_pending";
  const intent = nextPendingIntent(dispatch);
  if (intent === undefined) return "nothing_pending";
  const at = nowIso(deps.clock);
  const put = (next: Dispatch) => deps.stores.dispatches.put(next);

  const program = await deps.stores.programContracts.get(scope.projectId, scope.programId);
  const project = await deps.stores.projects.get(scope.projectId);
  const orgConfig =
    project === undefined ? undefined : await deps.stores.orgConfigs.get(project.orgId);
  const repository = program === undefined ? undefined : repositoryNameOf(program.repository.url);
  const installation =
    repository === undefined
      ? undefined
      : installationGranting(orgConfig?.installations ?? [], repository);
  if (program === undefined || repository === undefined || installation === undefined) {
    await put(
      resolveIntent(
        dispatch,
        intent.head,
        "error",
        "the org has no GitHub installation granting the repository, or the program names no GitHub repository",
        at,
      ),
    );
    return "not_configured";
  }
  const branch = program.repository.programBranch;
  const ref = `refs/heads/${branch}`;
  const { token } = await deps.github.writeToken(installation.installationId, repository);
  const authorization = installationAuthorization(token);
  const repositoryUrl = (deps.remoteUrlOf ?? cloneUrlOf)(program.repository.url);

  const advertised = await remote.advertise(repositoryUrl, authorization);
  const current = advertised.get(ref) ?? ZERO_OID;
  if (current === intent.head) {
    log(`${scope.runId}: ${branch} already at ${intent.head.slice(0, 12)}; the reply was lost`);
    await put(resolveIntent(dispatch, intent.head, "published", "already at the head", at));
    return "already_published";
  }
  if (current !== intent.expectedPredecessor) {
    const detail = `the branch is at ${current.slice(0, 12)}, not the ${intent.expectedPredecessor.slice(0, 12)} the run built on; someone else moved ${branch}`;
    log(`${scope.runId}: conflict: ${detail}`);
    await put(conflictChain(dispatch, intent.head, detail, at));
    return "conflict";
  }

  const pack = await deps.bundles.get(intent.bundleKey);
  const outcome = await remote.push({
    repositoryUrl,
    authorization,
    ref,
    expectedOld: intent.expectedPredecessor,
    newOid: intent.head,
    pack,
  });
  if (outcome.kind === "ok") {
    log(
      `${scope.runId}: published ${branch} ${intent.expectedPredecessor.slice(0, 12)} → ${intent.head.slice(0, 12)}`,
    );
    await put(resolveIntent(dispatch, intent.head, "published", undefined, at));
    return "published";
  }
  const reason = outcome.kind === "rejected" ? outcome.reason : outcome.detail;
  const kind = outcome.kind === "rejected" ? classify(reason) : "error";
  if (kind === "conflict") {
    await put(conflictChain(dispatch, intent.head, `the remote refused the lease: ${reason}`, at));
    return "conflict";
  }
  if (kind === "protected") {
    await put(
      resolveIntent(dispatch, intent.head, "protected", `${branch} is protected: ${reason}`, at),
    );
    return "protected";
  }
  const attempt = attemptOf(intent) + 1;
  if (attempt >= PUBLISH_ATTEMPTS) {
    await put(
      resolveIntent(
        dispatch,
        intent.head,
        "error",
        `attempt ${attempt} failed: ${reason}; giving up`,
        at,
      ),
    );
    return "error";
  }
  log(`${scope.runId}: push failed (attempt ${attempt}): ${reason}`);
  await put({
    ...dispatch,
    publication: {
      ...dispatch.publication,
      intents: dispatch.publication.intents.map((candidate) =>
        candidate.head === intent.head
          ? { ...candidate, detail: `attempt ${attempt} failed: ${reason}` }
          : candidate,
      ),
    },
    updatedAt: at,
  });
  return "retrying";
};

/** A conflict at one head is a conflict for every intent that builds on it. */
const conflictChain = (dispatch: Dispatch, head: string, detail: string, at: string): Dispatch => {
  let next = resolveIntent(dispatch, head, "conflict", detail, at);
  for (const later of next.publication.intents.filter((intent) => intent.status === "pending")) {
    next = resolveIntent(
      next,
      later.head,
      "conflict",
      `superseded by the conflict at ${head.slice(0, 12)}`,
      at,
    );
  }
  return { ...next, publication: { ...next.publication, blocked: detail } };
};

/**
 * Every pending intent of the run, in order, under the run's lock, until none
 * is left or one blocks; then once more after releasing, for an intent that
 * arrived while the lock was held and whose own invocation found it taken.
 */
export const publishAll = async (
  deps: PublisherDeps,
  scope: RunScope,
): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  const count = (step: PublishStep) => {
    counts[step] = (counts[step] ?? 0) + 1;
  };
  const lock = deps.lock ?? createLocalPublishLock();
  for (let round = 0; round < 2; round += 1) {
    if (!(await lock.acquire(scope, PUBLISH_LEASE_MS))) {
      count("locked");
      return counts;
    }
    let blocked = false;
    try {
      for (let guard = 0; guard < 100; guard += 1) {
        const step = await publishNext(deps, scope);
        count(step);
        if (!["published", "already_published"].includes(step)) {
          blocked = step !== "nothing_pending";
          break;
        }
      }
    } finally {
      await lock.release(scope);
    }
    if (blocked) break;
    const dispatch = await deps.stores.dispatches.get(scope);
    if (dispatch === undefined || nextPendingIntent(dispatch) === undefined) break;
  }
  return counts;
};
