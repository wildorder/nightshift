/**
 * `@nightshift/persistence` — the only layer permitted to reach a datastore
 * (architecture §1).
 *
 * Two subpaths, deliberately separate:
 *
 * - `@nightshift/persistence/memory` — in-memory, test only, no AWS import.
 * - `@nightshift/persistence/aws` — DynamoDB and S3. Built in P2. Only an app or
 *   `infra/cdk` may import it, which the architecture tests enforce.
 *
 * This root entry point deliberately re-exports neither. Importing the package
 * root would otherwise pull the AWS SDK into anything that only wanted the test
 * adapter, and the subpath split is what keeps that honest.
 */
export {};
