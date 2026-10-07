/**
 * The one place a request's authorisation is decided (D-P4-02, D-P4-05, A-34).
 *
 * `handleRequest` calls this once, before it dispatches to any operation, and no
 * operation checks anything itself. SC-P4-08 is the claim that this is the only
 * caller of `authorize`, and it is kept true by there being exactly one call
 * site in the repository.
 *
 * What happens here, in order:
 *
 * 1. The route names an `Operation`, and the path names as much of the ownership
 *    chain as it carries.
 * 2. For a **user token**, the acting org is resolved (D-P2-13) and the target
 *    project's owning org is read through a per-instance cache. A mismatch is a
 *    403 **before the operation runs**, so no record is read and no existence is
 *    revealed.
 * 3. For an **execution principal**, `authorize` in `core` decides against the
 *    §4.4 table. No store is touched at all: an execution's reach is its own
 *    chain, which is in its token.
 *
 * Nothing here verifies a token. The authorizer did that (A-36), and a signature
 * check in this file would mean the design had drifted.
 */
import type { OrgId, Principal, ProjectId } from "@nightshift/contracts";
import {
  type AuthorizationTarget,
  authorize,
  type Clock,
  type DispatchStore,
  type ExecutionNodeStore,
  type MembershipStore,
  type NodeRelation,
  type Operation,
  type ProjectStore,
  READ_OPERATIONS,
} from "@nightshift/core";
import { HttpError } from "../http.js";
import type { PathParams } from "../params.js";
import { describeRefusal, resolveActingOrg } from "./acting-org.js";
import { isUserToken, type RequestPrincipal } from "./principal.js";

/**
 * A project's owning organisation, cached per function instance.
 *
 * A project's org is immutable (P2: the stores refuse a move, and `putProject`
 * answers 403 rather than rewriting one), so a cached entry can never become
 * *wrong* — only old, and an old entry for an immutable value is the same value.
 *
 * **Misses are deliberately not cached.** Caching "no such project" would leave
 * a window in which a project created in org A is invisible to this check, and
 * every caller — including one in org B — would sail past `enforce` and have the
 * operation read the record for them. A miss costs one read and then the
 * operation reads anyway, so there is nothing to save and a boundary to lose.
 */
export interface ProjectOrgCache {
  orgOf(projectId: ProjectId): Promise<OrgId | undefined>;
}

/**
 * Minutes, not hours. Long enough that a burst of requests against one project
 * is one read, short enough that replacing a project (which means deleting and
 * recreating it, since its org cannot move) is not remembered for a working day.
 */
export const DEFAULT_PROJECT_ORG_TTL_MS = 5 * 60 * 1000;

export interface ProjectOrgCacheOptions {
  readonly projects: ProjectStore;
  readonly clock: Clock;
  readonly ttlMs?: number;
}

export const createProjectOrgCache = (options: ProjectOrgCacheOptions): ProjectOrgCache => {
  const ttlMs = options.ttlMs ?? DEFAULT_PROJECT_ORG_TTL_MS;
  const entries = new Map<ProjectId, { readonly orgId: OrgId; readonly expiresAt: number }>();

  return {
    async orgOf(projectId) {
      const cached = entries.get(projectId);
      if (cached !== undefined && cached.expiresAt > options.clock.now()) return cached.orgId;

      const project = await options.projects.get(projectId);
      if (project === undefined) {
        // Not cached. See the note above: a cached miss is a hole, not a saving.
        entries.delete(projectId);
        return undefined;
      }
      entries.set(projectId, { orgId: project.orgId, expiresAt: options.clock.now() + ttlMs });
      return project.orgId;
    },
  };
};

/**
 * The ownership chain the request carries, read leniently: absent segments stay
 * absent, and nothing is validated here — `authorize` compares strings, and the
 * operation validates properly once it runs.
 *
 * ## Why the body is consulted for the node
 *
 * Two of the three writes an execution may make name their node in the **body**
 * rather than the path: `POST …/runs/{runId}/events` and
 * `PUT …/runs/{runId}/decisions/{decisionId}` both hang off the run, and the
 * node they act on is a field of the record. Reading only the path would leave
 * `nodeId` absent, and an `own_node` operation with no node is refused — so a
 * worker could not report its own progress.
 *
 * The alternative was to let those two routes check the body themselves, which
 * would put an authorisation decision outside this function and cost SC-P4-08
 * its meaning. So the path wins where it names a node, and the body's
 * `executionNodeId` fills in where it does not.
 *
 * This is not a time-of-check problem: the field read here is the same field the
 * operation parses and stores, on the same object.
 *
 * ## And for the status, on `node.put`
 *
 * `authorize` refuses an execution any requested node status but `implemented`
 * and `failed` (see `EXECUTION_WRITABLE_NODE_STATUSES` in `core`). The status is
 * a field of the body, so it is read here by the same reasoning and for the same
 * route only: every other record that happens to carry a `status` is a record an
 * execution may not write at all.
 */
export const targetFrom = (params: PathParams, body: unknown): AuthorizationTarget => {
  const target: {
    orgId?: string;
    projectId?: string;
    programId?: string;
    runId?: string;
    nodeId?: string;
    agentId?: string;
  } = {};
  // P8: `/orgs/{orgId}/…` names the org itself, and `authorize` holds it to the
  // caller's acting org as it does a project's owner.
  if (params.orgId !== undefined) target.orgId = params.orgId;
  if (params.projectId !== undefined) target.projectId = params.projectId;
  if (params.programId !== undefined) target.programId = params.programId;
  if (params.runId !== undefined) target.runId = params.runId;
  if (params.agentId !== undefined) target.agentId = params.agentId;

  const fromBody =
    body !== null && typeof body === "object"
      ? (body as { executionNodeId?: unknown }).executionNodeId
      : undefined;
  const nodeId = params.nodeId ?? (typeof fromBody === "string" ? fromBody : undefined);
  if (nodeId !== undefined) target.nodeId = nodeId;

  return target as AuthorizationTarget;
};

export interface EnforceOptions {
  readonly principal: RequestPrincipal;
  readonly operation: Operation;
  readonly params: PathParams;
  /** The parsed request body, for the two routes that name their node in it. */
  readonly body: unknown;
  readonly memberships: MembershipStore;
  readonly projectOrgs: ProjectOrgCache;
  /** The run's nodes, read only to place a target in an orchestrator's subtree. */
  readonly nodes: Pick<ExecutionNodeStore, "get">;
  /**
   * The run's dispatch, read only to hold an engine's write to the current
   * generation (P10, D-P10-18). A **stored fact**, like a node's ancestry: the
   * token says which generation it was minted under, the record says which is
   * current, and `authorize` compares the two.
   */
  readonly dispatches: Pick<DispatchStore, "get">;
}

/** How far up a parent chain is followed before the answer is "outside". */
const MAX_ANCESTRY_STEPS = 64;

/**
 * Where the target node stands relative to an orchestrator execution's own node
 * (P6, D-P6-04), **from the stored tree and never from the request**.
 *
 * The one thing taken from the body is the parent of a node that does not exist
 * yet, and it is only ever compared for equality with the token's own node: a
 * request can claim to be creating a child of the caller, and the operation then
 * validates that claim against the stored parent like any other creation.
 *
 * Walks the parent chain rather than reading the whole run: a tree is a few
 * levels deep, and the common answers (`self`, a direct child) take no read or
 * one.
 */
export const resolveNodeRelation = async (
  principal: Extract<Principal, { kind: "execution" }>,
  target: AuthorizationTarget,
  body: unknown,
  nodes: Pick<ExecutionNodeStore, "get">,
): Promise<NodeRelation> => {
  const { nodeId } = target;
  if (nodeId === undefined) return "outside";
  if (nodeId === principal.nodeId) return "self";

  const scope = {
    projectId: principal.projectId,
    programId: principal.programId,
    runId: principal.runId,
  };
  let current = await nodes.get(scope, nodeId);
  if (current === undefined) {
    const parent =
      body !== null && typeof body === "object"
        ? (body as { parentNodeId?: unknown }).parentNodeId
        : undefined;
    return parent === principal.nodeId ? "new_child" : "outside";
  }
  for (let step = 0; step < MAX_ANCESTRY_STEPS; step += 1) {
    const parentId = current.parentNodeId;
    if (parentId === null) return "outside";
    if (parentId === principal.nodeId) return "descendant";
    const parent = await nodes.get(scope, parentId);
    if (parent === undefined) return "outside";
    current = parent;
  }
  return "outside";
};

/**
 * The complete principal the operation runs as.
 *
 * Returned rather than discarded because two operations need the acting org
 * itself: `putProject` assigns it, and `listProjects` filters by it. Every other
 * operation only needed the check, which has already happened by the time this
 * returns.
 */
/** The status a `node.put` body asks for, or `undefined` when it names none. */
export const requestedNodeStatusFrom = (body: unknown): string | undefined => {
  const status =
    body !== null && typeof body === "object" ? (body as { status?: unknown }).status : undefined;
  return typeof status === "string" ? status : undefined;
};

export const enforce = async (options: EnforceOptions): Promise<Principal> => {
  const { principal, operation, params } = options;
  const requested = operation === "node.put" ? requestedNodeStatusFrom(options.body) : undefined;
  const target: AuthorizationTarget = {
    ...targetFrom(params, options.body),
    ...(requested === undefined ? {} : { requestedNodeStatus: requested }),
  };

  if (!isUserToken(principal)) {
    // Only an orchestrator's table has a reach that depends on the tree, and
    // only a request inside its own run is worth a read to place. Likewise only
    // an engine's writes are held to a generation, and only its own run's
    // dispatch says which is current. A path above every run (P15's
    // `…/gate-health`) names no run, so the engine's own is the one it writes
    // under.
    let placed: AuthorizationTarget = target;
    if (principal.role === "orchestrator" && target.runId === principal.runId) {
      placed = {
        ...target,
        nodeRelation: await resolveNodeRelation(principal, target, options.body, options.nodes),
      };
    } else if (
      principal.role === "engine" &&
      (target.runId ?? principal.runId) === principal.runId &&
      !READ_OPERATIONS.has(operation)
    ) {
      const dispatch = await options.dispatches.get({
        projectId: principal.projectId,
        programId: principal.programId,
        runId: principal.runId,
      });
      placed =
        dispatch === undefined ? target : { ...target, currentGeneration: dispatch.generation };
    }
    const decision = authorize(principal, operation, placed);
    if (!decision.allowed) throw new HttpError(403, decision.reason, decision.detail);
    return principal;
  }

  const acting = await resolveActingOrg(principal, options.memberships);
  if (!acting.ok) throw new HttpError(403, acting.reason, describeRefusal(acting.reason));
  const user: Principal = { kind: "user", userId: acting.userId, orgId: acting.orgId };

  // The project's owner, before anything reads the project itself. A path that
  // names no project (`GET /projects`, `PUT /projects/{id}` for a project that
  // does not exist yet) has no org to be wrong about, and `authorize` allows it:
  // listing filters by the acting org and creation assigns it.
  const projectId = target.projectId;
  const owner = projectId === undefined ? undefined : await options.projectOrgs.orgOf(projectId);
  const decision = authorize(
    user,
    operation,
    owner === undefined ? target : { ...target, orgId: owner },
  );
  if (!decision.allowed) throw new HttpError(403, decision.reason, decision.detail);
  return user;
};
