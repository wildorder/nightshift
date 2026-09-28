/**
 * `@nightshift/persistence/http/browser` — the control-plane client a browser
 * can bundle (P11, D-P11-07).
 *
 * The same transport, routes, errors and stores as `./http`, and nothing that
 * needs Node: no file-backed session (`session/`), no `node:crypto` (the plan
 * upload's hash, the artifact upload's digest), no artifact body store at all.
 * A browser reads artifact bodies through the download URL the control plane
 * signs (D-P11-06) and never uploads one.
 *
 * `browser-entry.test.ts` walks this module's import graph and refuses a
 * `node:` specifier or Node's byte buffer class, so the guarantee is a test,
 * not a comment.
 */
export { tokenClaims, tokenExpiry } from "../claims.js";
export { ControlPlaneError, ControlPlaneUnreachableError, toThrowable } from "../errors.js";
export {
  createHttpExecutionTokenMinter,
  type HttpExecutionTokenMinterOptions,
} from "../execution-tokens.js";
export { routes } from "../routes.js";
export { createHttpStores, type HttpStoresOptions } from "../stores.js";
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
} from "../transport.js";
