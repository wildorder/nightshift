/**
 * The gate fingerprint at a commit (P15, D-P15-02), from git's bytes.
 *
 * The engine computes it too, when a repair lands, so the reader lives in
 * `@nightshift/execution` and the CLI uses that one (D-P15-07).
 */
export {
  fingerprintAtCommit,
  gitBlobReader,
  type ReadBlob,
  sha256Bytes,
} from "@nightshift/execution";
