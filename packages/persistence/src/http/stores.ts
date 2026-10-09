/**
 * `ProjectStores` over the control-plane API (D-P3-02, A-28).
 *
 * The execution layer depends on the store ports and never learns which adapter
 * it holds. This is the adapter that lets an orchestrator on a laptop reach the
 * control plane with nothing but a Cognito session: no AWS profile, no AWS SDK,
 * no DynamoDB credential. `persistence/aws` stays the Lambda's business.
 *
 * ## Two places the API is not a storage layer, and what this adapter does
 *
 * The ports are a *storage* abstraction; the API is a *domain* surface that
 * enforces more than storage does. Two consequences a caller should know about:
 *
 * 1. **Referential integrity.** The API refuses a record whose parents do not
 *    exist: a run needs its program, a node needs its run, an event needs its
 *    run. Writing through this adapter therefore has an order that writing to
 *    the in-memory adapter does not. That is the API being right, and the
 *    execution layer writes in that order anyway (contract §4.3).
 * 2. **The organisation comes from the token** (D-P2-13). `projects.put` cannot
 *    place a project in an arbitrary org — the control plane assigns the acting
 *    org and answers with what it stored — and `listByOrg` can only see the
 *    acting org. Both are documented on the methods.
 *
 * Every record is parsed through its contract schema on the way in, so a
 * response that drifted from the contract fails here rather than three layers up.
 */
import {
  type AgentId,
  AgentSchema,
  type ArtifactId,
  ArtifactSchema,
  type CheckpointId,
  CheckpointSchema,
  ComputeUtilizationSchema,
  type DecisionId,
  DecisionSchema,
  DispatchSchema,
  EventSchema,
  type ExaminationId,
  ExaminationSchema,
  ExecutionNodeSchema,
  GateHealthSchema,
  type JobContractId,
  JobContractSchema,
  OrgConfigSchema,
  type OrgId,
  ProgramContractSchema,
  type ProgramId,
  type ProjectId,
  ProjectSchema,
  RoutingDecisionSchema,
  type RunId,
  RunSchema,
  type VerificationId,
  VerificationSchema,
  WarmCacheSchema,
} from "@nightshift/contracts";
import type {
  AgentStore,
  AppendResult,
  ArtifactStore,
  CheckpointStore,
  ComputeUtilizationStore,
  DecisionStore,
  DispatchStore,
  EventStore,
  ExaminationStore,
  ExecutionNodeStore,
  GateHealthStore,
  InstallationClaimStore,
  JobContractStore,
  OrgConfigStore,
  Page,
  PageRequest,
  ProgramContractStore,
  ProgramScope,
  ProjectStore,
  ProjectStores,
  RoutingDecisionStore,
  RunStore,
  VerificationStore,
  WarmCacheStore,
} from "@nightshift/core";
import type { z } from "zod";
import { routes } from "./routes.js";
import { send, type Transport } from "./transport.js";

export interface HttpStoresOptions {
  readonly transport: Transport;
  /**
   * The organisation the session's token acts for, when the caller knows it.
   *
   * Used only by `listByOrg`, to answer honestly for an org this session is not
   * acting for: the API's `GET /projects` always lists the acting org, so
   * returning its projects under another org's name would be a quiet lie. Omit
   * it and `listByOrg` trusts the caller and lists whatever the token resolves
   * to.
   */
  readonly actingOrg?: OrgId;
}

/** A page body as every list route answers it. */
const readPage = <S extends z.ZodType>(schema: S, body: unknown): Page<z.output<S>> => {
  const page = body as { items?: unknown[]; cursor?: unknown };
  const items = (page.items ?? []).map((item) => schema.parse(item) as z.output<S>);
  return typeof page.cursor === "string" ? { items, cursor: page.cursor } : { items };
};

/** Every list route answers in the page shape, so a whole-array read is a page with no cursor. */
const readList = <S extends z.ZodType>(schema: S, body: unknown): readonly z.output<S>[] =>
  readPage(schema, body).items;

const pageQuery = (page: PageRequest | undefined): Record<string, string | undefined> => ({
  ...(page?.limit === undefined ? {} : { limit: String(page.limit) }),
  ...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
});

/**
 * A `GET` that answers `undefined` for a 404 rather than throwing.
 *
 * The ports say "returns undefined for an absent record rather than throwing",
 * and a 404 is how the API says the same thing. Every other refusal still throws.
 */
const getOrUndefined = async <S extends z.ZodType>(
  transport: Transport,
  schema: S,
  path: string,
): Promise<z.output<S> | undefined> => {
  const response = await transport({ method: "GET", path });
  if (response.status === 404) return undefined;
  if (response.status !== 200) {
    const { toThrowable } = await import("./errors.js");
    throw toThrowable(response.status, response.body);
  }
  return schema.parse(response.body) as z.output<S>;
};

export const createHttpStores = (options: HttpStoresOptions): ProjectStores => {
  const { transport } = options;

  const projects: ProjectStore = {
    /**
     * Stores a project **in the organisation the session's token acts for**.
     *
     * `orgId` is stripped from the body because the API refuses it: the org is
     * resolved from the validated token and never from a payload (D-P2-13), so a
     * caller cannot place a project in an org it does not act for. A project
     * whose `orgId` disagrees with the acting org therefore comes back with the
     * acting org, and a *stored* project moved to another org is refused with
     * `OwnershipViolationError` as the port promises.
     */
    put: async (project) => {
      const { orgId: _orgId, ...body } = project;
      await send(transport, {
        method: "PUT",
        path: routes.project(project.projectId),
        body,
      });
    },
    get: (projectId) => getOrUndefined(transport, ProjectSchema, routes.project(projectId)),
    /**
     * The acting organisation's projects.
     *
     * `GET /projects` lists whatever org the token resolves to; there is no route
     * that lists someone else's. When `actingOrg` is configured and `orgId` is a
     * different org, this answers an empty page rather than the acting org's
     * projects under another name.
     */
    listByOrg: async (orgId, page) => {
      if (options.actingOrg !== undefined && options.actingOrg !== orgId) return { items: [] };
      const body = await send(transport, {
        method: "GET",
        path: routes.projects(),
        query: pageQuery(page),
      });
      return readPage(ProjectSchema, body);
    },
  };

  const programContracts: ProgramContractStore = {
    put: async (contract) => {
      await send(transport, {
        method: "PUT",
        path: routes.program(contract.projectId, contract.programId),
        body: contract,
      });
    },
    get: (projectId: ProjectId, programId: ProgramId) =>
      getOrUndefined(transport, ProgramContractSchema, routes.program(projectId, programId)),
    update: async () => {
      throw new Error(
        "the control plane changes a stored program contract in place; there is no route that " +
          "takes the change. Use PUT .../prerequisites/{prerequisiteId} for a prerequisite.",
      );
    },
    listByProject: async (projectId, page) =>
      readPage(
        ProgramContractSchema,
        await send(transport, {
          method: "GET",
          path: routes.programs(projectId),
          query: pageQuery(page),
        }),
      ),
  };

  const runs: RunStore = {
    put: async (run) => {
      await send(transport, { method: "PUT", path: routes.run(run, run.runId), body: run });
    },
    get: (scope: ProgramScope, runId: RunId) =>
      getOrUndefined(transport, RunSchema, routes.run(scope, runId)),
    listByProgram: async (scope, page) =>
      readPage(
        RunSchema,
        await send(transport, {
          method: "GET",
          path: routes.runs(scope),
          query: pageQuery(page),
        }),
      ),
  };

  const executionNodes: ExecutionNodeStore = {
    put: async (node) => {
      await send(transport, {
        method: "PUT",
        path: routes.node(node, node.executionNodeId),
        body: node,
      });
    },
    get: (scope, executionNodeId) =>
      getOrUndefined(transport, ExecutionNodeSchema, routes.node(scope, executionNodeId)),
    listByRun: async (scope, page) =>
      readPage(
        ExecutionNodeSchema,
        await send(transport, {
          method: "GET",
          path: routes.nodes(scope),
          query: pageQuery(page),
        }),
      ),
    listChildren: async (scope, parentNodeId) =>
      readList(
        ExecutionNodeSchema,
        await send(transport, { method: "GET", path: routes.children(scope, parentNodeId) }),
      ),
  };

  const jobContracts: JobContractStore = {
    put: async (contract) => {
      await send(transport, {
        method: "PUT",
        path: routes.job(contract, contract.jobContractId),
        body: contract,
      });
    },
    get: (scope, jobContractId: JobContractId) =>
      getOrUndefined(transport, JobContractSchema, routes.job(scope, jobContractId)),
    listByRun: async (scope, page) =>
      readPage(
        JobContractSchema,
        await send(transport, { method: "GET", path: routes.jobs(scope), query: pageQuery(page) }),
      ),
  };

  const agents: AgentStore = {
    put: async (agent) => {
      await send(transport, {
        method: "PUT",
        path: routes.agent(agent, agent.agentId),
        body: agent,
      });
    },
    get: (scope, agentId: AgentId) =>
      getOrUndefined(transport, AgentSchema, routes.agent(scope, agentId)),
    listByNode: async (scope, executionNodeId) =>
      readList(
        AgentSchema,
        await send(transport, { method: "GET", path: routes.nodeAgents(scope, executionNodeId) }),
      ),
  };

  const events: EventStore = {
    /**
     * Appends one event.
     *
     * `sequence` and `recordedAt` are stripped: both belong to the control plane
     * (A-22), and the request schema is strict, so sending either is a validation
     * failure rather than something quietly ignored. The returned event's
     * `sequence` may still be `null` — numbering trails durability, and every
     * reader tolerates that.
     */
    append: async (event) => {
      const { sequence: _sequence, recordedAt: _recordedAt, ...body } = event;
      const result = (await send(transport, {
        method: "POST",
        path: routes.events(event),
        body,
      })) as { stored?: unknown; event?: unknown };
      return {
        stored: result.stored === true,
        event: EventSchema.parse(result.event),
      } satisfies AppendResult;
    },
    listByRun: async (scope, options_) =>
      readPage(
        EventSchema,
        await send(transport, {
          method: "GET",
          path: routes.events(scope),
          query: {
            ...pageQuery(options_),
            ...(options_?.afterSequence === undefined
              ? {}
              : { afterSequence: String(options_.afterSequence) }),
          },
        }),
      ),
    /**
     * The number the next event to be numbered will receive.
     *
     * There is no route for this, and deliberately so: nothing but the Streams
     * consumer assigns a number, and a route that handed out the next one would
     * invite a second numberer. It is derived from `GET …/state`, where
     * `highestSequence` is the last number assigned and numbering is dense from
     * zero — so the next is one past it, and zero when nothing is numbered.
     */
    nextSequence: async (scope) => {
      const state = (await send(transport, { method: "GET", path: routes.state(scope) })) as {
        highestSequence?: number | null;
      };
      const highest = state.highestSequence;
      return highest === null || highest === undefined ? 0 : highest + 1;
    },
  };

  const decisions: DecisionStore = {
    put: async (decision) => {
      await send(transport, {
        method: "PUT",
        path: routes.decision(decision, decision.decisionId),
        body: decision,
      });
    },
    get: (scope, decisionId: DecisionId) =>
      getOrUndefined(transport, DecisionSchema, routes.decision(scope, decisionId)),
    listByRun: async (scope, page) =>
      readPage(
        DecisionSchema,
        await send(transport, {
          method: "GET",
          path: routes.decisions(scope),
          query: pageQuery(page),
        }),
      ),
  };

  const checkpoints: CheckpointStore = {
    put: async (checkpoint) => {
      await send(transport, {
        method: "PUT",
        path: routes.checkpoint(checkpoint, checkpoint.checkpointId),
        body: checkpoint,
      });
    },
    get: (scope, checkpointId: CheckpointId) =>
      getOrUndefined(transport, CheckpointSchema, routes.checkpoint(scope, checkpointId)),
    listByRun: async (scope, page) =>
      readPage(
        CheckpointSchema,
        await send(transport, {
          method: "GET",
          path: routes.checkpoints(scope),
          query: pageQuery(page),
        }),
      ),
  };

  const verifications: VerificationStore = {
    put: async (verification) => {
      await send(transport, {
        method: "PUT",
        path: routes.verification(verification, verification.verificationId),
        body: verification,
      });
    },
    get: (scope, verificationId: VerificationId) =>
      getOrUndefined(transport, VerificationSchema, routes.verification(scope, verificationId)),
    listByNode: async (scope, executionNodeId) =>
      readList(
        VerificationSchema,
        await send(transport, {
          method: "GET",
          path: routes.nodeVerifications(scope, executionNodeId),
        }),
      ),
  };

  const examinations: ExaminationStore = {
    put: async (examination) => {
      await send(transport, {
        method: "PUT",
        path: routes.examination(examination, examination.examinationId),
        body: examination,
      });
    },
    get: (scope, examinationId: ExaminationId) =>
      getOrUndefined(transport, ExaminationSchema, routes.examination(scope, examinationId)),
    listByNode: async (scope, executionNodeId) =>
      readList(
        ExaminationSchema,
        await send(transport, {
          method: "GET",
          path: routes.nodeExaminations(scope, executionNodeId),
        }),
      ),
  };

  const routingDecisions: RoutingDecisionStore = {
    put: async (decision) => {
      await send(transport, {
        method: "PUT",
        path: routes.routingDecision(decision, decision.routingDecisionId),
        body: decision,
      });
    },
    listByNode: async (scope, executionNodeId) =>
      readList(
        RoutingDecisionSchema,
        await send(transport, {
          method: "GET",
          path: routes.nodeRoutingDecisions(scope, executionNodeId),
        }),
      ),
  };

  const artifacts: ArtifactStore = {
    put: async (artifact) => {
      await send(transport, {
        method: "PUT",
        path: routes.artifact(artifact, artifact.artifactId),
        body: artifact,
      });
    },
    get: (scope, artifactId: ArtifactId) =>
      getOrUndefined(transport, ArtifactSchema, routes.artifact(scope, artifactId)),
    listByRun: async (scope, page) =>
      readPage(
        ArtifactSchema,
        await send(transport, {
          method: "GET",
          path: routes.artifacts(scope),
          query: pageQuery(page),
        }),
      ),
  };

  const orgConfigs: OrgConfigStore = {
    /**
     * The org's stored configuration. The route answers the seeded default,
     * version 0, when nobody has written one; the port says `undefined` for
     * that, as every other adapter does.
     */
    get: async (orgId) => {
      const config = await getOrUndefined(transport, OrgConfigSchema, routes.orgConfig(orgId));
      return config === undefined || config.version === 0 ? undefined : config;
    },
    put: async (config) => {
      await send(transport, {
        method: "PUT",
        path: routes.orgConfig(config.orgId),
        body: {
          routingPolicy: config.routingPolicy,
          examinationPolicy: config.examinationPolicy,
          replacesVersion: config.version - 1,
        },
      });
    },
  };

  /**
   * The control plane owns these three records (P10): a dispatch is created by
   * its route and moved by heartbeats and the reconciler, utilization is folded
   * from heartbeats, and the warm cache is written when a run ends. There is no
   * route that takes one whole, so a `put` through this adapter is a mistake
   * named as one. Nothing in the execution layer calls them.
   */
  const controlPlaneOwns = (record: string, route: string) => async (): Promise<void> => {
    throw new Error(
      `the control plane owns a ${record}; there is no route that writes one whole. Use ${route}.`,
    );
  };

  const dispatches: DispatchStore = {
    put: controlPlaneOwns("dispatch", "POST .../dispatch, .../heartbeat, .../cancel or .../resume"),
    get: (scope) => getOrUndefined(transport, DispatchSchema, routes.dispatch(scope)),
    listByStatus: async () => {
      throw new Error("listing dispatches by status is the reconciler's read; no route serves it");
    },
  };

  const computeUtilizations: ComputeUtilizationStore = {
    put: controlPlaneOwns("utilization record", "POST .../dispatch/heartbeat"),
    get: (scope) =>
      getOrUndefined(transport, ComputeUtilizationSchema, routes.computeUtilization(scope)),
    listByProject: async () => {
      throw new Error(
        "a project's utilization records are read through GET .../compute/recommendation, not listed",
      );
    },
  };

  const installationClaims: InstallationClaimStore = {
    claim: async () => {
      throw new Error(
        "the control plane owns installation claims; PUT /orgs/{orgId}/github records one",
      );
    },
    release: async () => {
      throw new Error(
        "the control plane owns installation claims; DELETE /orgs/{orgId}/github/{installationId} releases one",
      );
    },
  };

  const warmCaches: WarmCacheStore = {
    put: controlPlaneOwns("warm cache", "the reconciler, when a run ends"),
    get: (projectId, architecture) =>
      getOrUndefined(transport, WarmCacheSchema, routes.warmCache(projectId, architecture)),
    delete: controlPlaneOwns("warm cache", "the dispatcher, when its snapshot is gone"),
  };

  // P15 (D-P15-07): written whole by the signed-in operator or the run's engine,
  // so unlike the warm cache it has a write route.
  const gateHealth: GateHealthStore = {
    put: async (record) => {
      await send(transport, {
        method: "PUT",
        path: routes.gateHealth(record.projectId),
        body: record,
      });
    },
    get: (projectId) => getOrUndefined(transport, GateHealthSchema, routes.gateHealth(projectId)),
  };

  return {
    orgConfigs,
    projects,
    dispatches,
    computeUtilizations,
    warmCaches,
    gateHealth,
    installationClaims,
    programContracts,
    runs,
    executionNodes,
    jobContracts,
    agents,
    events,
    decisions,
    checkpoints,
    verifications,
    examinations,
    routingDecisions,
    artifacts,
  };
};
