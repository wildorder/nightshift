/**
 * `@nightshift/persistence/http` — the store ports over the control-plane API.
 *
 * The adapter the local machinery uses (A-28, D-P3-02). It holds **no AWS
 * credentials and imports no AWS SDK**: everything reaches the control plane over
 * HTTPS with the operator's Cognito ID token, and artifact bodies go to S3
 * through a URL the control plane signed. An orchestrator on a laptop needs no
 * AWS profile for Nightshift.
 *
 * It implements the project-scoped half of the store ports. Identity — users and
 * memberships — is administered by the operator with an AWS profile
 * (`npm run admin:user`), not by a run, and the API exposes no route for it.
 */
export {
  createHttpArtifactBodyStore,
  type HttpArtifactBodyStoreOptions,
  type UploadFetch,
} from "./artifact-bodies.js";
export {
  ControlPlaneError,
  ControlPlaneUnreachableError,
  toThrowable,
} from "./errors.js";
export {
  createHttpExecutionTokenMinter,
  type HttpExecutionTokenMinterOptions,
} from "./execution-tokens.js";
export {
  createHttpPlanning,
  type DiscoveredPrerequisite,
  type HttpPlanningOptions,
  type PlanningClient,
  sha256Hex,
} from "./planning.js";
export { routes } from "./routes.js";
export * from "./session/index.js";
export { createHttpStores, type HttpStoresOptions } from "./stores.js";
export {
  type ControlPlaneRequest,
  type ControlPlaneResponse,
  createFetchTransport,
  DEFAULT_RETRY,
  type FetchLike,
  type FetchTransportOptions,
  type RetryPolicy,
  send,
  type TokenProvider,
  type Transport,
} from "./transport.js";
