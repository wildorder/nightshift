/**
 * Who may do what (P4 §4.4; D-P4-01, D-P4-05, A-33, A-34, A-35).
 *
 * One pure function over a closed operation list. Not a permission language:
 * there are two principal kinds and a fixed set of operations, which is what
 * makes "a worker can do exactly four things" an exhaustive unit test rather
 * than an audit.
 *
 * The API calls this in exactly one place, before dispatching to an operation
 * (SC-P4-08). Nothing here reads anything: the caller supplies the target's
 * ownership chain, and for a user principal the target's owning organisation,
 * which it resolves through a cache.
 *
 * ## How D-P4-05 is read
 *
 * > an execution may read its own run, and write only its own node's progress,
 * > completion, failure and decisions, plus the events those produce. An
 * > execution cannot create a node, an agent, a run, a verification, a
 * > checkpoint or a routing decision, and cannot read another run.
 *
 * So: reads of run-scoped records inside the execution's own run are allowed;
 * reads of a *node's* records are narrowed further to its own node; `project`
 * and `program` sit above the run and are not readable at all; and exactly
 * three writes are allowed — its node, its events, its decisions. Every other
 * operation is forbidden outright, for any target, including minting a token.
 *
 * Widening the read side beyond what D-P4-05 grants would be settling a ratified
 * decision; narrowing the write side below it would break the slice. The table
 * below is the decision, not an interpretation of it.
 *
 * ## An allowed operation is not an allowed *content*
 *
 * `node.put` is one route and fifteen statuses. D-P4-05 grants a worker its
 * node's *completion* and *failure*, which are two of them. The table alone
 * cannot say that, because it is keyed by operation, so `authorize` also takes
 * the status the request asks for and refuses an execution anything but
 * {@link EXECUTION_WRITABLE_NODE_STATUSES}. Without it, a worker's token could
 * move its own node to `verifying`, `cancelled`, `interrupted` or back to
 * `queued`: never to `verified`, which needs a `Verification` it cannot write
 * (A-05 held), but far enough to wedge its own job and to make the record say
 * Nightshift did something a worker did. Found in review after P4 merged; the
 * operation matrix had 260 cells and none of them asked what a permitted
 * operation may contain.
 */
import type {
  AgentId,
  ExecutionNodeId,
  ExecutionNodeStatus,
  ExecutionRole,
  OrgId,
  Principal,
  ProgramId,
  ProjectId,
  RunId,
} from "@nightshift/contracts";

/**
 * Every operation the API serves, one per route.
 *
 * `apps/api` holds the reverse test: every route names an `Operation`, and the
 * route table is total over this union (T3). `core` cannot import `apps/api`, so
 * the two halves meet there.
 */
export type Operation =
  // Projects and programs.
  | "project.list"
  | "project.put"
  | "project.get"
  | "program.list"
  | "program.put"
  | "program.get"
  // Planning (P7): ratification, the plan document, human prerequisites.
  | "program.ratify"
  | "program.createPlanUploadUrl"
  | "program.getPlanDocument"
  | "prerequisite.list"
  | "prerequisite.put"
  // Runs.
  | "run.list"
  | "run.put"
  | "run.get"
  | "run.getState"
  // Execution nodes.
  | "node.list"
  | "node.put"
  | "node.get"
  | "node.listChildren"
  // Job Contracts.
  | "job.list"
  | "job.put"
  | "job.get"
  // Agents, and the execution tokens minted for them.
  | "agent.put"
  | "agent.get"
  | "agent.listByNode"
  | "agent.mintToken"
  // Events.
  | "event.append"
  | "event.list"
  // Decisions and checkpoints.
  | "decision.list"
  | "decision.put"
  | "decision.get"
  | "checkpoint.list"
  | "checkpoint.put"
  | "checkpoint.get"
  // Verification and examination.
  | "verification.put"
  | "verification.get"
  | "verification.listByNode"
  | "examination.put"
  | "examination.get"
  | "examination.listByNode"
  // Routing.
  | "routingDecision.put"
  | "routingDecision.listByNode"
  // Artifacts.
  | "artifact.list"
  | "artifact.put"
  | "artifact.get"
  | "artifact.createUploadUrl";

/**
 * How far an execution principal reaches for one operation.
 *
 * - `forbidden` — never, whatever the target. Every write that is not one of the
 *   three a worker makes, and every read above the run.
 * - `own_program` — allowed when the target is the program the execution's run
 *   belongs to. The one reach above the run, for the one thing an execution
 *   needs from there: which human prerequisites are still unmet (P7, D-P7-10).
 * - `own_run` — allowed when the target's chain is the execution's own run.
 * - `own_node` — `own_run`, and the target names the execution's own node.
 * - `own_agent` — `own_run`, and the target names the execution's own agent.
 * - `own_subtree` — `own_run`, and the target node is the execution's own node,
 *   one of its descendants, or a node being created directly under it. Only an
 *   `orchestrator` token's table uses it (P6, D-P6-04).
 */
export type ExecutionAccess =
  | "forbidden"
  | "own_program"
  | "own_run"
  | "own_node"
  | "own_agent"
  | "own_subtree";

/**
 * The §4.4 table for an execution principal, exhaustive over `Operation`.
 *
 * A `Record` rather than a set, so adding an operation to the union without
 * deciding what an execution may do with it is a type error rather than a silent
 * default. The default a set would give is the safe one, but "safe by accident"
 * is how the next non-guarantee gets written.
 */
export const EXECUTION_ACCESS: Readonly<Record<Operation, ExecutionAccess>> = {
  // Above the run: an execution cannot see the project or the program it is in.
  "project.list": "forbidden",
  "project.put": "forbidden",
  "project.get": "forbidden",
  "program.list": "forbidden",
  "program.put": "forbidden",
  "program.get": "forbidden",

  // Planning is a human's (D-P7-02, D-P7-05). An execution may see which
  // prerequisites are unmet, because a check that cannot run is deferred rather
  // than failed (D-P7-10), and may write none: only the preflight, under a
  // human's session, ever marks one satisfied.
  "program.ratify": "forbidden",
  "program.createPlanUploadUrl": "forbidden",
  "program.getPlanDocument": "forbidden",
  "prerequisite.list": "own_program",
  "prerequisite.put": "forbidden",

  // Its own run is readable; it may not list a program's runs, or write one.
  "run.list": "forbidden",
  "run.put": "forbidden",
  "run.get": "own_run",
  // The run state is the run plus *every* node in it. Reading a run does not
  // mean reading its siblings' progress, so this stays shut.
  "run.getState": "forbidden",

  // Nodes: its own, and only its own. `node.put` is how a worker reports
  // implemented and failed, and `authorize` refuses it any other requested
  // status (`EXECUTION_WRITABLE_NODE_STATUSES`), so nothing a worker holds can
  // move a node past `implemented` (A-05). The transition table then decides
  // whether the move is legal from where the node stands.
  "node.list": "own_run",
  "node.put": "own_node",
  "node.get": "own_node",
  "node.listChildren": "own_node",

  // A worker reads its Job Contract. It never writes one: the contract exists
  // before the node does (A-03), written by whoever delegated the job.
  "job.list": "own_run",
  "job.put": "forbidden",
  "job.get": "own_run",

  // The execution identity is created for an agent, never by one (A-04).
  "agent.put": "forbidden",
  "agent.get": "own_agent",
  "agent.listByNode": "own_node",
  // A token cannot mint a token. This is the operation that would let a worker
  // manufacture reach it was not given, so it is forbidden outright rather than
  // scoped.
  "agent.mintToken": "forbidden",

  // Progress, completion and failure all reach the record as events on its node.
  "event.append": "own_node",
  "event.list": "own_run",

  // Decisions on its own node (D-P4-05). Reading the run's decisions and its
  // checkpoints is what `decision.record` needs to attach one to a checkpoint.
  "decision.list": "own_run",
  "decision.put": "own_node",
  "decision.get": "own_run",
  "checkpoint.list": "own_run",
  "checkpoint.put": "forbidden",
  "checkpoint.get": "own_run",

  // `implemented ≠ verified` (A-05). Only the execution layer writes a
  // Verification, and a worker asserting its own verdict is the exact failure
  // that invariant exists to prevent.
  "verification.put": "forbidden",
  "verification.get": "own_run",
  "verification.listByNode": "own_node",
  "examination.put": "forbidden",
  "examination.get": "own_run",
  "examination.listByNode": "own_node",

  // Why a job runs where it runs is Nightshift's record, not the worker's.
  "routingDecision.put": "forbidden",
  "routingDecision.listByNode": "own_node",

  // Artifacts are readable within the run. A worker writes none: its oversized
  // event payloads are dropped with a reason rather than spilled to S3, so
  // granting a write here would grant reach nothing uses.
  "artifact.list": "own_run",
  "artifact.put": "forbidden",
  "artifact.get": "own_run",
  "artifact.createUploadUrl": "forbidden",
};

/**
 * The table for a **sub-program's orchestrator** (P6, D-P6-04), exhaustive over
 * `Operation` like the worker's.
 *
 * "Sub-program agents receive delegation authority" (Stage 5), and nothing more.
 * Within the subtree under its own node it may write a Job Contract, create a
 * child, read what it delegated, ask for a cancellation, record decisions and
 * end its own node. Everything that *runs* work is absent, because only the
 * engine does it, under the human's session: minting a token, creating an
 * agent, a routing decision, a verification, a checkpoint or an artifact.
 *
 * It is narrower than a worker's table on the read side where a worker's reach
 * was the run: a sub-orchestrator cannot list the run's nodes or jobs, so it
 * learns nothing of a sibling through this table.
 */
export const ORCHESTRATOR_ACCESS: Readonly<Record<Operation, ExecutionAccess>> = {
  "project.list": "forbidden",
  "project.put": "forbidden",
  "project.get": "forbidden",
  "program.list": "forbidden",
  "program.put": "forbidden",
  // Above the run, like a worker. What it delegates under reaches it as its own
  // node's scope; limits and policy are the API's and the engine's to apply.
  "program.get": "forbidden",

  // As for a worker: prerequisites are readable, and nothing of a plan is writable.
  "program.ratify": "forbidden",
  "program.createPlanUploadUrl": "forbidden",
  "program.getPlanDocument": "forbidden",
  "prerequisite.list": "own_program",
  "prerequisite.put": "forbidden",

  "run.list": "forbidden",
  "run.put": "forbidden",
  "run.get": "own_run",
  "run.getState": "forbidden",

  // Its own node and what is under it. `node.put` is further held to
  // `orchestratorMayWriteNode`: a new `validated` child, a descendant's
  // cancellation, or its own ending.
  "node.list": "forbidden",
  "node.put": "own_subtree",
  "node.get": "own_subtree",
  "node.listChildren": "own_subtree",

  // A Job Contract exists before its node does (A-03), so it cannot be placed
  // in a subtree yet; the API's create-or-confirm means a put can only ever add
  // one, never change another's.
  "job.list": "forbidden",
  "job.put": "own_run",
  "job.get": "own_run",

  "agent.put": "forbidden",
  "agent.get": "own_agent",
  "agent.listByNode": "own_subtree",
  "agent.mintToken": "forbidden",

  // `node.delegated` is the delegator's to say, about the child it delegated.
  "event.append": "own_subtree",
  "event.list": "own_run",

  "decision.list": "own_run",
  "decision.put": "own_node",
  "decision.get": "own_run",
  "checkpoint.list": "own_run",
  "checkpoint.put": "forbidden",
  "checkpoint.get": "own_run",

  // How its children ended is what it decides a retry on.
  "verification.put": "forbidden",
  "verification.get": "own_run",
  "verification.listByNode": "own_subtree",
  "examination.put": "forbidden",
  "examination.get": "own_run",
  "examination.listByNode": "own_subtree",

  "routingDecision.put": "forbidden",
  "routingDecision.listByNode": "own_subtree",

  "artifact.list": "own_run",
  "artifact.put": "forbidden",
  "artifact.get": "own_run",
  "artifact.createUploadUrl": "forbidden",
};

/** The table for a role. Exhaustive over `ExecutionRole` by construction. */
export const ACCESS_BY_ROLE: Readonly<
  Record<ExecutionRole, Readonly<Record<Operation, ExecutionAccess>>>
> = {
  worker: EXECUTION_ACCESS,
  orchestrator: ORCHESTRATOR_ACCESS,
};

/**
 * Where the target node stands relative to the execution's own node. A **stored
 * fact**, resolved by the API from the run's tree and never from the request: a
 * token that could state its own ancestry could state anyone's.
 *
 * `new_child` is a node that does not exist yet and whose parent, as the request
 * names it, is the execution's own node.
 */
export type NodeRelation = "self" | "descendant" | "new_child" | "outside";

/**
 * What the request is about, as much of it as the route names.
 *
 * `orgId` is the organisation that owns the target project, which only the
 * caller can know — it is a stored fact, and this module reads nothing. It is
 * absent for the two operations that have no project yet (`project.list` and
 * `project.put`, where the acting org *becomes* the target's org).
 */
export interface AuthorizationTarget {
  readonly orgId?: OrgId;
  readonly projectId?: ProjectId;
  readonly programId?: ProgramId;
  readonly runId?: RunId;
  readonly nodeId?: ExecutionNodeId;
  readonly agentId?: AgentId;
  /**
   * For `node.put` only: the status the request asks the node to have. A plain
   * string because the body has not been validated yet when this is read; an
   * unknown value is simply not one an execution may write.
   */
  readonly requestedNodeStatus?: string;
  /** For an `orchestrator` execution only. Absent means unresolved, which refuses. */
  readonly nodeRelation?: NodeRelation;
}

/**
 * What an orchestrator token may ask a node to become, by where the node stands
 * (D-P6-04): a child it is delegating is `validated`; a descendant may be asked
 * to stop; its own node may be ended. Nothing else, and in particular nothing
 * that starts, verifies or integrates work.
 */
export const ORCHESTRATOR_WRITABLE_NODE_STATUSES: Readonly<
  Record<NodeRelation, readonly ExecutionNodeStatus[]>
> = {
  new_child: ["validated"],
  // `cancelled` asks the engine to stop it. `queued` is how a retry is asked for
  // (D-P6-03's `job.retry`): the table's own `retry` edge, legal only from a
  // retryable status, and **not a start** — the engine starts a queued node, when
  // its parent has a slot, and nothing else does.
  descendant: ["cancelled", "queued"],
  self: ["succeeded", "failed"],
  outside: [],
};

/**
 * The only statuses an execution may ask its own node to take: what a worker
 * *claims* (`implemented`) and what a worker *admits* (`failed`). Every other
 * status is Nightshift's to assert. Whether the move is legal from where the
 * node stands is still `core`'s transition table's business, decided by the
 * operation; this decides only whether an execution may ask at all.
 */
export const EXECUTION_WRITABLE_NODE_STATUSES: readonly ExecutionNodeStatus[] = [
  "implemented",
  "failed",
];

export type AuthorizationRefusal =
  /** A user principal reached for a project another organisation owns. */
  | "wrong_org"
  /** An execution reached outside its own run, node or agent. */
  | "execution_out_of_scope"
  /** An execution attempted an operation no execution may perform. */
  | "execution_forbidden_operation";

export interface Allowed {
  readonly allowed: true;
}

export interface Refused {
  readonly allowed: false;
  readonly reason: AuthorizationRefusal;
  /** For a log and a 403 body. Never carries a token or a credential. */
  readonly detail: string;
}

export type Authorization = Allowed | Refused;

const ALLOWED: Allowed = { allowed: true };

const refuse = (reason: AuthorizationRefusal, detail: string): Refused => ({
  allowed: false,
  reason,
  detail,
});

/** Whether the target's chain is exactly the execution's own run. */
const inOwnRun = (
  principal: Extract<Principal, { kind: "execution" }>,
  target: AuthorizationTarget,
): boolean =>
  target.projectId === principal.projectId &&
  target.programId === principal.programId &&
  target.runId === principal.runId;

const inOwnSubtree = (target: AuthorizationTarget): boolean =>
  target.nodeRelation === "self" ||
  target.nodeRelation === "descendant" ||
  target.nodeRelation === "new_child";

const mayWriteNodeStatus = (role: ExecutionRole, target: AuthorizationTarget): boolean => {
  const requested = target.requestedNodeStatus ?? "";
  const writable: readonly string[] =
    role === "worker"
      ? EXECUTION_WRITABLE_NODE_STATUSES
      : ORCHESTRATOR_WRITABLE_NODE_STATUSES[target.nodeRelation ?? "outside"];
  return writable.includes(requested);
};

/**
 * A user may do anything within their own organisation.
 *
 * No target org means no project to be wrong about: `project.list` filters by
 * the acting org and `project.put` assigns it. Every other project-scoped route
 * resolves the owning org before asking.
 */
const authorizeUser = (
  principal: Extract<Principal, { kind: "user" }>,
  operation: Operation,
  target: AuthorizationTarget,
): Authorization =>
  target.orgId === undefined || target.orgId === principal.orgId
    ? ALLOWED
    : refuse("wrong_org", `${operation} targets a project owned by another organisation`);

/** Program scoped: the path names no run, so there is none to compare. */
const authorizeOwnProgram = (
  principal: Extract<Principal, { kind: "execution" }>,
  operation: Operation,
  target: AuthorizationTarget,
): Authorization =>
  target.projectId === principal.projectId && target.programId === principal.programId
    ? ALLOWED
    : refuse(
        "execution_out_of_scope",
        `an execution token may only ${operation} for the program its run belongs to`,
      );

/**
 * The one place a principal's reach is decided (D-P4-05).
 *
 * Pure and total: same inputs, same answer, no I/O, no clock. A user may do
 * anything within their own organisation; an execution is held to the table
 * above. Refusals are typed, and the API maps every one of them to 403.
 */
export const authorize = (
  principal: Principal,
  operation: Operation,
  target: AuthorizationTarget,
): Authorization => {
  if (principal.kind === "user") return authorizeUser(principal, operation, target);

  const access = ACCESS_BY_ROLE[principal.role][operation];
  if (access === "forbidden") {
    return refuse("execution_forbidden_operation", `an execution token may not ${operation}`);
  }
  if (access === "own_program") return authorizeOwnProgram(principal, operation, target);
  if (!inOwnRun(principal, target)) {
    return refuse(
      "execution_out_of_scope",
      `an execution token may only ${operation} within the run it was issued for`,
    );
  }
  if (access === "own_node" && target.nodeId !== principal.nodeId) {
    return refuse(
      "execution_out_of_scope",
      `an execution token may only ${operation} on the node it was issued for`,
    );
  }
  if (access === "own_agent" && target.agentId !== principal.agentId) {
    return refuse(
      "execution_out_of_scope",
      `an execution token may only ${operation} for the agent it was issued for`,
    );
  }
  if (access === "own_subtree" && !inOwnSubtree(target)) {
    return refuse(
      "execution_out_of_scope",
      `an orchestrator's token may only ${operation} within the subtree under its own node`,
    );
  }
  // Fail closed: a `node.put` that names no status, or one that is not this
  // role's to write where the node stands, is refused before anything is parsed.
  if (operation === "node.put" && !mayWriteNodeStatus(principal.role, target)) {
    return refuse(
      "execution_forbidden_operation",
      `a ${principal.role}'s token may not ask for this node to be "${
        target.requestedNodeStatus ?? "(no status)"
      }"`,
    );
  }
  return ALLOWED;
};

/** Every operation, for a test that wants to walk the whole union. */
export const ALL_OPERATIONS: readonly Operation[] = Object.keys(EXECUTION_ACCESS) as Operation[];
