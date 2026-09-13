/**
 * Nightshift control-plane stack.
 *
 * This stack deliberately defines NO resources in P1. It exists so the CDK app
 * builds, synthesizes offline, and is covered by assertion tests before any
 * infrastructure lands. P2 adds the DynamoDB single table, the S3 artifact
 * bucket (A-08), the IAM execution identity, and the control-plane API here.
 * CDK v2 is the sole IaC system (A-09).
 *
 * It is environment-agnostic on purpose: no `env`, no account, no region, so
 * `cdk synth` needs no AWS credentials and no network.
 */
import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

/** Props for every Nightshift stack. `stage` names the deployment stage. */
export interface NightshiftStackProps extends StackProps {
  /** Deployment stage, e.g. `dev`. Part of the stack name. */
  readonly stage: string;
}

export class NightshiftControlPlaneStack extends Stack {
  /** The stage this stack instance was created for. */
  readonly stage: string;

  constructor(scope: Construct, id: string, props: NightshiftStackProps) {
    const { stage, ...stackProps } = props;
    // Naming convention: nightshift-<stage>-control-plane. A caller-supplied
    // stackName still wins, so the convention is a default, not a cage.
    super(scope, id, { stackName: `nightshift-${stage}-control-plane`, ...stackProps });
    this.stage = stage;

    // Intentionally empty. See the file header: P2 adds the real resources.
    // `Template.fromStack` logs a CloudFormation default-rule warning that
    // `Resources` must be non-empty. It is expected here and it is a plugin
    // report, not an annotation, so `acknowledgeWarning` cannot mute it.
    // Do NOT set `@aws-cdk/core:validateAgainstDefaultRules` to true while the
    // stack is empty: that turns the warning into a synth error.
  }
}
