/**
 * CDK app entry point. Compiled to `dist/bin/app.js`, which is what
 * `cdk.json` invokes (D-P1-10) — no TypeScript loader is involved.
 *
 * The single stack is environment-agnostic: no `env`, so synth works with no
 * credentials, no profile, and no network.
 */
import { App } from "aws-cdk-lib";
import { NightshiftControlPlaneStack } from "../lib/control-plane-stack.js";

/** Stage used when `-c stage=<name>` is not supplied. */
const DEFAULT_STAGE = "dev";

const app = new App();

const stageContext: unknown = app.node.tryGetContext("stage");
const stage =
  typeof stageContext === "string" && stageContext.length > 0 ? stageContext : DEFAULT_STAGE;

new NightshiftControlPlaneStack(app, "NightshiftControlPlane", {
  stage,
  description: `Nightshift control plane (${stage}). Defines no resources in P1.`,
});
