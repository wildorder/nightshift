/**
 * Lambda entry point for the control-plane API. The only place the API handler
 * meets the AWS adapters (T4: only `apps/api`'s entry point imports
 * `@nightshift/persistence/aws`).
 *
 * Configuration is read and validated at cold start, so a missing variable fails
 * the first invocation loudly rather than a later request obscurely.
 */
import { systemClock } from "@nightshift/core";
import { createAwsClients, createAwsStores } from "@nightshift/persistence/aws";
import { loadConfig } from "../config.js";
import { createApiLambdaHandler } from "./api-handler.js";

const config = loadConfig(process.env);
const stores = createAwsStores({ tableName: config.tableName, table: createAwsClients().table });

export const handler = createApiLambdaHandler(() => ({ stores, clock: systemClock }));
