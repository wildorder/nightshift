/** Shared by the launcher and the child entry; contains no logic and no imports. */

/** The only address the receiver ever binds. */
export const RECEIVER_HOST = "127.0.0.1";

export const DEFAULT_ALLOWED_PATHS: readonly string[] = ["/v1/logs", "/v1/metrics", "/v1/traces"];
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_RECORDS_PER_ENVELOPE = 500;

/** Environment variable names. The capability travels here, never in argv. */
export const RECEIVER_ENV = {
  capability: "NIGHTSHIFT_RECEIVER_CAPABILITY",
  journalPath: "NIGHTSHIFT_RECEIVER_JOURNAL",
  allowedPaths: "NIGHTSHIFT_RECEIVER_ALLOWED_PATHS",
  maxBodyBytes: "NIGHTSHIFT_RECEIVER_MAX_BODY_BYTES",
  maxJournalBytes: "NIGHTSHIFT_RECEIVER_MAX_JOURNAL_BYTES",
  /** Newline or comma separated exact attribute keys; required. */
  allowedAttributes: "NIGHTSHIFT_RECEIVER_ALLOWED_ATTRIBUTES",
  /** JSON array of `{ key, type, values? }` specs; merged with `allowedAttributes`. */
  attributeSpecs: "NIGHTSHIFT_RECEIVER_ATTRIBUTE_SPECS",
  /** JSON array of flat rule objects; absent or empty keeps every record. */
  recordFilter: "NIGHTSHIFT_RECEIVER_RECORD_FILTER",
  maxRecords: "NIGHTSHIFT_RECEIVER_MAX_RECORDS",
} as const;
