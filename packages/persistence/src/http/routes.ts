/**
 * Every control-plane path, built in one place.
 *
 * The route table in `apps/api/src/handler.ts` is the API surface; this is the
 * client's copy of it, and the two are held together by the http adapter's tests
 * running against the real handler. A path built anywhere else in this adapter is
 * a path nothing checks.
 */
import type {
  AgentId,
  ArtifactId,
  CheckpointId,
  DecisionId,
  ExaminationId,
  ExecutionNodeId,
  JobContractId,
  OrgId,
  ProgramId,
  ProjectId,
  RoutingDecisionId,
  RunId,
  VerificationId,
} from "@nightshift/contracts";
import type { ProgramScope, RunScope } from "@nightshift/core";

export const routes = {
  /** An org's routing and examination policy (P8). */
  orgConfig: (orgId: OrgId) => `/orgs/${orgId}/config`,
  /** An org's provider keys (P10, D-P10-23): `PUT` one, `GET` the views. */
  orgCredentials: (orgId: OrgId) => `/orgs/${orgId}/credentials`,
  orgCredential: (orgId: OrgId, provider: string) => `${routes.orgCredentials(orgId)}/${provider}`,
  /** An org's GitHub App installation (P10, D-P10-02). */
  orgGithub: (orgId: OrgId) => `/orgs/${orgId}/github`,
  /** Where the App is installed from. */
  githubApp: () => "/github/app",

  projects: () => "/projects",
  project: (projectId: ProjectId) => `/projects/${projectId}`,
  programs: (projectId: ProjectId) => `/projects/${projectId}/programs`,
  /** A project's warm snapshot (P10, D-P10-15). */
  warmCache: (projectId: ProjectId) => `/projects/${projectId}/warm-cache`,
  program: (projectId: ProjectId, programId: ProgramId) =>
    `/projects/${projectId}/programs/${programId}`,

  // Planning (P7).
  ratifications: (scope: ProgramScope) =>
    `${routes.program(scope.projectId, scope.programId)}/ratifications`,
  planDocument: (scope: ProgramScope, sha256: string) =>
    `${routes.program(scope.projectId, scope.programId)}/plan-documents/${sha256}`,
  planDocumentUploadUrl: (scope: ProgramScope, sha256: string) =>
    `${routes.planDocument(scope, sha256)}/upload-url`,
  prerequisites: (scope: ProgramScope) =>
    `${routes.program(scope.projectId, scope.programId)}/prerequisites`,
  prerequisite: (scope: ProgramScope, prerequisiteId: string) =>
    `${routes.prerequisites(scope)}/${prerequisiteId}`,

  /** The tier a program's project should run on, from its past runs (P10, D-P10-14b). */
  computeRecommendation: (scope: ProgramScope) =>
    `${routes.program(scope.projectId, scope.programId)}/compute/recommendation`,

  runs: (scope: ProgramScope) => `${routes.program(scope.projectId, scope.programId)}/runs`,
  run: (scope: ProgramScope, runId: RunId) => `${routes.runs(scope)}/${runId}`,

  /** Everything below a run hangs off this prefix. */
  inRun: (scope: RunScope) => routes.run(scope, scope.runId),

  state: (scope: RunScope) => `${routes.inRun(scope)}/state`,

  // The remote runner (P10, D-P10-18, D-P10-22, D-P10-14b).
  dispatch: (scope: RunScope) => `${routes.inRun(scope)}/dispatch`,
  dispatchCancel: (scope: RunScope) => `${routes.dispatch(scope)}/cancel`,
  dispatchResume: (scope: RunScope) => `${routes.dispatch(scope)}/resume`,
  dispatchHeartbeat: (scope: RunScope) => `${routes.dispatch(scope)}/heartbeat`,
  publication: (scope: RunScope) => `${routes.inRun(scope)}/publication`,
  computeUtilization: (scope: RunScope) => `${routes.inRun(scope)}/compute`,

  nodes: (scope: RunScope) => `${routes.inRun(scope)}/nodes`,
  node: (scope: RunScope, nodeId: ExecutionNodeId) => `${routes.nodes(scope)}/${nodeId}`,
  children: (scope: RunScope, nodeId: ExecutionNodeId) => `${routes.node(scope, nodeId)}/children`,

  jobs: (scope: RunScope) => `${routes.inRun(scope)}/jobs`,
  job: (scope: RunScope, jobContractId: JobContractId) => `${routes.jobs(scope)}/${jobContractId}`,

  agent: (scope: RunScope, agentId: AgentId) => `${routes.inRun(scope)}/agents/${agentId}`,
  nodeAgents: (scope: RunScope, nodeId: ExecutionNodeId) => `${routes.node(scope, nodeId)}/agents`,
  /** `POST` only: mints that agent's execution token (P4, D-P4-03). */
  agentToken: (scope: RunScope, agentId: AgentId) => `${routes.agent(scope, agentId)}/token`,

  events: (scope: RunScope) => `${routes.inRun(scope)}/events`,

  decisions: (scope: RunScope) => `${routes.inRun(scope)}/decisions`,
  decision: (scope: RunScope, decisionId: DecisionId) => `${routes.decisions(scope)}/${decisionId}`,

  checkpoints: (scope: RunScope) => `${routes.inRun(scope)}/checkpoints`,
  checkpoint: (scope: RunScope, checkpointId: CheckpointId) =>
    `${routes.checkpoints(scope)}/${checkpointId}`,

  verification: (scope: RunScope, verificationId: VerificationId) =>
    `${routes.inRun(scope)}/verifications/${verificationId}`,
  nodeVerifications: (scope: RunScope, nodeId: ExecutionNodeId) =>
    `${routes.node(scope, nodeId)}/verifications`,

  examination: (scope: RunScope, examinationId: ExaminationId) =>
    `${routes.inRun(scope)}/examinations/${examinationId}`,
  nodeExaminations: (scope: RunScope, nodeId: ExecutionNodeId) =>
    `${routes.node(scope, nodeId)}/examinations`,

  routingDecision: (scope: RunScope, routingDecisionId: RoutingDecisionId) =>
    `${routes.inRun(scope)}/routing-decisions/${routingDecisionId}`,
  nodeRoutingDecisions: (scope: RunScope, nodeId: ExecutionNodeId) =>
    `${routes.node(scope, nodeId)}/routing-decisions`,

  artifacts: (scope: RunScope) => `${routes.inRun(scope)}/artifacts`,
  artifact: (scope: RunScope, artifactId: ArtifactId) => `${routes.artifacts(scope)}/${artifactId}`,
  artifactUploadUrl: (scope: RunScope, artifactId: ArtifactId) =>
    `${routes.artifact(scope, artifactId)}/upload-url`,
  /** `POST` only: a signed read of a recorded artifact's bytes (P11, D-P11-06). */
  artifactDownloadUrl: (scope: RunScope, artifactId: ArtifactId) =>
    `${routes.artifact(scope, artifactId)}/download-url`,
} as const;
