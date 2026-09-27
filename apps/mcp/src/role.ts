/**
 * The two roles one binary has, and the identity each carries (D-P3-01, §4.2).
 *
 * ## Why a role rather than two binaries
 *
 * Because the difference that matters is not the code, it is *which execution
 * identity a server instance acts for*, and that is fixed at spawn time by a
 * party the worker does not control. The operator's MCP configuration spawns the
 * orchestrator; Nightshift's execution layer spawns the worker and writes its
 * identity into the environment it hands the harness.
 *
 * The server opens no socket. It speaks stdio, so the operating-system process
 * boundary is its authentication: whoever can spawn the process is the operator.
 * A local token would authenticate the same user to the same user.
 *
 * ## What the split buys
 *
 * The orchestrator instance registers the delegation tools; the worker instance
 * does not. So **a worker cannot delegate by construction** — not because a
 * check refuses it, but because there is no tool to call. And if one somehow
 * tried through another route, the API's `CAN_DELEGATE` rule refuses a job node
 * as a parent anyway. Two independent reasons, which is the right number for
 * something this load-bearing.
 *
 * P4 adds a third, and the one that survives a worker escaping this process:
 * its **credential** can only do the four things §4.4 grants it on its own
 * node. Creating a node is `forbidden` in the table, so a worker that somehow
 * called the route directly would still be refused by the control plane.
 */
import {
  AgentIdSchema,
  ExecutionNodeIdSchema,
  JobContractIdSchema,
  ProgramIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@nightshift/contracts";
import type { WorkerIdentity } from "@nightshift/execution";

export const ROLE_ENV = "NIGHTSHIFT_ROLE";

/**
 * The worker's only credential (D-P4-06, A-35).
 *
 * A Nightshift-issued JWT bound to this agent, this node and this run. A
 * worker-role server refuses to start without it and reads no credentials file:
 * before P4 a worker acted with whatever identity the operating-system user
 * happened to hold, which with two users means acting as whichever human
 * launched it.
 *
 * Never log it. It is a bearer token: whoever holds it is that agent until it
 * expires, and Nightshift has no way to revoke one.
 */
export const EXECUTION_TOKEN_ENV = "NIGHTSHIFT_EXECUTION_TOKEN";

/**
 * `sub-orchestrator` is P6's (D-P6-03): a sub-program's orchestrator. Like a
 * worker it holds only an execution token and an identity; unlike one, the token
 * delegates, and the tool surface is an orchestrator's, narrowed to its subtree.
 */
export type Role = "orchestrator" | "worker" | "sub-orchestrator" | "examiner" | "arbiter";

/** The roles launched with an execution token and an identity, never the operator's session. */
export const EXECUTION_ROLES: readonly Role[] = [
  "worker",
  "sub-orchestrator",
  "examiner",
  "arbiter",
];

/**
 * The seven variables a worker's identity is made of (§4.2).
 *
 * Declared as a table rather than read one by one so the refusal below can name
 * **every** missing one at once. An operator debugging a launch wants the whole
 * list, not to fix one and rerun.
 */
export const WORKER_IDENTITY_ENV = {
  projectId: "NIGHTSHIFT_PROJECT_ID",
  programId: "NIGHTSHIFT_PROGRAM_ID",
  runId: "NIGHTSHIFT_RUN_ID",
  executionNodeId: "NIGHTSHIFT_NODE_ID",
  agentId: "NIGHTSHIFT_AGENT_ID",
  jobContractId: "NIGHTSHIFT_JOB_ID",
  worktree: "NIGHTSHIFT_WORKTREE",
} as const;

export type Env = Readonly<Record<string, string | undefined>>;

/** A worker that cannot say who it is does not start. */
export class MissingWorkerIdentityError extends Error {
  override readonly name = "MissingWorkerIdentityError";

  constructor(readonly missing: readonly string[]) {
    super(
      `a worker-role Nightshift MCP server needs its execution identity in the environment, ` +
        `and these are missing or empty: ${missing.join(", ")}. The execution layer sets all ` +
        "seven when it launches a worker; a server started by hand is not a worker.",
    );
  }
}

/** Absent means `orchestrator`: that is what an operator's configuration spawns. */
export const roleFrom = (env: Env): Role => {
  const value = env[ROLE_ENV];
  if (value === undefined || value === "") return "orchestrator";
  if (value === "orchestrator" || (EXECUTION_ROLES as readonly string[]).includes(value)) {
    return value as Role;
  }
  throw new Error(
    `${ROLE_ENV} must be "orchestrator", "worker", "sub-orchestrator", "examiner" or "arbiter", not "${value}"`,
  );
};

/**
 * The worker's identity, or a refusal naming every variable that is missing.
 *
 * Each value is parsed through its own identifier schema, so a variable that is
 * present but malformed is caught here rather than at the first write.
 */
export const workerIdentityFrom = (env: Env): WorkerIdentity => {
  const missing = Object.values(WORKER_IDENTITY_ENV).filter((name) => {
    const value = env[name];
    return value === undefined || value === "";
  });
  if (missing.length > 0) throw new MissingWorkerIdentityError(missing);

  const read = (name: string): string => env[name] ?? "";
  return {
    scope: {
      projectId: ProjectIdSchema.parse(read(WORKER_IDENTITY_ENV.projectId)),
      programId: ProgramIdSchema.parse(read(WORKER_IDENTITY_ENV.programId)),
      runId: RunIdSchema.parse(read(WORKER_IDENTITY_ENV.runId)),
    },
    executionNodeId: ExecutionNodeIdSchema.parse(read(WORKER_IDENTITY_ENV.executionNodeId)),
    agentId: AgentIdSchema.parse(read(WORKER_IDENTITY_ENV.agentId)),
    jobContractId: JobContractIdSchema.parse(read(WORKER_IDENTITY_ENV.jobContractId)),
    worktree: read(WORKER_IDENTITY_ENV.worktree),
  };
};

/** The environment the execution layer hands a worker's MCP server. */
export const workerLaunchEnv = (identity: {
  readonly projectId: string;
  readonly programId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly jobContractId: string;
  readonly worktree: string;
  readonly executionToken: string;
  readonly role?: "worker" | "sub-orchestrator" | "examiner" | "arbiter";
  /** P8: an examiner's or arbiter's frame. Never a credential. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Record<string, string> => ({
  ...identity.extraEnv,
  [ROLE_ENV]: identity.role ?? "worker",
  [EXECUTION_TOKEN_ENV]: identity.executionToken,
  [WORKER_IDENTITY_ENV.projectId]: identity.projectId,
  [WORKER_IDENTITY_ENV.programId]: identity.programId,
  [WORKER_IDENTITY_ENV.runId]: identity.runId,
  [WORKER_IDENTITY_ENV.executionNodeId]: identity.nodeId,
  [WORKER_IDENTITY_ENV.agentId]: identity.agentId,
  [WORKER_IDENTITY_ENV.jobContractId]: identity.jobContractId,
  [WORKER_IDENTITY_ENV.worktree]: identity.worktree,
});
