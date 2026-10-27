/**
 * Starts the line's owner when there is work and nothing is live (Pipkin M1b).
 */
import type { LineRecord, ProjectId } from "@nightshift/contracts";
import type { IdGenerator } from "../ids.js";
import type { ProjectStores } from "../ports/stores.js";
import { type LineMachineSpec, newLineDispatch } from "../rules/line.js";
import type { Clock } from "../time.js";
import { type LineAdmissionStores, lineAdmission } from "./admission.js";

/**
 * The machine asked for until provisioning chooses one. The record needs a
 * tier, a type, a price and an image, and the plane knows none of them before
 * it provisions (J5), which overwrites these.
 */
export const UNPROVISIONED_LINE_MACHINE: LineMachineSpec = {
  tier: "good",
  instanceType: "unprovisioned",
  usdPerHour: 1,
  amiVersion: "unprovisioned",
};

export type LineStartStores = LineAdmissionStores &
  Pick<ProjectStores, "lines" | "lineDispatches" | "projects">;

export interface EnsureLineDispatchDeps {
  readonly stores: LineStartStores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Brings the machine up for a dispatch just stored `requested`. */
  readonly startMachine: (target: {
    readonly projectId: ProjectId;
    readonly branch: string;
  }) => Promise<void>;
}

export type EnsureLineDispatchResult =
  | { readonly kind: "started" }
  | { readonly kind: "live" }
  | { readonly kind: "waiting"; readonly reason: NonNullable<LineRecord["waiting"]>["reason"] };

export const ensureLineDispatch = async (
  { stores, clock, ids, startMachine }: EnsureLineDispatchDeps,
  input: {
    readonly projectId: ProjectId;
    readonly branch: string;
    readonly capUsd: number;
    readonly machine?: LineMachineSpec;
  },
): Promise<EnsureLineDispatchResult> => {
  const { projectId, branch } = input;
  const at = new Date(clock.now()).toISOString();
  const project = await stores.projects.get(projectId);
  const admission =
    project === undefined
      ? ({
          ok: false,
          reason: "not_configured",
          detail: `project ${projectId} is not known to this control plane`,
        } as const)
      : await lineAdmission({ stores, clock }, { ...input, orgId: project.orgId });
  if (!admission.ok) {
    await stores.lines.update(projectId, branch, (current) => {
      if (current === undefined) return undefined;
      const since = current.waiting?.reason === admission.reason ? current.waiting.since : at;
      if (
        current.waiting?.reason === admission.reason &&
        current.waiting.detail === admission.detail
      ) {
        return undefined;
      }
      return {
        ...current,
        waiting: { reason: admission.reason, detail: admission.detail, since },
        updatedAt: at,
      };
    });
    return { kind: "waiting", reason: admission.reason };
  }
  const previous = await stores.lineDispatches.get(projectId, branch);
  const next = newLineDispatch({
    projectId,
    branch,
    previous,
    engineAgentId: ids.next("agent"),
    machine: input.machine ?? UNPROVISIONED_LINE_MACHINE,
    at,
  });
  if ((await stores.lineDispatches.start(next)) === "live") return { kind: "live" };
  await stores.lines.update(projectId, branch, (current) => {
    if (current?.waiting === undefined) return undefined;
    const { waiting: _cleared, ...rest } = current;
    return { ...rest, updatedAt: at };
  });
  await startMachine({ projectId, branch });
  return { kind: "started" };
};
