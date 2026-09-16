/**
 * The account-wide DNS stack: `nightshift-dns` (D-P3-18).
 *
 * One public hosted zone, `nightshift.wildorder.dev`, and nothing else. It is
 * stateful in the way that matters most: the zone's nameservers are what the
 * parent zone delegates to, and a recreated zone gets *different* nameservers,
 * which silently breaks every hostname beneath it until a human edits the parent
 * again. So the zone is retained and the stack carries termination protection,
 * and the stack is not staged, because a second zone of the same name would be
 * exactly that breakage.
 *
 * Per-stage records (the API alias, its certificate's validation CNAMEs) are
 * created by the stage's own stacks, which import the zone id by export name.
 *
 * Environment-agnostic, like the data stack: Route 53 is a global service, and
 * nothing here needs an account or region at synth time.
 */
import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import { PARENT_ZONE_NAME, ZONE_NAME } from "./hostnames.js";
import { DNS_STACK_NAME, type DnsExportKey, dnsExportName } from "./stack-props.js";

export class NightshiftDnsStack extends Stack {
  readonly hostedZone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, {
      stackName: DNS_STACK_NAME,
      // Losing the zone means re-delegating from the parent by hand (H-P3-05).
      terminationProtection: true,
      ...props,
    });

    this.hostedZone = new route53.PublicHostedZone(this, "Zone", {
      zoneName: ZONE_NAME,
      comment: `Nightshift public hostnames (D-P3-18); delegated from ${PARENT_ZONE_NAME}`,
    });
    this.hostedZone.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const nameServers = this.hostedZone.hostedZoneNameServers;
    if (nameServers === undefined) throw new Error("a public hosted zone always has nameservers");

    // `NameServers` is the one output a human reads: the four values to put in
    // the parent zone's `NS` record.
    const exports: Record<DnsExportKey, string> = {
      HostedZoneId: this.hostedZone.hostedZoneId,
      ZoneName: ZONE_NAME,
      NameServers: Fn.join(" ", nameServers),
    };
    for (const [key, value] of Object.entries(exports) as [DnsExportKey, string][]) {
      new CfnOutput(this, key, { value, exportName: dnsExportName(key) });
    }
  }
}
