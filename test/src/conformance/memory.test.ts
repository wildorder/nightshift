/**
 * The in-memory adapter against the shared conformance suite.
 *
 * P2 adds a sibling file wiring the same suite to the DynamoDB and S3 adapter.
 * The suite itself must not change between the two.
 */
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describePortConformance } from "./persistence-ports.js";

describePortConformance("in-memory", () => createInMemoryStores());
