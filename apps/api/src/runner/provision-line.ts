/**
 * Provisioning the line's owner machine (Pipkin M1b, J5): what the dispatch
 * Lambda does for a `{kind: "line"}` event and the reconciler does for a line
 * dispatch the event never reached.
 *
 * In order: claim the `requested` dispatch by compare-and-swap (only the winner
 * launches, so a duplicate delivery or the reconciler racing the Lambda makes
 * one machine); re-check the project's cap and the org's month, which spend may
 * have used up while the dispatch waited; keep within the org's concurrency; and
 * launch through the core a run shares, with an EC2 ClientToken derived from the
 * owner and generation so a retried launch is the same instance.
 */
import {
  COMPUTE_TIERS,
  DEFAULT_COMPUTE_CEILINGS,
  DispatchStatusSchema,
  type LineDispatch,
  type LineDispatchFailure,
  type OrgId,
  type ProjectId,
} from "@nightshift/contracts";
import {
  architectureOf,
  bootLeaseFrom,
  firstTokenParameterName,
  isDispatchTerminal,
  LINE_COMPOSITION_SECONDS,
  lineAdmission,
  nowIso,
  occupiesComputeSlot,
  transitionDispatch,
} from "@nightshift/core";
import { mintLineToken } from "../tokens/mint.js";
import { clearLineWaiting, failureCodeOf, lineCapUsd, recordLineWaiting } from "./line-support.js";
import { launchMachine, type ProvisionDeps } from "./provision.js";

export type LineProvisionOutcome =
  | { readonly kind: "provisioned"; readonly dispatch: LineDispatch }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "waiting"; readonly reason: "org_concurrency" }
  | { readonly kind: "failed"; readonly dispatch: LineDispatch; readonly reason: string };

/** A claimed dispatch that never got its machine is taken again after this long. */
export const LINE_CLAIM_STALE_MS = 2 * 60_000;

/** EC2's idempotency token for one generation of one owner's launch. */
export const lineClientToken = (dispatch: Pick<LineDispatch, "engineAgentId" | "generation">) =>
  `${dispatch.engineAgentId}-${dispatch.generation}`;

/** The tags a line machine carries, as the runner reads them from its metadata. */
export const lineMachineTags = (
  dispatch: LineDispatch,
  stage: string,
  apiEndpoint: string,
): Record<string, string> => ({
  "nightshift:managed": "true",
  "nightshift-kind": "line",
  "nightshift-project": dispatch.projectId,
  "nightshift-line": dispatch.branch,
  "nightshift-agent": dispatch.engineAgentId,
  "nightshift-generation": String(dispatch.generation),
  "nightshift-stage": stage,
  "nightshift-api": apiEndpoint,
  Name: `nightshift-${stage}-line-${dispatch.engineAgentId}`,
});

const target = (dispatch: Pick<LineDispatch, "projectId" | "branch">) => ({
  projectId: dispatch.projectId,
  branch: dispatch.branch,
});

/** Whether anything was ever made for the dispatch: a machine or a volume. */
const launchedAnything = (dispatch: LineDispatch): boolean =>
  dispatch.instanceId !== undefined ||
  dispatch.volumeId !== undefined ||
  dispatch.attempts.some((attempt) => attempt.instanceId !== undefined);

/**
 * Ends the claimed dispatch failed. Settled at once when nothing was ever
 * launched; otherwise cleanup terminates and deletes what there is, then settles.
 */
export const failLineDispatch = async (
  deps: Pick<ProvisionDeps, "stores" | "clock">,
  claimed: LineDispatch,
  failure: LineDispatchFailure,
): Promise<LineDispatch> => {
  const at = nowIso(deps.clock);
  const stored = await deps.stores.lineDispatches.update(
    claimed.projectId,
    claimed.branch,
    (current) => {
      if (current.generation !== claimed.generation || isDispatchTerminal(current.status)) {
        return undefined;
      }
      const last = current.attempts.length - 1;
      const failed = transitionDispatch(
        {
          ...current,
          failure,
          attempts: current.attempts.map((attempt, index) =>
            index === last && attempt.endedAt === undefined
              ? { ...attempt, endedAt: at, endReason: "failed" as const }
              : attempt,
          ),
        },
        "fail",
        at,
      );
      return launchedAnything(current)
        ? failed
        : { ...failed, cleanup: { ...failed.cleanup, settledAt: at } };
    },
  );
  return stored ?? claimed;
};

/** The org's live run dispatches, as `operations/dispatch.ts` counts them: every one not terminal. */
const liveRunsIn = async (deps: ProvisionDeps, orgId: OrgId): Promise<number> => {
  const live = await deps.stores.dispatches.listByStatus(
    DispatchStatusSchema.options.filter((status) => !isDispatchTerminal(status)),
  );
  const orgOf = new Map<ProjectId, OrgId | undefined>();
  let count = 0;
  for (const dispatch of live) {
    if (!orgOf.has(dispatch.projectId)) {
      orgOf.set(dispatch.projectId, (await deps.stores.projects.get(dispatch.projectId))?.orgId);
    }
    if (orgOf.get(dispatch.projectId) === orgId) count += 1;
  }
  return count;
};

/**
 * The org's line dispatches holding a slot, other than `self`. Two lines that
 * claimed at once and have no machine yet would each see the other and both
 * yield, so of those the later (by claim time, project, branch) is the only one
 * to count the earlier.
 */
const slotLinesIn = async (
  deps: ProvisionDeps,
  orgId: OrgId,
  self: LineDispatch,
): Promise<number> => {
  const lines = await deps.stores.lineDispatches.listByStatus(
    DispatchStatusSchema.options.filter(occupiesComputeSlot),
  );
  const orgOf = new Map<ProjectId, OrgId | undefined>();
  const key = (line: LineDispatch) => `${line.updatedAt}|${line.projectId}|${line.branch}`;
  let count = 0;
  for (const line of lines) {
    if (line.projectId === self.projectId && line.branch === self.branch) continue;
    if (!orgOf.has(line.projectId)) {
      orgOf.set(line.projectId, (await deps.stores.projects.get(line.projectId))?.orgId);
    }
    if (orgOf.get(line.projectId) !== orgId) continue;
    const unlaunched = line.status === "provisioning" && line.instanceId === undefined;
    if (unlaunched && key(line) > key(self)) continue;
    count += 1;
  }
  return count;
};

/**
 * Takes the dispatch for this caller: a `requested` one becomes a fresh
 * `provisioning` attempt (the compare-and-swap is the claim), and a
 * `provisioning` one with no machine for long enough is taken again. The
 * machine the record names is set here from the tier, so the record says what
 * will be launched.
 */
const claim = async (
  deps: ProvisionDeps,
  input: { readonly projectId: ProjectId; readonly branch: string },
): Promise<
  { readonly won: LineDispatch; readonly priorUpdatedAt: string } | { readonly skipped: string }
> => {
  const at = nowIso(deps.clock);
  let priorUpdatedAt = at;
  let took = false;
  let reason = "no dispatch for this line";
  const stored = await deps.stores.lineDispatches.update(
    input.projectId,
    input.branch,
    (current) => {
      took = false;
      const fresh = current.status === "requested";
      const stale =
        current.status === "provisioning" &&
        current.instanceId === undefined &&
        deps.clock.now() - Date.parse(current.updatedAt) > LINE_CLAIM_STALE_MS;
      if (!fresh && !stale) {
        reason = `dispatch is ${current.status}${current.instanceId === undefined ? " and claimed" : " with a machine"}`;
        return undefined;
      }
      took = true;
      priorUpdatedAt = current.updatedAt;
      const spec = COMPUTE_TIERS[current.tier];
      const named = {
        ...current,
        instanceType: spec.instanceType,
        usdPerHour: spec.usdPerHour,
        amiVersion: deps.imageVersion,
        spend: {
          ...current.spend,
          estimatedUsd:
            ((current.spend.ceilingSeconds ?? LINE_COMPOSITION_SECONDS) / 3600) * spec.usdPerHour,
        },
      };
      return fresh ? transitionDispatch(named, "provision", at) : { ...named, updatedAt: at };
    },
  );
  if (stored === undefined || !took) return { skipped: reason };
  return { won: stored, priorUpdatedAt };
};

/** Puts a claimed dispatch with no machine back to `requested`, as it was. */
const release = async (
  deps: ProvisionDeps,
  claimed: LineDispatch,
  priorUpdatedAt: string,
): Promise<void> => {
  await deps.stores.lineDispatches.update(claimed.projectId, claimed.branch, (current) =>
    current.generation === claimed.generation &&
    current.status === "provisioning" &&
    current.instanceId === undefined
      ? { ...current, status: "requested", updatedAt: priorUpdatedAt }
      : undefined,
  );
};

/**
 * Launches a dispatch this caller holds: provisioning, no machine yet. The
 * admission and concurrency checks come first, so the dispatch Lambda and the
 * reconciler's replacement path both hold to them.
 */
export const launchLineDispatch = async (
  deps: ProvisionDeps,
  claimed: LineDispatch,
  priorUpdatedAt: string = claimed.updatedAt,
): Promise<LineProvisionOutcome> => {
  const { stores } = deps;
  const line = target(claimed);
  const project = await stores.projects.get(claimed.projectId);
  if (project === undefined) {
    const reason = `project ${claimed.projectId} is not known to this control plane`;
    const failed = await failLineDispatch(deps, claimed, {
      code: "provisioning_failed",
      message: reason,
    });
    return { kind: "failed", dispatch: failed, reason };
  }

  // Spend may have reached the cap while the dispatch waited.
  const admission = await lineAdmission(deps, {
    ...line,
    capUsd: await lineCapUsd(stores, claimed.projectId, claimed.branch),
    orgId: project.orgId,
  });
  if (!admission.ok) {
    await recordLineWaiting(stores, deps.clock, line, {
      reason: admission.reason,
      detail: admission.detail,
    });
    const failed = await failLineDispatch(deps, claimed, {
      code: failureCodeOf(admission.reason) ?? "provisioning_failed",
      message: admission.detail,
    });
    return { kind: "failed", dispatch: failed, reason: admission.detail };
  }

  // Waiting requests hold no slot; the claim does, so it counts the others.
  const ceilings =
    (await stores.orgConfigs.get(project.orgId))?.compute ?? DEFAULT_COMPUTE_CEILINGS;
  const live =
    (await liveRunsIn(deps, project.orgId)) + (await slotLinesIn(deps, project.orgId, claimed));
  if (live >= ceilings.maxConcurrentRuns) {
    await release(deps, claimed, priorUpdatedAt);
    await recordLineWaiting(stores, deps.clock, line, {
      reason: "org_concurrency",
      detail: `${live} remote machine(s) are live; the org's ceiling is ${ceilings.maxConcurrentRuns}`,
    });
    return { kind: "waiting", reason: "org_concurrency" };
  }

  const parameter = firstTokenParameterName(deps.stage, claimed.engineAgentId, claimed.generation);
  const replacing = claimed.volumeId !== undefined && !claimed.cleanup.volumeDeleted;
  const launched = await launchMachine(deps, {
    label: `line ${claimed.projectId}/${claimed.branch}`,
    projectId: claimed.projectId,
    hashKey: claimed.engineAgentId,
    architecture: architectureOf(claimed.instanceType),
    instanceType: claimed.instanceType,
    tier: claimed.tier,
    tags: lineMachineTags(claimed, deps.stage, deps.apiEndpoint),
    workspace: claimed.workspace,
    clientToken: lineClientToken(claimed),
    replacing:
      replacing && claimed.volumeId !== undefined
        ? { volumeId: claimed.volumeId, availabilityZone: claimed.availabilityZone }
        : undefined,
    park: async () => {
      let token: string;
      try {
        token = (
          await mintLineToken(deps.signer, {
            dispatch: claimed,
            issuer: deps.issuer,
            now: deps.clock.now(),
          })
        ).token;
      } catch (error) {
        return `could not mint the first token: ${error instanceof Error ? error.message : String(error)}`;
      }
      await deps.tokens.put(parameter, token);
      return undefined;
    },
    unpark: () => deps.tokens.delete(parameter).catch(() => undefined),
  });
  if (!launched.ok) {
    const failed = await failLineDispatch(deps, claimed, {
      code: "provisioning_failed",
      message: launched.reason,
    });
    return { kind: "failed", dispatch: failed, reason: launched.reason };
  }

  const { instanceId, description } = launched;
  const at = nowIso(deps.clock);
  const stored = await stores.lineDispatches.update(claimed.projectId, claimed.branch, (current) =>
    current.generation === claimed.generation &&
    current.status === "provisioning" &&
    current.instanceId === undefined
      ? {
          ...current,
          instanceId,
          leaseExpiresAt: bootLeaseFrom(deps.clock.now()),
          ...(description?.availabilityZone === undefined
            ? {}
            : { availabilityZone: description.availabilityZone }),
          ...(description?.workspaceVolumeId === undefined
            ? {}
            : { volumeId: description.workspaceVolumeId }),
          amiVersion: deps.imageVersion,
          attempts: current.attempts.map((attempt) =>
            attempt.generation === current.generation ? { ...attempt, instanceId } : attempt,
          ),
          cleanup: { ...current.cleanup, volumeDeleted: false },
          updatedAt: at,
        }
      : undefined,
  );
  if (stored?.instanceId !== instanceId) {
    // The dispatch moved on (cancelled, replaced) while the machine was made:
    // nothing may run that the record does not name.
    await deps.compute.terminate(instanceId).catch(() => undefined);
    await deps.tokens.delete(parameter).catch(() => undefined);
    return { kind: "skipped", reason: "the dispatch changed while its machine was launched" };
  }
  await clearLineWaiting(stores, deps.clock, line);
  return { kind: "provisioned", dispatch: stored };
};

/**
 * `provisionLineDispatch` — claim the line's `requested` dispatch and launch
 * its machine. Anyone who does not win the claim returns skipped.
 */
export const provisionLineDispatch = async (
  deps: ProvisionDeps,
  input: { readonly projectId: ProjectId; readonly branch: string },
): Promise<LineProvisionOutcome> => {
  const claimed = await claim(deps, input);
  if ("skipped" in claimed) return { kind: "skipped", reason: claimed.skipped };
  return launchLineDispatch(deps, claimed.won, claimed.priorUpdatedAt);
};
