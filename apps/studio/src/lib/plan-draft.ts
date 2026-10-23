/**
 * What the plan page derives from a draft's versions (P21): pure, no I/O.
 *
 * A contract document is parsed here, the answer to each planned decision is
 * attributed to the principal who gave it, and a version is compared with its
 * predecessor. Nothing here changes a draft.
 */
import {
  type PlanDraftAct,
  type PlanDraftVersion,
  type PlannedDecision,
  type Principal,
  type ProgramContract,
  ProgramContractSchema,
} from "@nightshift/contracts";

export type ParsedContract =
  | { readonly ok: true; readonly contract: ProgramContract }
  | { readonly ok: false; readonly reason: string };

/** A contract document's text, as a contract, or why it is not one. */
export const parseContract = (text: string): ParsedContract => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `not JSON: ${error instanceof Error ? error.message : error}` };
  }
  const parsed = ProgramContractSchema.safeParse(json);
  if (parsed.success) return { ok: true, contract: parsed.data };
  return {
    ok: false,
    reason: parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
  };
};

/** A short name for whoever is recorded as an author or actor. */
export const principalLabel = (principal: Principal): string =>
  principal.kind === "user" ? principal.userId : principal.kind;

export type AnswerSource =
  /** An `answer` act on a version. */
  | { readonly how: "answered"; readonly by: Principal; readonly version: number }
  /** The answer arrived inside a written contract. */
  | { readonly how: "written"; readonly by: Principal; readonly version: number };

export interface DecisionAnswer {
  readonly decision: PlannedDecision;
  /** Absent when the decision is unanswered. */
  readonly source?: AnswerSource;
}

/**
 * Each planned decision of the latest contract with who answered it: the author
 * of the newest version whose act answers it; failing that, the author of the
 * earliest version whose contract carries the answer; otherwise nobody.
 *
 * `contracts` maps a version number to its parsed contract (unparseable or
 * missing ones are simply not consulted).
 */
export const decisionAnswers = (
  latest: ProgramContract,
  versions: readonly PlanDraftVersion[],
  contracts: ReadonlyMap<number, ParsedContract>,
): readonly DecisionAnswer[] =>
  (latest.decisions ?? []).map((decision): DecisionAnswer => {
    if (decision.answer === undefined) return { decision };
    const answering = versions
      .filter((v) => v.act.kind === "answer" && v.act.decisionId === decision.id)
      .sort((a, b) => b.version - a.version)[0];
    if (answering !== undefined) {
      return {
        decision,
        source: { how: "answered", by: answering.author, version: answering.version },
      };
    }
    const written = versions
      .filter((v) => {
        const parsed = contracts.get(v.version);
        const found =
          parsed?.ok === true
            ? parsed.contract.decisions?.find((d) => d.id === decision.id)
            : undefined;
        return found?.answer !== undefined;
      })
      .sort((a, b) => a.version - b.version)[0];
    return written === undefined
      ? { decision }
      : { decision, source: { how: "written", by: written.author, version: written.version } };
  });

export interface IdChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface VersionChanges {
  readonly act: PlanDraftAct;
  readonly planChanged: boolean;
  readonly conversationChanged: boolean;
  /** Absent when either contract could not be parsed. */
  readonly contract:
    | {
        readonly stories: IdChanges;
        readonly strands: IdChanges;
        readonly decisions: IdChanges;
        readonly prerequisites: IdChanges;
      }
    | { readonly unparseable: string };
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

const byId = <T extends { readonly id: string }>(
  before: readonly T[] | undefined,
  after: readonly T[] | undefined,
): IdChanges => {
  const was = new Map((before ?? []).map((item) => [item.id, item]));
  const is = new Map((after ?? []).map((item) => [item.id, item]));
  return {
    added: [...is.keys()].filter((id) => !was.has(id)),
    removed: [...was.keys()].filter((id) => !is.has(id)),
    changed: [...is.keys()].filter((id) => {
      const old = was.get(id);
      return old !== undefined && stable(old) !== stable(is.get(id));
    }),
  };
};

export const noIdChanges = (changes: IdChanges): boolean =>
  changes.added.length + changes.removed.length + changes.changed.length === 0;

/** What `version` changed from `previous`. */
export const versionChanges = (
  version: PlanDraftVersion,
  previous: PlanDraftVersion,
  now: ParsedContract | undefined,
  before: ParsedContract | undefined,
): VersionChanges => {
  const base = {
    act: version.act,
    planChanged: version.plan.sha256 !== previous.plan.sha256,
    conversationChanged: version.conversation?.sha256 !== previous.conversation?.sha256,
  };
  if (now?.ok !== true || before?.ok !== true) {
    const why =
      now === undefined || before === undefined
        ? "a contract document could not be retrieved"
        : now.ok
          ? `version ${previous.version}'s contract could not be parsed: ${(before as { reason: string }).reason}`
          : `its contract could not be parsed: ${now.reason}`;
    return { ...base, contract: { unparseable: why } };
  }
  const a = before.contract;
  const b = now.contract;
  return {
    ...base,
    contract: {
      stories: byId(a.stories, b.stories),
      strands: byId(a.strands, b.strands),
      decisions: byId(a.decisions, b.decisions),
      prerequisites: byId(a.prerequisites, b.prerequisites),
    },
  };
};

/** The act, in words. */
export const describeAct = (act: PlanDraftAct): string =>
  act.kind === "write" ? "write" : `answer of decision ${act.decisionId}`;
