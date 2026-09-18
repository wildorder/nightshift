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
 * - `own_run` — allowed when the target's chain is the execution's own run.
 * - `own_node` — `own_run`, and the target names the execution's own node.
 * - `own_agent` — `own_run`, and the target names the execution's own agent.
 */
export type ExecutionAccess = "forbidden" | "own_run" | "own_node" | "own_agent";

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
}

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
  if (principal.kind === "user") {
    // No target org means no project to be wrong about: `project.list` filters
    // by the acting org and `project.put` assigns it. Every other project-scoped
    // route resolves the owning org before asking.
    if (target.orgId === undefined || target.orgId === principal.orgId) return ALLOWED;
    return refuse("wrong_org", `${operation} targets a project owned by another organisation`);
  }

  const access = EXECUTION_ACCESS[operation];
  if (access === "forbidden") {
    return refuse("execution_forbidden_operation", `an execution token may not ${operation}`);
  }
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
  // Fail closed: a `node.put` that names no status, or one that is not a
  // worker's to write, is refused before the operation parses anything.
  if (
    operation === "node.put" &&
    !(EXECUTION_WRITABLE_NODE_STATUSES as readonly string[]).includes(
      target.requestedNodeStatus ?? "",
    )
  ) {
    return refuse(
      "execution_forbidden_operation",
      `an execution token may only report its node ${EXECUTION_WRITABLE_NODE_STATUSES.join(" or ")}; ` +
        `"${target.requestedNodeStatus ?? "(no status)"}" is Nightshift's to assert`,
    );
  }
  return ALLOWED;
};

/** Every operation, for a test that wants to walk the whole union. */
export const ALL_OPERATIONS: readonly Operation[] = Object.keys(EXECUTION_ACCESS) as Operation[];
