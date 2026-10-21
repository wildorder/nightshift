/**
 * Completion history rules (D-05). Pure: no clock, no I/O.
 *
 * Membership is named by a person and never inferred from program identity.
 * `buildCompletionHistory` is the client's proposal; `reconcileCompletionWrite`
 * is the server's rule, which checks the membership against the records it
 * holds and snapshots every new checkpoint itself.
 */
import {
  type CompletionCheckpoint,
  type CompletionHistory,
  type CompletionHistoryId,
  type CompletionMeasurement,
  type CompletionMemberRef,
  type CompletionRevision,
  type IsoTimestamp,
  MAX_COMPLETION_HISTORY_BYTES,
  MAX_COMPLETION_REVISIONS,
  type ProgramContract,
  type ProgramId,
  type Run,
  type RunFeedback,
  type RunId,
  type UserPrincipal,
} from "@nightshift/contracts";
import { CompletionMembershipError, StaleWriteError } from "../errors.js";
import { measureCompletion } from "../report/completion.js";
import type { InfrastructureReport } from "../report/infrastructure.js";
import type { ResourceTotals } from "../report/resources.js";
import type { RunScope } from "./ownership.js";

const keyOf = (ref: { readonly programId: string; readonly runId: string }): string =>
  `${ref.programId}/${ref.runId}`;

const refKey = (ref: CompletionMemberRef): string => `${keyOf(ref)}#${ref.role}`;

/** The serialized size the schema bounds, in UTF-8 bytes of the record's JSON. */
export const completionHistoryBytes = (history: CompletionHistory): number =>
  new TextEncoder().encode(JSON.stringify(history)).length;

/** The write's change to the membership, title and checkpoints, as one revision. */
const revisionOf = (
  stored: CompletionHistory | undefined,
  next: {
    readonly version: number;
    readonly title: string;
    readonly members: readonly CompletionMemberRef[];
  },
  actor: UserPrincipal,
  at: IsoTimestamp,
  checkpoint: string | undefined,
): CompletionRevision => {
  const before = new Set((stored?.members ?? []).map(refKey));
  const after = new Set(next.members.map(refKey));
  return {
    version: next.version,
    actor,
    recordedAt: at,
    added: next.members.filter((m) => !before.has(refKey(m))).map((m) => ({ ...m })),
    removed: (stored?.members ?? []).filter((m) => !after.has(refKey(m))).map((m) => ({ ...m })),
    ...(stored !== undefined && stored.title !== next.title ? { title: next.title } : {}),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
};

/** Drops the oldest revisions, never the newest, until the record is within the byte bound. */
const trimmed = (history: CompletionHistory): CompletionHistory => {
  let revisions = history.revisions.slice(-MAX_COMPLETION_REVISIONS);
  const fits = (): boolean =>
    completionHistoryBytes({ ...history, revisions }) <= MAX_COMPLETION_HISTORY_BYTES;
  while (revisions.length > 1 && !fits()) revisions = revisions.slice(1);
  return { ...history, revisions };
};

export interface BuildCompletionHistoryInput {
  readonly stored?: CompletionHistory;
  readonly scope: RunScope;
  readonly completionHistoryId: CompletionHistoryId;
  readonly title: string;
  readonly members: readonly CompletionMemberRef[];
  readonly actor: UserPrincipal;
  readonly at: IsoTimestamp;
  readonly checkpoint?: {
    readonly name: string;
    readonly programId: ProgramId;
    readonly runId: RunId;
  };
}

/**
 * A client's proposal. A checkpoint added here carries placeholders that the
 * server replaces with the verdict it actually holds.
 */
export const buildCompletionHistory = (input: BuildCompletionHistoryInput): CompletionHistory => {
  const { stored, scope, members, actor, at, checkpoint } = input;
  const version = stored === undefined ? 1 : stored.version + 1;
  const kept = stored?.checkpoints ?? [];
  const checkpoints: CompletionCheckpoint[] =
    checkpoint === undefined || kept.some((c) => c.name === checkpoint.name)
      ? [...kept]
      : [
          ...kept,
          {
            name: checkpoint.name,
            programId: checkpoint.programId,
            runId: checkpoint.runId,
            feedbackVersion: 1,
            verdictRecordedAt: at,
            members: [...members],
            membershipVersion: version,
            recordedBy: actor,
            recordedAt: at,
            measured: placeholderMeasurement(at, members.length),
          },
        ];
  return trimmed({
    schemaVersion: stored?.schemaVersion ?? 1,
    projectId: scope.projectId,
    programId: scope.programId,
    runId: scope.runId,
    completionHistoryId: input.completionHistoryId,
    title: input.title,
    version,
    members: [...members],
    checkpoints,
    revisions: [
      ...(stored?.revisions ?? []),
      revisionOf(stored, { version, title: input.title, members }, actor, at, checkpoint?.name),
    ],
    createdAt: stored?.createdAt ?? at,
    updatedAt: at,
  } as CompletionHistory);
};

/** What a client proposes for `measured`; the server replaces it. */
const placeholderMeasurement = (at: IsoTimestamp, members: number): CompletionMeasurement => ({
  measuredTo: at,
  readableMembers: members,
  activeSeconds: 0,
  recordedAt: at,
});

export type CompletionWriteOutcome = {
  readonly outcome: "stored" | "unchanged" | "replayed";
  readonly history: CompletionHistory;
};

export interface ReconcileCompletionInput {
  readonly stored?: CompletionHistory;
  readonly proposed: CompletionHistory;
  readonly actor: UserPrincipal;
  readonly at: IsoTimestamp;
  /** The project's runs, keyed `${programId}/${runId}`. */
  readonly memberRuns: ReadonlyMap<string, Run>;
  /** Current feedback, keyed likewise. */
  readonly feedbackOf: ReadonlyMap<string, RunFeedback>;
  /** Model figures per member run, keyed likewise; absent figures are absent, not zero. */
  readonly resources?: ReadonlyMap<string, ResourceTotals>;
  readonly infrastructure?: ReadonlyMap<string, InfrastructureReport>;
}

const sameMembers = (
  a: readonly CompletionMemberRef[],
  b: readonly CompletionMemberRef[],
): boolean =>
  a.length === b.length &&
  a.every((m, i) => {
    const other = b[i];
    return other !== undefined && keyOf(m) === keyOf(other) && m.role === other.role;
  });

const lastActorOf = (history: CompletionHistory): UserPrincipal | undefined =>
  history.revisions[history.revisions.length - 1]?.actor;

/** Throws {@link CompletionMembershipError} unless the members are a sound membership. */
const assertMembership = (
  scope: RunScope,
  members: readonly CompletionMemberRef[],
  memberRuns: ReadonlyMap<string, Run>,
): void => {
  const seen = new Set<string>();
  for (const member of members) {
    const key = keyOf(member);
    if (seen.has(key)) throw new CompletionMembershipError(member, "duplicate");
    seen.add(key);
  }
  const anchors = members.filter((m) => m.role === "anchor");
  const anchor = anchors[0];
  if (
    anchors.length !== 1 ||
    anchor === undefined ||
    anchor.programId !== scope.programId ||
    anchor.runId !== scope.runId
  ) {
    throw new CompletionMembershipError(
      anchors.find((m) => m.programId !== scope.programId || m.runId !== scope.runId) ??
        anchors[1] ?? { programId: scope.programId, runId: scope.runId },
      "anchor_mismatch",
    );
  }
  for (const member of members) {
    if (!memberRuns.has(keyOf(member))) throw new CompletionMembershipError(member, "unknown_run");
  }
};

export const reconcileCompletionWrite = (
  input: ReconcileCompletionInput,
): CompletionWriteOutcome => {
  const { stored, proposed, actor, at, memberRuns, feedbackOf, resources, infrastructure } = input;
  const scope: RunScope = {
    projectId: stored?.projectId ?? proposed.projectId,
    programId: stored?.programId ?? proposed.programId,
    runId: stored?.runId ?? proposed.runId,
  };
  const stale = (): never => {
    throw new StaleWriteError("completion history", proposed.version - 1, stored?.version ?? 0);
  };
  const storedCheckpoints = stored?.checkpoints ?? [];
  const isNew = (c: CompletionCheckpoint): boolean =>
    !storedCheckpoints.some((s) => s.name === c.name);

  if (stored === undefined) {
    if (proposed.version !== 1) stale();
  } else if (proposed.version === stored.version) {
    const sameContent =
      proposed.title === stored.title &&
      sameMembers(proposed.members, stored.members) &&
      !proposed.checkpoints.some(isNew) &&
      proposed.checkpoints.length === stored.checkpoints.length;
    if (sameContent && lastActorOf(stored)?.userId === actor.userId) {
      return { outcome: "replayed", history: stored };
    }
    stale();
  } else if (proposed.version !== stored.version + 1) {
    stale();
  }

  const version = stored === undefined ? 1 : stored.version + 1;
  assertMembership(scope, proposed.members, memberRuns);

  for (const kept of storedCheckpoints) {
    const now = proposed.checkpoints.find((c) => c.name === kept.name);
    if (now === undefined || JSON.stringify(now) !== JSON.stringify(kept)) {
      throw new CompletionMembershipError(kept, "checkpoint_immutable");
    }
  }

  const snapshots: CompletionCheckpoint[] = [];
  const memberKeys = new Set(proposed.members.map(keyOf));
  for (const wanted of proposed.checkpoints.filter(isNew)) {
    if (!memberKeys.has(keyOf(wanted))) {
      throw new CompletionMembershipError(wanted, "checkpoint_not_member");
    }
    const feedback = feedbackOf.get(keyOf(wanted));
    if (feedback === undefined || feedback.verdict !== "worked") {
      throw new CompletionMembershipError(wanted, "checkpoint_not_positive");
    }
    snapshots.push({
      name: wanted.name,
      programId: wanted.programId,
      runId: wanted.runId,
      feedbackVersion: feedback.version,
      verdictRecordedAt: feedback.recordedAt,
      members: proposed.members.map((m) => ({ ...m })),
      membershipVersion: version,
      recordedBy: actor,
      recordedAt: at,
      measured: {
        ...measureCompletion({
          members: proposed.members,
          runs: memberRuns,
          feedback: feedbackOf,
          ...(resources === undefined ? {} : { resources }),
          ...(infrastructure === undefined ? {} : { infrastructure }),
          accepted: { ref: wanted, verdictAt: feedback.recordedAt },
          boundary: feedback.recordedAt,
        }),
        recordedAt: at,
      },
    });
  }

  if (
    stored !== undefined &&
    snapshots.length === 0 &&
    proposed.title === stored.title &&
    sameMembers(proposed.members, stored.members)
  ) {
    return { outcome: "unchanged", history: stored };
  }

  const members = proposed.members.map((m) => ({ ...m }));
  const history = trimmed({
    schemaVersion: stored?.schemaVersion ?? proposed.schemaVersion,
    ...scope,
    completionHistoryId: stored?.completionHistoryId ?? proposed.completionHistoryId,
    title: proposed.title,
    version,
    members,
    checkpoints: [...storedCheckpoints, ...snapshots],
    revisions: [
      ...(stored?.revisions ?? []),
      revisionOf(
        stored,
        { version, title: proposed.title, members },
        actor,
        at,
        snapshots[0]?.name,
      ),
    ],
    createdAt: stored?.createdAt ?? at,
    updatedAt: at,
  } as CompletionHistory);
  return { outcome: "stored", history };
};

export interface CompletionSuggestion {
  readonly programId: ProgramId;
  readonly runId: RunId;
  readonly role: "contributing" | "correction";
  readonly reason: "carried_strand" | "corrects_member" | "corrected_by_member";
  readonly detail: string;
}

export interface SuggestCompletionMembersInput {
  readonly history: CompletionHistory;
  readonly anchorRun: Run;
  readonly programs: readonly ProgramContract[];
  readonly runs: readonly Run[];
}

/**
 * Runs a person may want to add, each with the recorded fact that points at it.
 * Sharing a program with a member is never such a fact. Only the history's own
 * project is considered, and current members are not suggested.
 */
export const suggestCompletionMembers = (
  input: SuggestCompletionMembersInput,
): readonly CompletionSuggestion[] => {
  const { history, anchorRun } = input;
  const runs = input.runs.filter((r) => r.projectId === history.projectId);
  const programs = input.programs.filter((p) => p.projectId === history.projectId);
  const byKey = new Map(runs.map((r) => [keyOf(r), r]));
  if (anchorRun.projectId === history.projectId) byKey.set(keyOf(anchorRun), anchorRun);
  const memberKeys = new Set(history.members.map(keyOf));
  const memberRuns = history.members.flatMap((m) => {
    const run = byKey.get(keyOf(m));
    return run === undefined ? [] : [run];
  });
  const out = new Map<string, CompletionSuggestion>();
  const add = (suggestion: CompletionSuggestion): void => {
    const key = keyOf(suggestion);
    if (memberKeys.has(key) || out.has(key)) return;
    out.set(key, suggestion);
  };

  for (const member of memberRuns) {
    for (const carried of member.carriedStrands ?? []) {
      const from = byKey.get(`${member.programId}/${carried.fromRunId}`);
      if (from === undefined) continue;
      add({
        programId: from.programId,
        runId: from.runId,
        role: "contributing",
        reason: "carried_strand",
        detail: `built strand ${carried.strandId}, which ${keyOf(member)} carried`,
      });
    }
  }
  for (const program of programs) {
    const hit = (program.corrects ?? []).find((target) => memberKeys.has(keyOf(target)));
    if (hit === undefined) continue;
    for (const run of runs) {
      if (run.programId !== program.programId) continue;
      add({
        programId: run.programId,
        runId: run.runId,
        role: "correction",
        reason: "corrects_member",
        detail: `program ${program.programId} corrects decision ${hit.decisionId} in ${keyOf(hit)}`,
      });
    }
  }
  for (const member of memberRuns) {
    const program = programs.find((p) => p.programId === member.programId);
    for (const target of program?.corrects ?? []) {
      const run = byKey.get(keyOf(target));
      if (run === undefined) continue;
      add({
        programId: run.programId,
        runId: run.runId,
        role: "contributing",
        reason: "corrected_by_member",
        detail: `program ${member.programId} of ${keyOf(member)} corrects decision ${target.decisionId} in this run`,
      });
    }
  }
  return [...out.values()];
};
