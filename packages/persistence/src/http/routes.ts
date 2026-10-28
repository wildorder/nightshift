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
  CompletionHistoryId,
  ComputeArchitecture,
  DecisionId,
  ExaminationId,
  ExecutionNodeId,
  JobContractId,
  MeasurementSummaryId,
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
  orgGithubInstallation: (orgId: OrgId, installationId: number) =>
    `/orgs/${orgId}/github/${installationId}`,
  /** Where the App is installed from. */
  githubApp: () => "/github/app",

  /** A project's secrets (A-62): `PUT`/`DELETE` one, `GET` the views. */
  projectSecrets: (projectId: ProjectId) => `/projects/${projectId}/secrets`,
  projectSecret: (projectId: ProjectId, name: string) =>
    `/projects/${projectId}/secrets/${encodeURIComponent(name)}`,

  /**
   * A project's line (Pipkin M1b), and what is done to it. The branch is the
   * `branch` query parameter, never a path segment: API Gateway decodes a
   * `%2F` in the path before the API sees it, so `nightshift/develop` would
   * arrive as two segments and match no route (2026-10-28).
   */
  line: (projectId: ProjectId, branch: string, action = "") =>
    `/projects/${projectId}/line${action}?branch=${encodeURIComponent(branch)}`,
  lineBatch: (projectId: ProjectId, branch: string) => routes.line(projectId, branch, "/batch"),
  lineCompositions: (projectId: ProjectId, branch: string) =>
    routes.line(projectId, branch, "/compositions"),
  lineDecisions: (projectId: ProjectId, branch: string) =>
    routes.line(projectId, branch, "/decisions"),
  lineAgents: (projectId: ProjectId, branch: string) => routes.line(projectId, branch, "/agents"),
  lineSettle: (projectId: ProjectId, branch: string) => routes.line(projectId, branch, "/settle"),
  lineParked: (projectId: ProjectId, branch: string) => routes.line(projectId, branch, "/parked"),
  linePush: (projectId: ProjectId, branch: string) => routes.line(projectId, branch, "/push"),
  lineBundleUploadUrl: (projectId: ProjectId, branch: string) =>
    routes.line(projectId, branch, "/bundle-upload-url"),
  lineHeartbeat: (projectId: ProjectId, branch: string) =>
    routes.line(projectId, branch, "/heartbeat"),
  lineCancel: (projectId: ProjectId, branch: string) =>
    routes.line(projectId, branch, "/dispatch/cancel"),

  projects: () => "/projects",
  project: (projectId: ProjectId) => `/projects/${projectId}`,
  programs: (projectId: ProjectId) => `/projects/${projectId}/programs`,
  /** A project's warm snapshot (P10, D-P10-15). */
  warmCache: (projectId: ProjectId, architecture: ComputeArchitecture) =>
    `/projects/${projectId}/warm-cache?architecture=${architecture}`,
  /** A project's gate-health record (P15, D-P15-07): `GET` it, `PUT` it whole. */
  gateHealth: (projectId: ProjectId) => `/projects/${projectId}/gate-health`,
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

  // A program's plan draft (P21). Ratifying a version is `ratifications`.
  planDrafts: (projectId: ProjectId) => `/projects/${projectId}/plan-drafts`,
  planDraft: (scope: ProgramScope) =>
    `${routes.program(scope.projectId, scope.programId)}/plan-draft`,
  planDraftVersions: (scope: ProgramScope) => `${routes.planDraft(scope)}/versions`,
  planDraftVersion: (scope: ProgramScope, version: number) =>
    `${routes.planDraftVersions(scope)}/${version}`,
  planDraftLatest: (scope: ProgramScope) => `${routes.planDraftVersions(scope)}/latest`,
  planDraftAnswers: (scope: ProgramScope) => `${routes.planDraft(scope)}/answers`,
  planDraftChangeRequests: (scope: ProgramScope) => `${routes.planDraft(scope)}/change-requests`,
  planDraftAwaitingOwner: (scope: ProgramScope) => `${routes.planDraft(scope)}/awaiting-owner`,
  planDraftDecline: (scope: ProgramScope) => `${routes.planDraft(scope)}/decline`,

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
  publicationRetry: (scope: RunScope) => `${routes.inRun(scope)}/publication/retry`,
  publicationStrands: (scope: RunScope) => `${routes.inRun(scope)}/publication/strands`,
  computeUtilization: (scope: RunScope) => `${routes.inRun(scope)}/compute`,

  // Run feedback and completion histories (P20, D-04, D-05).
  feedback: (scope: RunScope) => `${routes.inRun(scope)}/feedback`,
  programFeedback: (scope: ProgramScope) =>
    `${routes.program(scope.projectId, scope.programId)}/feedback`,
  completionHistories: (scope: RunScope) => `${routes.inRun(scope)}/completion-histories`,
  completionHistory: (scope: RunScope, completionHistoryId: CompletionHistoryId) =>
    `${routes.completionHistories(scope)}/${completionHistoryId}`,
  projectCompletionHistories: (projectId: ProjectId) =>
    `/projects/${projectId}/completion-histories`,

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

  measurements: (scope: RunScope) => `${routes.inRun(scope)}/measurements`,
  measurement: (scope: RunScope, measurementSummaryId: MeasurementSummaryId) =>
    `${routes.measurements(scope)}/${measurementSummaryId}`,
  nodeMeasurements: (scope: RunScope, nodeId: ExecutionNodeId) =>
    `${routes.node(scope, nodeId)}/measurements`,

  artifacts: (scope: RunScope) => `${routes.inRun(scope)}/artifacts`,
  artifact: (scope: RunScope, artifactId: ArtifactId) => `${routes.artifacts(scope)}/${artifactId}`,
  artifactUploadUrl: (scope: RunScope, artifactId: ArtifactId) =>
    `${routes.artifact(scope, artifactId)}/upload-url`,
  /** `POST` only: a signed read of a recorded artifact's bytes (P11, D-P11-06). */
  artifactDownloadUrl: (scope: RunScope, artifactId: ArtifactId) =>
    `${routes.artifact(scope, artifactId)}/download-url`,
} as const;
