/**
 * `@nightshift/persistence/aws` — DynamoDB and S3 adapters (P2, T3).
 *
 * Only an app or `infra/cdk` may import this, which the architecture tests
 * enforce. Everything is configured by injection: table and bucket names and
 * clients come from the caller, never from `process.env`.
 *
 * The adapters pass the shared persistence-port conformance suite: offline
 * against `FakeTable` in `npm test`, and against the deployed table in the smoke
 * suite.
 */
export {
  type ArtifactBodyStoreConfig,
  type ArtifactDownloadSignerConfig,
  type ArtifactUploadSignerConfig,
  createArtifactBodyStore,
  createArtifactDownloadSigner,
  createArtifactUploadSigner,
  createPlanDocumentStore,
  DOWNLOAD_URL_TTL_SECONDS,
  type ObjectClient,
  type PlanDocumentStoreConfig,
  s3ObjectClient,
  UPLOAD_URL_TTL_SECONDS,
} from "./artifact-bodies.js";
export { type AwsClientOptions, type AwsClients, createAwsClients } from "./clients.js";
export { COUNTER_ATTRIBUTE, createEventStore, type EventStoreConfig } from "./events.js";
export { estimateItemBytes, ItemTooLargeError, MAX_ITEM_BYTES } from "./items.js";
export { artifactPrefix, keys, NODE_INDEX_NAME, type NodeIndexKey, type TableKey } from "./keys.js";
export { createDynamoSequenceLedger, type SequenceLedgerConfig } from "./sequence-ledger.js";
export { type AwsStoresConfig, createAwsStores } from "./stores.js";
export {
  type ParsedStreamRecord,
  parseStreamRecord,
  type StreamRecordLike,
} from "./stream-records.js";
export {
  conditionFailures,
  documentTableClient,
  isConditionalCheckFailure,
  type TableClient,
} from "./table-client.js";
