/**
 * Plan draft rules (P21 S-01). Pure: no clock, no I/O.
 *
 * `reconcilePlanDraftWrite` is what a draft becomes when a new version is
 * written; `applyPlanDraftAct` is what an owner's act does to it. Who may write
 * or act is the caller's concern (the API checks the principal); these rules
 * only keep the series honest: versions are written in order from the latest,
 * and a declined draft takes nothing more.
 */
import {
  type IsoTimestamp,
  MAX_PLAN_DRAFT_ACTS,
  type PlanDraft,
  type PlanDraftRecordedAct,
  type PlanDraftState,
  type Principal,
  type Sha256Hex,
} from "@nightshift/contracts";
import { PlanDraftError } from "../errors.js";
import type { ProgramScope } from "./ownership.js";

export interface PlanDraftWriteInput {
  readonly stored?: PlanDraft;
  readonly scope: ProgramScope;
  /** The version the writer started from; null when there is no draft yet. */
  readonly basedOn: number | null;
  readonly at: IsoTimestamp;
}

export interface PlanDraftWriteOutcome {
  /** The number the new version takes. */
  readonly version: number;
  /** The draft as it stands once that version is written. */
  readonly draft: PlanDraft;
}

/**
 * What the draft becomes when version `basedOn + 1` is written. Refused when the
 * draft is declined, when `basedOn` is not the latest version, and when `basedOn`
 * is non-null for a program with no draft. The state goes back to `draft`.
 */
export const reconcilePlanDraftWrite = (input: PlanDraftWriteInput): PlanDraftWriteOutcome => {
  const { stored, scope, basedOn, at } = input;
  if (stored === undefined) {
    if (basedOn !== null) {
      throw new PlanDraftError("no_draft", `there is no draft to base version ${basedOn + 1} on`);
    }
    return {
      version: 1,
      draft: {
        schemaVersion: 1,
        projectId: scope.projectId,
        programId: scope.programId,
        state: "draft",
        latestVersion: 1,
        acts: [],
        createdAt: at,
        updatedAt: at,
      },
    };
  }
  if (stored.state === "declined") {
    throw new PlanDraftError("declined", "the draft was declined; start a new program");
  }
  if (basedOn !== stored.latestVersion) {
    throw new PlanDraftError(
      "stale_base",
      `the write is based on ${basedOn === null ? "no version" : `version ${basedOn}`}, but the latest is ${stored.latestVersion}`,
    );
  }
  const version = stored.latestVersion + 1;
  return { version, draft: { ...stored, state: "draft", latestVersion: version, updatedAt: at } };
};

export type PlanDraftActKind = PlanDraftRecordedAct["kind"];

export interface PlanDraftActInput {
  readonly kind: PlanDraftActKind;
  /** The version the act names. */
  readonly version: number;
  readonly by: Principal;
  readonly note?: string;
  /** Required for `ratified`: the plan hash approved. */
  readonly planHash?: Sha256Hex;
  readonly at: IsoTimestamp;
}

const STATE_AFTER: Readonly<Record<PlanDraftActKind, PlanDraftState>> = {
  awaiting_owner: "awaiting_owner",
  changes_requested: "draft",
  declined: "declined",
  ratified: "ratified",
};

/**
 * What an act does to the draft: records it (keeping the newest
 * {@link MAX_PLAN_DRAFT_ACTS}) and moves the state. Refused on a declined draft,
 * on a version that is not the latest, and a ratification without its plan hash.
 */
export const applyPlanDraftAct = (draft: PlanDraft, act: PlanDraftActInput): PlanDraft => {
  if (draft.state === "declined") {
    throw new PlanDraftError("declined", `the draft was declined; ${act.kind} changes nothing`);
  }
  if (act.version !== draft.latestVersion) {
    throw new PlanDraftError(
      "not_latest_version",
      `${act.kind} names version ${act.version}, but the latest is ${draft.latestVersion}`,
    );
  }
  if (act.kind === "ratified" && act.planHash === undefined) {
    throw new PlanDraftError(
      "plan_hash_required",
      "a ratification names the plan hash it approves",
    );
  }
  const recorded: PlanDraftRecordedAct = {
    kind: act.kind,
    version: act.version,
    by: act.by,
    ...(act.note === undefined ? {} : { note: act.note }),
    ...(act.kind === "ratified" && act.planHash !== undefined ? { planHash: act.planHash } : {}),
    at: act.at,
  };
  return {
    ...draft,
    state: STATE_AFTER[act.kind],
    acts: [...draft.acts, recorded].slice(-MAX_PLAN_DRAFT_ACTS),
    updatedAt: act.at,
  };
};
