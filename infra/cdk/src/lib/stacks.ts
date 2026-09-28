/**
 * Every Nightshift stack, composed once (P11, T2).
 *
 * Lifted out of `bin/app.ts` so the composition — which stacks exist in which
 * hostnames mode, and what each depends on — is a function a test can call
 * with a context of its own, rather than a side effect of importing the entry
 * point. The entry point does nothing but build an `App` and call this.
 */
import type { App } from "aws-cdk-lib";
import { NightshiftApiStack } from "./api-stack.js";
import { NightshiftDataStack } from "./data-stack.js";
import { NightshiftDnsStack } from "./dns-stack.js";
import { type HostnamesMode, parseHostnamesMode } from "./hostnames.js";
import { NightshiftStudioCertificateStack } from "./studio-cert-stack.js";
import { NightshiftStudioStack, resolveStudioAssets } from "./studio-stack.js";

/** Stage used when `-c stage=<name>` is not supplied. */
export const DEFAULT_STAGE = "dev";

export interface NightshiftStacks {
  readonly stage: string;
  readonly hostnames: HostnamesMode;
  readonly dns: NightshiftDnsStack;
  readonly data: NightshiftDataStack;
  readonly api: NightshiftApiStack;
  /** The Studio's two stacks (D-P11-02); absent in `zone-only` mode. */
  readonly studio:
    | {
        readonly certificate: NightshiftStudioCertificateStack;
        readonly site: NightshiftStudioStack;
      }
    | undefined;
}

/** The zone id the Studio's certificate validates in; refused before any stack exists. */
const requireHostedZoneId = (app: App): string => {
  const hostedZoneId: unknown = app.node.tryGetContext("hostedZoneId");
  if (typeof hostedZoneId === "string" && hostedZoneId.length > 0) return hostedZoneId;
  throw new Error(
    "the Studio's certificate needs the hosted zone id: set `hostedZoneId` in cdk.json or " +
      "pass -c hostedZoneId=<the nightshift-dns stack's HostedZoneId output>, " +
      "or deploy -c hostnames=zone-only",
  );
};

/**
 * Reads `stage`, `hostnames`, `hostedZoneId` and `studioAssets` from the app's
 * context and builds the stacks.
 *
 * - `-c hostnames=zone-only` omits the API's certificate and custom domain and
 *   both Studio stacks: every one of them waits on a zone that is not yet
 *   delegated (D-P3-18).
 * - `hostedZoneId` names the zone for the Studio's certificate, which cannot
 *   import a regional export from `us-east-1` (see `studio-cert-stack.ts`);
 *   `cdk.json` carries the v1 account's.
 * - `studioAssets` names a directory to deploy other than `apps/studio/dist`
 *   or the placeholder.
 */
export const composeNightshiftStacks = (app: App): NightshiftStacks => {
  const stageContext: unknown = app.node.tryGetContext("stage");
  const stage =
    typeof stageContext === "string" && stageContext.length > 0 ? stageContext : DEFAULT_STAGE;
  const hostnames = parseHostnamesMode(app.node.tryGetContext("hostnames"));
  const hostedZoneId = hostnames === "full" ? requireHostedZoneId(app) : undefined;

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
  if (hostnames !== "full" || hostedZoneId === undefined) {
    return { stage, hostnames, dns, data, api, studio: undefined };
  }
  api.addStackDependency(dns, "imports the DNS stack's exports by name");

  // The Studio (P11, D-P11-02).
  const certificate = new NightshiftStudioCertificateStack(app, "NightshiftStudioCertificate", {
    stage,
    hostedZoneId,
    description: `Nightshift Studio certificate (${stage}), in us-east-1 for CloudFront.`,
  });
  const site = new NightshiftStudioStack(app, "NightshiftStudio", {
    stage,
    certificate: certificate.certificate,
    assetPath: resolveStudioAssets(app.node.tryGetContext("studioAssets")),
    description: `Nightshift Studio (${stage}): the hosted console on CloudFront.`,
  });
  // By export name, as the API stack does; the certificate is a construct
  // reference, which CDK carries across the region boundary itself.
  site.addStackDependency(data, "imports the data stack's exports by name");
  site.addStackDependency(dns, "imports the DNS stack's exports by name");

  return { stage, hostnames, dns, data, api, studio: { certificate, site } };
};
