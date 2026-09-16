/**
 * CDK app entry point. Compiled to `dist/bin/app.js`, which is what
 * `cdk.json` invokes (D-P1-10) — no TypeScript loader is involved.
 *
 * Three stacks: the stateful `nightshift-<stage>-data` and the stateless
 * `nightshift-<stage>-api` (D-P2-07), and the account-wide `nightshift-dns`
 * holding the one hosted zone (D-P3-18). All environment-agnostic, so synth works
 * with no credentials, no profile, and no network.
 *
 * `-c hostnames=zone-only` omits the API's certificate and custom domain. It is
 * the first deploy of a new account: land the zone, read its `NameServers`
 * output, delegate, then deploy again without the flag.
 */
import { App } from "aws-cdk-lib";
import { NightshiftApiStack } from "../lib/api-stack.js";
import { NightshiftDataStack } from "../lib/data-stack.js";
import { NightshiftDnsStack } from "../lib/dns-stack.js";
import { parseHostnamesMode } from "../lib/hostnames.js";

/** Stage used when `-c stage=<name>` is not supplied. */
const DEFAULT_STAGE = "dev";

const app = new App();

const stageContext: unknown = app.node.tryGetContext("stage");
const stage =
  typeof stageContext === "string" && stageContext.length > 0 ? stageContext : DEFAULT_STAGE;
const hostnames = parseHostnamesMode(app.node.tryGetContext("hostnames"));

const dns = new NightshiftDnsStack(app, "NightshiftDns", {
  description: "Nightshift public DNS: the nightshift.wildorder.dev hosted zone.",
});

const data = new NightshiftDataStack(app, "NightshiftData", {
  stage,
  description: `Nightshift stateful resources (${stage}): table, artifact bucket, user pool, budget.`,
});

const api = new NightshiftApiStack(app, "NightshiftApi", {
  stage,
  hostnames,
  description: `Nightshift stateless control plane (${stage}): API, functions, stream consumer.`,
});

// The API stack imports the data and DNS stacks' exports by name, so both must
// deploy first. This orders deploys; it creates no construct reference.
api.addStackDependency(data, "imports the data stack's exports by name");
if (hostnames === "full") api.addStackDependency(dns, "imports the DNS stack's exports by name");
