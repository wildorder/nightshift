/**
 * The Studio's certificate: `nightshift-<stage>-studio-cert` (P11, D-P11-02).
 *
 * One ACM certificate for `studio.<stage>.nightshift.wildorder.dev`, DNS
 * validated in the zone the DNS stack owns, and nothing else. It is its own
 * stack, in `us-east-1`, because CloudFront accepts a certificate from that
 * region only; the studio stack in the primary region reads the certificate
 * through a CDK cross-region reference, which is why both stacks carry an
 * explicit account and region where every other stack is environment-agnostic.
 *
 * ## Why the zone id arrives by context and not by export name
 *
 * The API stack imports the zone id with `Fn::ImportValue`, and T2's spec asked
 * for the same here. A CloudFormation export is regional, though: a stack in
 * `us-east-1` cannot import what `nightshift-dns` exported in `us-west-2`. The
 * alternatives were a cross-region reference *from* the DNS stack, which would
 * force an explicit environment and a custom-resource writer onto the one stack
 * built never to change, or a context lookup, which `--no-lookups` forbids. So
 * the zone id is a context value, `hostedZoneId`, defaulted in `cdk.json` and
 * overridable with `-c hostedZoneId=…` for a new account after its zone-only
 * deploy. Route 53 is global and the zone is retained, so the id is as stable
 * as the account number beside it. Recorded as a departure (T2 report).
 *
 * Nothing stateful: a certificate is re-issued by a fresh deploy.
 */
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import {
  CERTIFICATE_REGION,
  NIGHTSHIFT_ACCOUNT,
  studioHostnameFor,
  ZONE_NAME,
} from "./hostnames.js";
import { assertValidStage, stackNameFor } from "./stack-props.js";

export interface NightshiftStudioCertificateStackProps extends StackProps {
  /** Deployment stage, e.g. `dev`. Part of the stack name and the hostname. */
  readonly stage: string;
  /** The id of `nightshift.wildorder.dev`'s hosted zone (the DNS stack's `HostedZoneId`). */
  readonly hostedZoneId: string;
}

export class NightshiftStudioCertificateStack extends Stack {
  readonly stage: string;
  readonly hostname: string;
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: NightshiftStudioCertificateStackProps) {
    const { stage, hostedZoneId, ...stackProps } = props;
    assertValidStage(stage);
    super(scope, id, {
      stackName: stackNameFor(stage, "studio-cert"),
      // Explicit on purpose, and the only region CloudFront will take it from.
      env: { account: NIGHTSHIFT_ACCOUNT, region: CERTIFICATE_REGION },
      // The studio stack reads `certificate` from its own region.
      crossRegionReferences: true,
      ...stackProps,
    });
    this.stage = stage;
    this.hostname = studioHostnameFor(stage);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId,
      zoneName: ZONE_NAME,
    });
    // DNS validation writes the CNAME into the zone, as the API's certificate
    // does; it completes only once the zone is delegated, which is why
    // `zone-only` mode omits this stack altogether.
    this.certificate = new acm.Certificate(this, "StudioCertificate", {
      domainName: this.hostname,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    new CfnOutput(this, "StudioCertificateArn", { value: this.certificate.certificateArn });
    new CfnOutput(this, "StudioHostname", { value: this.hostname });
  }
}
