/**
 * The publisher (P10, T4, D-P10-22): resolves a run's publication intents, in
 * order, by pushing the program branch at GitHub with a lease at the Git
 * transport. Holds the GitHub App's key; nothing on a machine ever does.
 *
 * For each pending intent, oldest first: an intent whose predecessor could
 * not be published is `held` behind it, because GitHub lacks what it builds
 * on. Otherwise the branch's current head is read from the remote's
 * advertisement. If it is already the intent's head, or a later one's in the
 * chain, the push happened (a lost reply, or a human pushed): `published`, up
 * to there. If it is not the intent's predecessor, something else moved the
 * branch: `conflict`, recorded with the remote head, never retried with force.
 * Otherwise the pack is fetched from the artifact bucket and pushed as
 * `<predecessor> <head> refs/heads/<branch>`, which the remote accepts only if
 * the ref still holds the predecessor. A refusal names its reason:
 * `non-fast-forward` is a conflict, a protection rule is `protected`, a
 * permission the App lacks (a workflow file without `workflows`) is
 * `forbidden`, anything else is an error that is retried on the next
 * invocation, three times, then blocks. Whatever blocks holds every intent
 * after it, until a human fixes the cause and asks for a retry
 * (`POST …/publication/retry`, `nightshift resume`). Two invocations for one run never push at once: the first takes a
 * lock row for the run, resolves every pending intent, releases, and looks
 * once more, so an intent recorded while it held the lock is not left behind.
 */
import type { Dispatch, PublicationIntent } from "@nightshift/contracts";
import {
  blocksPublication,
  type Clock,
  chainOrder,
  type GitHubAppClient,
  holdBehind,
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
  | "forbidden"
  | "held"
  | "retrying"
  | "error"
  | "not_configured";

const attemptOf = (intent: PublicationIntent): number => {
  const match = /^attempt (\d+)/.exec(intent.detail ?? "");
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
};

export const classify = (reason: string): "conflict" | "protected" | "forbidden" | "error" => {
  const lowered = reason.toLowerCase();
  if (lowered.includes("non-fast-forward") || lowered.includes("fetch first")) return "conflict";
  if (lowered.includes("failed to lock") || lowered.includes("stale info")) return "conflict";
  // GitHub refuses an App's push that touches `.github/workflows/` without the
  // `workflows` permission; retrying cannot change that, a human must grant it.
  if (lowered.includes("permission") || lowered.includes("not allowed to push")) return "forbidden";
  if (lowered.includes("protected") || lowered.includes("hook declined")) return "protected";
  return "error";
};

/** What the human reads when the App lacks a permission: the cause, the fix, and GitHub's words. */
export const forbiddenDetail = (branch: string, reason: string): string =>
  (/workflow/i.test(reason)
    ? `GitHub refused ${branch}: the Nightshift GitHub App may not change files under .github/workflows/. ` +
      'Give the App "Workflows: Read and write" and have the installation accept it'
    : `GitHub refused ${branch}: the Nightshift GitHub App lacks a permission this push needs. ` +
      "Grant it and have the installation accept it") +
  `, then run \`nightshift resume\` for the program to publish from the run's stored bundles. GitHub said: ${reason}`;

/** The GitHub clone URL a contract's `repository.url` means. */
export const cloneUrlOf = (repositoryUrl: string): string =>
  `${repositoryUrl.replace(/\.git$/, "").replace(/\/$/, "")}.git`;

/** The program, its GitHub repository, and the org's installation that grants it, or `undefined`. */
const targetOf = async (deps: PublisherDeps, scope: RunScope) => {
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
    return undefined;
  }
  return { program, repository, installation };
};

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

  // Behind a block, nothing can go: GitHub lacks the commits this one builds on.
  const before = dispatch.publication.intents.find(
    (candidate) => candidate.head === intent.expectedPredecessor,
  );
  if (before !== undefined && blocksPublication(before.status)) {
    log(`${scope.runId}: ${intent.head.slice(0, 12)} held behind ${before.head.slice(0, 12)}`);
    await put(holdBehind(dispatch, before.head, at));
    return "held";
  }

  const target = await targetOf(deps, scope);
  if (target === undefined) {
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
  const { program, repository, installation } = target;
  const branch = program.repository.programBranch;
  const ref = `refs/heads/${branch}`;
  const { token } = await deps.github.writeToken(installation.installationId, repository);
  const authorization = installationAuthorization(token);
  const repositoryUrl = (deps.remoteUrlOf ?? cloneUrlOf)(program.repository.url);

  const advertised = await remote.advertise(repositoryUrl, authorization);
  const current = advertised.get(ref) ?? ZERO_OID;
  const already = publishedUpTo(dispatch, intent, current, at);
  if (already !== undefined) {
    log(`${scope.runId}: ${branch} already at ${current.slice(0, 12)}`);
    await put(already);
    return "already_published";
  }
  if (current !== intent.expectedPredecessor) {
    const detail = `the branch is at ${current.slice(0, 12)}, not the ${intent.expectedPredecessor.slice(0, 12)} the run built on; someone else moved ${branch}`;
    log(`${scope.runId}: conflict: ${detail}`);
    await put(blockChain(dispatch, intent.head, "conflict", detail, at));
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
  const refusal = refused(dispatch, intent, branch, outcome, at);
  log(`${scope.runId}: ${refusal.step}: ${refusal.reason}`);
  await put(refusal.next);
  return refusal.step;
};

/**
 * A push GitHub did not take, as the record it leaves: a lease refusal is a
 * conflict, a rule is `protected`, a missing permission is `forbidden`, each
 * holding what builds on it; anything else is retried, then blocks as `error`.
 */
const refused = (
  dispatch: Dispatch,
  intent: PublicationIntent,
  branch: string,
  outcome: Exclude<PushOutcome, { kind: "ok" }>,
  at: string,
): { readonly next: Dispatch; readonly step: PublishStep; readonly reason: string } => {
  const reason = outcome.kind === "rejected" ? outcome.reason : outcome.detail;
  const kind = outcome.kind === "rejected" ? classify(reason) : "error";
  const block = (status: "conflict" | "protected" | "forbidden" | "error", detail: string) => ({
    next: blockChain(dispatch, intent.head, status, detail, at),
    step: status,
    reason,
  });
  if (kind === "conflict") return block("conflict", `the remote refused the lease: ${reason}`);
  if (kind === "protected") return block("protected", `${branch} is protected: ${reason}`);
  if (kind === "forbidden") return block("forbidden", forbiddenDetail(branch, reason));
  const attempt = attemptOf(intent) + 1;
  if (attempt >= PUBLISH_ATTEMPTS) {
    return block("error", `attempt ${attempt} failed: ${reason}; giving up`);
  }
  return {
    step: "retrying",
    reason: `attempt ${attempt} failed: ${reason}`,
    next: {
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
    },
  };
};

/**
 * When GitHub is already at this intent's head or a later one of the chain, the
 * push happened (a lost reply, or a human pushed the commits): every intent up
 * to there is published. `undefined` when GitHub is not on the chain from here.
 */
const publishedUpTo = (
  dispatch: Dispatch,
  intent: PublicationIntent,
  current: string,
  at: string,
): Dispatch | undefined => {
  const chain = chainOrder(dispatch.publication.intents);
  const from = chain.findIndex((candidate) => candidate.head === intent.head);
  const reached = chain.findIndex((candidate) => candidate.head === current);
  if (from < 0 || reached < from) return undefined;
  return chain
    .slice(from, reached + 1)
    .reduce(
      (next, done) => resolveIntent(next, done.head, "published", "already at GitHub", at),
      dispatch,
    );
};

/**
 * A block at one head holds every intent that builds on it: they are not
 * conflicts, nothing is wrong with them, and they go once the block is fixed.
 */
const blockChain = (
  dispatch: Dispatch,
  head: PublicationIntent["head"],
  status: "conflict" | "protected" | "forbidden" | "error",
  detail: string,
  at: string,
): Dispatch => {
  const next = holdBehind(resolveIntent(dispatch, head, status, detail, at), head, at);
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
