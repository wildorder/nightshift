/**
 * Building the server for a role, and stopping it tidily.
 *
 * One binary, two roles (D-P3-01). The role decides which tools exist, and
 * nothing else about the process differs — same transport, same shutdown, same
 * control-plane identity.
 *
 * ## Shutdown
 *
 * A stdio server's life is its stdin. When the harness that spawned it exits,
 * stdin closes, and that is the only notice this process gets. So both roles
 * treat stdin closing, `SIGTERM` and `SIGINT` the same way, and both have
 * something they must do before the process goes:
 *
 * - the **orchestrator** cancels a worker in flight, records the interruption
 *   durably, and spills whatever the outbox could not deliver to a spool file
 *   the next server for that run replays (D-P3-10);
 * - the **worker** flushes its outbox, because its last `node.progress` or
 *   `node.implemented` would otherwise vanish with it.
 *
 * Both are bounded. A shutdown that waits forever for an unreachable control
 * plane is a process that never exits.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { WorkerIdentity } from "@nightshift/execution";
import { createEventOutbox, shutdown, type WorkerEnvironment } from "@nightshift/execution";
import { createRuntime, type Runtime } from "./compose.js";
import { registerOrchestratorTools } from "./orchestrator.js";
import type { Env, Role } from "./role.js";
import { roleFrom, workerIdentityFrom } from "./role.js";
import { createCheckpointAt, DEFAULT_CONTRACT_FILE, type OrchestratorSession } from "./session.js";
import { registerWorkerTools } from "./worker.js";

export const SERVER_NAME = "nightshift";
export const SERVER_VERSION = "0.1.0";

/** Long enough to drain a healthy queue, short enough not to hang an exit. */
export const SHUTDOWN_DEADLINE_MS = 5_000;

export interface NightshiftServer {
  readonly role: Role;
  readonly server: McpServer;
  /** The control plane this server is talking to, for a diagnostic line. */
  readonly endpoint: string;
  connect(transport: Transport): Promise<void>;
  /** Idempotent. Records what must be durable, then closes the transport. */
  stop(reason: string): Promise<void>;
}

export interface CreateServerInput {
  readonly env: Env;
  /** The operator's clone. Defaults to the process's working directory. */
  readonly cwd?: string;
  readonly runtime?: Runtime;
}

export const createNightshiftServer = async (
  input: CreateServerInput,
): Promise<NightshiftServer> => {
  const role = roleFrom(input.env);
  const runtime = input.runtime ?? (await createRuntime(input.env));
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        role === "worker"
          ? "You are a Nightshift worker. Read your job with job.get, and finish with " +
            "job.complete or job.fail. Never commit: Nightshift collects your work."
          : "Nightshift: delegate bounded jobs, wait for verified results, record decisions. " +
            "Start with run.start or run.attach.",
    },
  );

  return role === "worker"
    ? buildWorker(server, runtime, input)
    : buildOrchestrator(server, runtime, input);
};

const buildWorker = (
  server: McpServer,
  runtime: Runtime,
  input: CreateServerInput,
): NightshiftServer => {
  // Refuses to start without all seven identity variables, naming every one
  // that is missing. A server started by hand is not a worker.
  const identity: WorkerIdentity = workerIdentityFrom(input.env);
  const outbox = createEventOutbox({
    events: runtime.stores.events,
    scope: identity.scope,
    clock: runtime.clock,
    ids: runtime.ids,
    // A worker's events are its own writer's (A-30), keyed by its agent id.
    writerId: identity.agentId,
  });
  const environment: WorkerEnvironment = {
    stores: runtime.stores,
    clock: runtime.clock,
    git: runtime.git,
    outbox,
  };
  registerWorkerTools(server, { identity, environment, ids: runtime.ids });

  let stopped = false;
  return {
    role: "worker",
    server,
    endpoint: runtime.endpoint,
    connect: (transport) => server.connect(transport),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // The last events this worker reported, before its process goes.
      await outbox.flush(SHUTDOWN_DEADLINE_MS);
      await outbox.spill(runtime.paths.spool(identity.scope.runId));
      await server.close();
    },
  };
};

const buildOrchestrator = (
  server: McpServer,
  runtime: Runtime,
  input: CreateServerInput,
): NightshiftServer => {
  const cwd = input.cwd ?? process.cwd();
  const state: OrchestratorSession = {
    runtime,
    repoPath: cwd,
    contractFile: input.env.NIGHTSHIFT_CONTRACT_FILE ?? DEFAULT_CONTRACT_FILE,
    // The MCP client's own name and version, from the initialize handshake.
    // This is what is actually orchestrating, so it is what the orchestrator's
    // `Agent` records as its harness — never a guess.
    clientInfo: () => {
      const info = server.server.getClientVersion();
      return { name: info?.name ?? "unknown", version: info?.version ?? "unknown" };
    },
    workerLaunch: (identity) => runtime.workerLaunch(identity),
  };
  registerOrchestratorTools(server, { state, env: input.env });

  let stopped = false;
  return {
    role: "orchestrator",
    server,
    endpoint: runtime.endpoint,
    connect: (transport) => server.connect(transport),
    stop: async (reason) => {
      if (stopped) return;
      stopped = true;
      const attached = state.current;
      if (attached !== undefined) {
        await shutdown(attached.environment, {
          session: attached.session,
          job: attached.job,
          reason,
          flushDeadlineMs: SHUTDOWN_DEADLINE_MS,
        }).catch(() => {
          // Shutdown records what it can. A control plane that is unreachable
          // now leaves the spool, which the next server replays.
        });
      }
      await server.close();
    },
  };
};

/** Re-exported so the binary and the tests build a session the same way. */
export { createCheckpointAt };
