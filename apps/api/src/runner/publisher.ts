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
import type {
  Dispatch,
  ProgramContract,
  ProjectId,
  PublicationIntent,
} from "@nightshift/contracts";
import {
  appendQueueEntry,
  blocksPublication,
  type Clock,
  chainOrder,
  type GitHubAppClient,
  hasPendingIntent,
  holdBehind,
  type IdGenerator,
  installationGranting,
  lineQueueOwed,
  type NightshiftStores,
  nextPendingIntent,
  nowIso,
  pendingStrandPublications,
  type RunScope,
  repositoryNameOf,
  resolveIntent,
  resolvePush,
  resolveStrandPublication,
} from "@nightshift/core";
import {
  advertiseReceivePack,
  installationAuthorization,
  type PushOutcome,
  pushReceivePack,
  ZERO_OID,
} from "../github/smart-http.js";
import type { ApiDeps } from "../http.js";
import { startLineRun } from "./line-run.js";

/** Where the packs the engine uploaded are read back from. */
export interface BundleStore {
  get(key: string): Promise<Uint8Array>;
}

/** What the publisher locks besides a run: one line, by its project and branch. */
export interface LineScope {
  readonly kind: "line";
  readonly projectId: ProjectId;
  readonly branch: string;
}

/** What one publisher invocation works on: a run's intents, or a line's push. */
export type PublishTarget = RunScope | LineScope;

export const isLineScope = (target: PublishTarget): target is LineScope =>
  "kind" in target && target.kind === "line";

/**
 * One publisher per run, and per line, at a time. `acquire` succeeds when no
 * one holds the key, or the holder's lease has lapsed (a Lambda that died
 * mid-push); the lease is the function's timeout.
 */
export interface PublishLock {
  acquire(key: PublishTarget, leaseMs: number): Promise<boolean>;
  release(key: PublishTarget): Promise<void>;
}

/** A lock for one process: the tests' and the local plane's. */
export const createLocalPublishLock = (): PublishLock => {
  const held = new Map<string, number>();
  const idOf = (key: PublishTarget): string =>
    isLineScope(key) ? `line\u0000${key.projectId}\u0000${key.branch}` : key.runId;
  return {
    acquire: async (key, leaseMs) => {
      const now = Date.now();
      const until = held.get(idOf(key));
      if (until !== undefined && until > now) return false;
      held.set(idOf(key), now + leaseMs);
      return true;
    },
    release: async (key) => {
      held.delete(idOf(key));
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
  readonly ids?: IdGenerator;
  /**
   * The control plane's wiring (`ApiDeps`) a line run is started through
   * (`startLineRun`, which admits it as any dispatch); absent where no plane
   * starts machines, and the range is only queued.
   */
  readonly plane?: ApiDeps;
}

/** How many times a transient push failure is tried before the intent blocks. */
export const PUBLISH_ATTEMPTS = 3;

export type PublishStep =
  | "strand_published"
  | "strand_retrying"
  | "strand_error"
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

const attemptOf = (intent: Pick<PublicationIntent, "detail">): number => {
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

/** A published resolution, plus the line's claim on the range when the program feeds one. */
const owing = (next: Dispatch, program: ProgramContract): Dispatch =>
  program.line === undefined
    ? next
    : { ...next, publication: { ...next.publication, lineOwed: true } };

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
    await put(owing(already, program));
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
    await put(owing(resolveIntent(dispatch, intent.head, "published", undefined, at), program));
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
 * Pushes each strand branch's newest head (A-60). The run owns its
 * `nightshift/<run>/…` refs, so the lease is whatever GitHub holds for the ref
 * now: it guards against a push racing this one, not against someone else's
 * work, and a strand cut afresh replaces the old ref. Each pack carries
 * everything since the dispatch's base, so nothing but the pack is needed. A
 * strand push never waits on the program branch's chain, nor blocks it; one
 * that keeps failing is `error`, and the strand's next head is tried afresh.
 */
export const publishStrands = async (
  deps: PublisherDeps,
  scope: RunScope,
): Promise<readonly PublishStep[]> => {
  const log = deps.log ?? (() => undefined);
  const remote = deps.remote ?? smartHttpRemote;
  const first = await deps.stores.dispatches.get(scope);
  if (first === undefined || pendingStrandPublications(first).length === 0) return [];
  const target = await targetOf(deps, scope);
  if (target === undefined) return ["not_configured"];
  const { program, repository, installation } = target;
  const { token } = await deps.github.writeToken(installation.installationId, repository);
  const authorization = installationAuthorization(token);
  const repositoryUrl = (deps.remoteUrlOf ?? cloneUrlOf)(program.repository.url);
  const advertised = await remote.advertise(repositoryUrl, authorization);
  const steps: PublishStep[] = [];
  for (const strand of pendingStrandPublications(first)) {
    const ref = `refs/heads/${strand.branch}`;
    const current = advertised.get(ref) ?? ZERO_OID;
    const at = nowIso(deps.clock);
    let outcome: Parameters<typeof resolveStrandPublication>[3];
    if (current === strand.head) {
      outcome = { status: "published", detail: "already at GitHub" };
    } else {
      const pushed = await remote.push({
        repositoryUrl,
        authorization,
        ref,
        expectedOld: current,
        newOid: strand.head,
        pack: await deps.bundles.get(strand.bundleKey),
      });
      const attempt = attemptOf(strand) + 1;
      const reason =
        pushed.kind === "ok" ? "" : pushed.kind === "rejected" ? pushed.reason : pushed.detail;
      outcome =
        pushed.kind === "ok"
          ? { status: "published" }
          : attempt >= PUBLISH_ATTEMPTS
            ? { status: "error", detail: `attempt ${attempt} failed: ${reason}; giving up` }
            : { status: "pending", detail: `attempt ${attempt} failed: ${reason}` };
    }
    log(`${scope.runId}: ${strand.branch} → ${strand.head.slice(0, 12)}: ${outcome.status}`);
    steps.push(
      outcome.status === "published"
        ? "strand_published"
        : outcome.status === "pending"
          ? "strand_retrying"
          : "strand_error",
    );
    // Read again: the machine may have asked for a newer head meanwhile.
    const latest = (await deps.stores.dispatches.get(scope)) ?? first;
    await deps.stores.dispatches.put(
      resolveStrandPublication(latest, strand.branch, strand.head, outcome, at),
    );
  }
  return steps;
};

/** The line ref's head at GitHub, from one advertisement; `undefined` when the ref does not exist or cannot be read. */
const lineRefHead = async (
  deps: PublisherDeps,
  scope: RunScope,
  program: ProgramContract,
): Promise<string | undefined> => {
  const branch = program.line?.branch;
  const target = await targetOf(deps, scope);
  if (branch === undefined || target === undefined) return undefined;
  const { token } = await deps.github.writeToken(
    target.installation.installationId,
    target.repository,
  );
  const advertised = await (deps.remote ?? smartHttpRemote).advertise(
    (deps.remoteUrlOf ?? cloneUrlOf)(program.repository.url),
    installationAuthorization(token),
  );
  return advertised.get(`refs/heads/${branch}`);
};

/**
 * Settles what a published range owes the line: queues it (idempotently, by
 * program and head), records that on the run's dispatch, and makes sure the
 * line's owner is started. Every failure is logged and left for the next
 * invocation (or the reconciler): `lineQueueOwed` stays true until the range is
 * recorded as queued, and nothing here touches the run's counts or intents.
 */
const settleLineObligation = async (deps: PublisherDeps, scope: RunScope): Promise<void> => {
  const log = deps.log ?? (() => undefined);
  try {
    const dispatch = await deps.stores.dispatches.get(scope);
    if (dispatch === undefined || !lineQueueOwed(dispatch)) return;
    const upTo = dispatch.publication.head;
    if (upTo === undefined) return;
    const program = await deps.stores.programContracts.get(scope.projectId, scope.programId);
    if (program?.line === undefined) return;
    const { branch } = program.line;
    const at = nowIso(deps.clock);
    // A line is created by its first range, with one look at where its ref stands.
    const existing = await deps.stores.lines.get(scope.projectId, branch);
    const head = existing === undefined ? await lineRefHead(deps, scope, program) : undefined;
    await deps.stores.lines.update(scope.projectId, branch, (current) =>
      appendQueueEntry(
        current ?? {
          schemaVersion: 1,
          projectId: scope.projectId,
          branch,
          repositoryUrl: program.repository.url,
          version: 1,
          ...(head === undefined ? {} : { head }),
          queue: [],
          held: [],
          compositions: [],
          parked: [],
          updatedAt: at,
        },
        { program: scope.programId, upTo },
        at,
      ),
    );
    const latest = (await deps.stores.dispatches.get(scope)) ?? dispatch;
    await deps.stores.dispatches.put({
      ...latest,
      publication: { ...latest.publication, lineQueuedUpTo: upTo },
      updatedAt: nowIso(deps.clock),
    });
    if (deps.plane !== undefined) {
      const result = await startLineRun(deps.plane, {
        projectId: scope.projectId,
        branch,
        naming: program,
      });
      log(
        `${scope.runId}: line ${branch}: ${result.kind}${result.kind === "waiting" ? ` (${result.reason}: ${result.detail})` : ""}`,
      );
    }
  } catch (error) {
    log(`${scope.runId}: could not queue the range on the line: ${String(error)}`);
  }
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
      // Strand branches go whatever the program branch's chain did (A-60).
      for (const step of await publishStrands(deps, scope)) count(step);
      // The line is owed whatever the loop ended with, and also when nothing was pending.
      await settleLineObligation(deps, scope);
    } finally {
      await lock.release(scope);
    }
    if (blocked) break;
    const dispatch = await deps.stores.dispatches.get(scope);
    if (dispatch === undefined || !hasPendingIntent(dispatch)) break;
  }
  return counts;
};

/**
 * Moves the line's branch to the head the owner asked for (`line.push`), under
 * the line's lock. The same compare-and-swap as a program branch, never forced;
 * every outcome is written to the line record alone, and a run's dispatch is
 * never touched from here.
 */
export const publishLine = async (
  deps: PublisherDeps,
  input: { readonly projectId: ProjectId; readonly branch: string },
): Promise<PublishStep> => {
  const log = deps.log ?? (() => undefined);
  const key: LineScope = { kind: "line", ...input };
  const lock = deps.lock ?? createLocalPublishLock();
  if (!(await lock.acquire(key, PUBLISH_LEASE_MS))) return "locked";
  try {
    return await pushLine(deps, input, log);
  } finally {
    await lock.release(key);
  }
};

const pushLine = async (
  deps: PublisherDeps,
  { projectId, branch }: { readonly projectId: ProjectId; readonly branch: string },
  log: (line: string) => void,
): Promise<PublishStep> => {
  const remote = deps.remote ?? smartHttpRemote;
  const record = await deps.stores.lines.get(projectId, branch);
  const push = record?.push;
  if (record === undefined || push === undefined || push.status !== "pending") {
    return "nothing_pending";
  }
  const settle = async (
    status: Parameters<typeof resolvePush>[2],
    detail: string | undefined,
    remoteHead?: string,
  ): Promise<void> => {
    const at = nowIso(deps.clock);
    await deps.stores.lines.update(projectId, branch, (current) => {
      const change = resolvePush(current ?? record, push.head, status, detail, at);
      if (!change.ok) return undefined;
      return remoteHead === undefined ? change.record : { ...change.record, head: remoteHead };
    });
  };
  const project = await deps.stores.projects.get(projectId);
  const orgConfig =
    project === undefined ? undefined : await deps.stores.orgConfigs.get(project.orgId);
  const repository = repositoryNameOf(record.repositoryUrl);
  const installation =
    repository === undefined
      ? undefined
      : installationGranting(orgConfig?.installations ?? [], repository);
  if (repository === undefined || installation === undefined) {
    await settle(
      "error",
      "the org has no GitHub installation granting the repository, or the line names no GitHub repository",
    );
    return "not_configured";
  }
  const { token } = await deps.github.writeToken(installation.installationId, repository);
  const authorization = installationAuthorization(token);
  const repositoryUrl = (deps.remoteUrlOf ?? cloneUrlOf)(record.repositoryUrl);
  const ref = `refs/heads/${branch}`;
  const current = (await remote.advertise(repositoryUrl, authorization)).get(ref) ?? ZERO_OID;

  if (current === push.head) {
    log(`line ${branch} already at ${current.slice(0, 12)}`);
    await settle("published", "already at GitHub");
    return "already_published";
  }
  // A line whose ref was never created is created here, by an absent-ref compare-and-swap;
  // a ref that vanished after the record had a head is someone else's doing and stays a conflict.
  const creating = current === ZERO_OID && record.head === undefined;
  if (!creating && current !== push.expectedPredecessor) {
    const detail = `the line is at ${current.slice(0, 12)}, not the ${push.expectedPredecessor.slice(0, 12)} the owner built on; someone else moved ${branch}`;
    log(`line ${branch}: conflict: ${detail}`);
    await settle("conflict", detail, current === ZERO_OID ? undefined : current);
    return "conflict";
  }
  const outcome = await remote.push({
    repositoryUrl,
    authorization,
    ref,
    expectedOld: creating ? ZERO_OID : push.expectedPredecessor,
    newOid: push.head,
    pack: await deps.bundles.get(push.bundleKey),
  });
  if (outcome.kind === "ok") {
    log(`line ${branch}: ${push.expectedPredecessor.slice(0, 12)} → ${push.head.slice(0, 12)}`);
    await settle("published", undefined);
    return "published";
  }
  const reason = outcome.kind === "rejected" ? outcome.reason : outcome.detail;
  // An absent-ref swap that the remote refuses means the ref now exists: someone else created it.
  const kind =
    outcome.kind !== "rejected"
      ? "error"
      : creating && /failed to update ref|already exists/i.test(reason)
        ? "conflict"
        : classify(reason);
  log(`line ${branch}: ${kind}: ${reason}`);
  if (kind === "conflict") {
    await settle("conflict", `the remote refused the lease: ${reason}`);
    return "conflict";
  }
  if (kind === "protected") {
    await settle("protected", `${branch} is protected: ${reason}`);
    return "protected";
  }
  if (kind === "forbidden") {
    await settle("forbidden", forbiddenDetail(branch, reason));
    return "forbidden";
  }
  const attempt = attemptOf(push) + 1;
  if (attempt >= PUBLISH_ATTEMPTS) {
    await settle("error", `attempt ${attempt} failed: ${reason}; giving up`);
    return "error";
  }
  // Retryable: still pending, with the attempt counted for the next invocation.
  await deps.stores.lines.update(projectId, branch, (latest) =>
    latest?.push === undefined || latest.push.head !== push.head
      ? undefined
      : {
          ...latest,
          push: { ...latest.push, detail: `attempt ${attempt} failed: ${reason}` },
          updatedAt: nowIso(deps.clock),
        },
  );
  return "retrying";
};
