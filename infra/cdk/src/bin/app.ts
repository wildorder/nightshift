/**
 * CDK app entry point. Compiled to `dist/bin/app.js`, which is what
 * `cdk.json` invokes (D-P1-10) — no TypeScript loader is involved.
 *
 * Two stacks (D-P2-07): the stateful `nightshift-<stage>-data` and the stateless
 * `nightshift-<stage>-api`. Both are environment-agnostic, so synth works with no
 * credentials, no profile, and no network.
 */
import { App } from "aws-cdk-lib";
import { NightshiftApiStack } from "../lib/api-stack.js";
import { NightshiftDataStack } from "../lib/data-stack.js";

/** Stage used when `-c stage=<name>` is not supplied. */
const DEFAULT_STAGE = "dev";

const app = new App();

const stageContext: unknown = app.node.tryGetContext("stage");
const stage =
  typeof stageContext === "string" && stageContext.length > 0 ? stageContext : DEFAULT_STAGE;

const data = new NightshiftDataStack(app, "NightshiftData", {
  stage,
  description: `Nightshift stateful resources (${stage}): table, artifact bucket, user pool, budget.`,
});

const api = new NightshiftApiStack(app, "NightshiftApi", {
  stage,
  description: `Nightshift stateless control plane (${stage}): API, functions, stream consumer.`,
});

// The API stack imports the data stack's exports by name, so the data stack must
// deploy first. This orders deploys; it creates no construct reference.
api.addStackDependency(data, "imports the data stack's exports by name");
