/**
 * The runner stack (P10, D-P10-12, D-P10-16, D-P10-17, D-P10-18, D-P10-21).
 *
 * Everything a remote run's machine needs that is not a record: the image the
 * machine boots (an EC2 Image Builder pipeline over this repository at a commit),
 * the network it boots into (a VPC of public subnets, no NAT, egress through
 * the gateway), the launch template and the instance role (heartbeat, its own
 * run's logs and artifacts, its first token, and nothing else), and the three
 * functions that move machines: dispatch, the reconciler on its minute, and the
 * publisher with the only write credential to GitHub.
 *
 * Separate from the API stack (D-P10-21) so the control plane deploys without
 * touching EC2, and a bad image pipeline cannot break an API deploy. It imports
 * the data stack's exports by name, like the API stack does.
 */
import { fileURLToPath } from "node:url";
import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as imagebuilder from "aws-cdk-lib/aws-imagebuilder";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { type DataExportKey, dataExportName } from "./data-exports.js";
import { NODE_INDEX_NAME } from "./data-stack.js";
import { apiHostnameFor } from "./hostnames.js";
import {
  containmentComponent,
  RUNNER_TOOLCHAIN,
  runnerComponent,
  toolchainComponent,
  WORKER_USERS,
} from "./runner-image.js";
import { assertValidStage, type NightshiftStackProps, stackNameFor } from "./stack-props.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const DISPATCH_ENTRY = `${REPO_ROOT}apps/api/dist/lambda/runner-dispatch.js`;
export const RECONCILER_ENTRY = `${REPO_ROOT}apps/api/dist/lambda/runner-reconciler.js`;
export const PUBLISHER_ENTRY = `${REPO_ROOT}apps/api/dist/lambda/runner-publisher.js`;

/** The reconciler's tick (D-P10-18). */
export const RECONCILER_INTERVAL = Duration.minutes(1);
export const LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

/** Every machine, volume and snapshot the service makes carries this tag; IAM is conditioned on it. */
export const MANAGED_TAG = "nightshift:managed";
/** The AMI's version tag, recorded on every dispatch (D-P10-16). */
export const AMI_VERSION_TAG = "nightshift:amiVersion";

/** The SSM parameter path the dispatch Lambda writes a machine's first engine token under. */
export const dispatchParameterPrefix = (stage: string): string => `/nightshift/${stage}/dispatch/`;

/**
 * The GitHub App's secret (H-P10-04). Two control-plane functions read it: the
 * publisher (write, T4) and the API (read: installations, branch heads, a
 * machine's clone token). No machine ever does.
 */
export const GITHUB_APP_SECRET_NAME = "nightshift/github-app";

/** The runner stack's one export the API stack imports. */
export const RUNNER_EXPORT_KEYS = ["DispatchFunctionArn", "PublisherFunctionArn"] as const;
export type RunnerExportKey = (typeof RUNNER_EXPORT_KEYS)[number];
export const runnerExportName = (stage: string, key: RunnerExportKey): string =>
  `nightshift-${stage}-runner-${key}`;

/** The latest Amazon Linux 2023 arm64 AMI, resolved by CloudFormation at deploy time. */
export const AL2023_ARM64_PARAMETER =
  "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";

export interface NightshiftRunnerStackProps extends NightshiftStackProps {
  /** The commit of this repository the image builds the runner from (D-P10-16). */
  readonly runnerCommit: string;
  /** The image's semantic version: the package version, plus a build number when the recipe changes. */
  readonly imageVersion: string;
}

export class NightshiftRunnerStack extends Stack {
  readonly stage: string;

  constructor(scope: Construct, id: string, props: NightshiftRunnerStackProps) {
    const { stage, runnerCommit, imageVersion, hostnames: _hostnames, ...stackProps } = props;
    assertValidStage(stage);
    if (!/^[0-9a-f]{40}$/.test(runnerCommit)) {
      throw new Error(`runnerCommit must be a full commit SHA; got "${runnerCommit}"`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(imageVersion)) {
      throw new Error(`imageVersion must be a semantic version; got "${imageVersion}"`);
    }
    super(scope, id, { stackName: stackNameFor(stage, "runner"), ...stackProps });
    this.stage = stage;

    const imported = (key: DataExportKey): string => Fn.importValue(dataExportName(stage, key));
    const tableArn = imported("TableArn");
    const bucketArn = imported("BucketArn");
    const parameterArn = `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${dispatchParameterPrefix(stage)}*`;

    // --- The network: public subnets, no NAT -------------------------------------
    //
    // A run's machine needs the internet (GitHub, npm, the providers) and
    // nothing needs to reach it: SSM Session Manager is the only way in, and it
    // dials out. Public subnets with an internet gateway cost nothing idle; NAT
    // gateways would cost more than the machines some months.
    // Read as the interface: `Vpc`'s optional members are typed `string |
    // undefined`, which `exactOptionalPropertyTypes` will not pass where `IVpc`
    // is wanted, and the constructs below want `IVpc`.
    const vpc: ec2.IVpc = new ec2.Vpc(this, "RunnerVpc", {
      maxAzs: 4,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20 }],
    }) as unknown as ec2.IVpc;
    const builderSubnet = vpc.publicSubnets[0];
    if (builderSubnet === undefined) throw new Error("the runner VPC has no public subnet");
    const machineSecurityGroup = new ec2.SecurityGroup(this, "MachineSecurityGroup", {
      vpc,
      description: "Nightshift run machines: no inbound; egress only.",
      allowAllOutbound: true,
    });

    // --- The image (D-P10-16) ----------------------------------------------------
    const builderRole = new iam.Role(this, "ImageBuilderInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "The build instance Image Builder runs the Nightshift recipe on.",
    });
    // What Image Builder's own managed policy grants a build instance, inlined
    // so the stack attaches no managed policy and the test can read every action.
    builderRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "imagebuilder:GetComponent",
          "imagebuilder:GetMarketplaceResource",
          "ec2:DescribeTags",
          "ssm:UpdateInstanceInformation",
          "ssm:ListAssociations",
          "ssm:ListInstanceAssociations",
          "ssm:GetDocument",
          "ssm:DescribeDocument",
          "ssm:GetManifest",
          "ssm:PutInventory",
          "ssm:PutComplianceItems",
          "ssm:UpdateAssociationStatus",
          "ssm:UpdateInstanceAssociationStatus",
          "ssm:DescribeAssociation",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
          "ec2messages:AcknowledgeMessage",
          "ec2messages:DeleteMessage",
          "ec2messages:FailMessage",
          "ec2messages:GetEndpoint",
          "ec2messages:GetMessages",
          "ec2messages:SendReply",
        ],
        // These Image Builder and SSM agent calls take no resource; the build
        // instance is short-lived and holds nothing of Nightshift's.
        resources: ["*"],
      }),
    );
    // The build's own log, in CloudWatch under `/aws/imagebuilder/<pipeline>`,
    // which Image Builder writes when and only when the instance may: a failed
    // component with no log is a guess, and the first build was one.
    builderRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/imagebuilder/*`,
        ],
      }),
    );
    const builderProfile = new iam.CfnInstanceProfile(this, "ImageBuilderInstanceProfile", {
      roles: [builderRole.roleName],
    });

    const components = [
      ["Toolchain", toolchainComponent()],
      ["Containment", containmentComponent()],
      ["Runner", runnerComponent(runnerCommit)],
    ].map(
      ([name, data]) =>
        new imagebuilder.CfnComponent(this, `${name}Component`, {
          name: `nightshift-${stage}-${(name as string).toLowerCase()}`,
          platform: "Linux",
          version: imageVersion,
          data: data as string,
        }),
    );
    const recipe = new imagebuilder.CfnImageRecipe(this, "RunnerRecipe", {
      name: `nightshift-${stage}-runner`,
      version: imageVersion,
      parentImage: `{{resolve:ssm:${AL2023_ARM64_PARAMETER}}}`,
      components: components.map((component) => ({ componentArn: component.attrArn })),
      blockDeviceMappings: [
        {
          deviceName: "/dev/xvda",
          ebs: { volumeSize: 40, volumeType: "gp3", deleteOnTermination: true },
        },
      ],
      additionalInstanceConfiguration: { systemsManagerAgent: { uninstallAfterBuild: false } },
      tags: { [AMI_VERSION_TAG]: imageVersion },
    });
    const infrastructure = new imagebuilder.CfnInfrastructureConfiguration(
      this,
      "RunnerImageInfrastructure",
      {
        name: `nightshift-${stage}-runner`,
        instanceProfileName: builderProfile.ref,
        // The image is arm64 (D-P10-13); a Graviton builder keeps native modules honest.
        instanceTypes: ["m7g.large"],
        subnetId: builderSubnet.subnetId,
        securityGroupIds: [machineSecurityGroup.securityGroupId],
        terminateInstanceOnFailure: true,
      },
    );
    const distribution = new imagebuilder.CfnDistributionConfiguration(this, "RunnerDistribution", {
      name: `nightshift-${stage}-runner`,
      distributions: [
        {
          region: Aws.REGION,
          amiDistributionConfiguration: {
            Name: `nightshift-${stage}-runner-{{ imagebuilder:buildDate }}`,
            AmiTags: { [AMI_VERSION_TAG]: imageVersion, [MANAGED_TAG]: "true" },
          },
        },
      ],
    });
    const pipeline = new imagebuilder.CfnImagePipeline(this, "RunnerPipeline", {
      name: `nightshift-${stage}-runner`,
      imageRecipeArn: recipe.attrArn,
      infrastructureConfigurationArn: infrastructure.attrArn,
      distributionConfigurationArn: distribution.attrArn,
      // Run by hand (`npm run image:build`), never on a schedule: an image is a
      // version, and a version is a decision.
      status: "ENABLED",
      imageTestsConfiguration: { imageTestsEnabled: false },
    });

    // --- The machines' identity (D-P10-17) ---------------------------------------
    //
    // What the runner may do with the machine's role, and all of it: read its
    // first engine token (a parameter under the dispatch prefix, which it
    // deletes on first read), write its own run's artifacts, and reach SSM for
    // a session an operator opens. No DynamoDB, no KMS, no EC2: the control
    // plane is reached through the API with an execution token, and only the
    // reconciler and the dispatch Lambda ever touch a machine.
    const machineRole = new iam.Role(this, "MachineRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "A Nightshift run's machine: its first token, its artifacts, a session.",
    });
    machineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:DeleteParameter"],
        resources: [parameterArn],
      }),
    );
    machineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        // A run's bundles and logs land under its own prefix; the engine's token
        // decides which run, and the signed upload route pins the key (A-08).
        resources: [`${bucketArn}/proj_*`],
      }),
    );
    machineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:UpdateInstanceInformation",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        resources: ["*"],
      }),
    );
    const machineProfile = new iam.CfnInstanceProfile(this, "MachineInstanceProfile", {
      roles: [machineRole.roleName],
    });

    const launchTemplate = new ec2.CfnLaunchTemplate(this, "MachineLaunchTemplate", {
      launchTemplateName: `nightshift-${stage}-machine`,
      launchTemplateData: {
        iamInstanceProfile: { arn: machineProfile.attrArn },
        securityGroupIds: [machineSecurityGroup.securityGroupId],
        // IMDSv2 only, one hop (so a container cannot reach it through the host),
        // and the instance's tags in its metadata: that is how the runner learns
        // which run it is (D-P10-18).
        metadataOptions: {
          httpTokens: "required",
          httpPutResponseHopLimit: 1,
          instanceMetadataTags: "enabled",
        },
        ebsOptimized: true,
        monitoring: { enabled: false },
        tagSpecifications: [
          { resourceType: "instance", tags: [{ key: MANAGED_TAG, value: "true" }] },
          { resourceType: "volume", tags: [{ key: MANAGED_TAG, value: "true" }] },
        ],
      },
    });

    // --- The functions (D-P10-21) -------------------------------------------------
    const environment = {
      NIGHTSHIFT_TABLE_NAME: imported("TableName"),
      NIGHTSHIFT_BUCKET_NAME: imported("BucketName"),
      NIGHTSHIFT_STAGE: stage,
      NIGHTSHIFT_API_ENDPOINT: `https://${apiHostnameFor(stage)}`,
    };
    const managedOnly = { StringEquals: { [`aws:ResourceTag/${MANAGED_TAG}`]: "true" } };

    /** What makes a machine: the template, the subnets, the image version, the token key (T3). */
    const machineEnvironment = {
      NIGHTSHIFT_LAUNCH_TEMPLATE_ID: launchTemplate.ref,
      NIGHTSHIFT_MACHINE_SUBNETS: Fn.join(
        ",",
        vpc.publicSubnets.map((subnet) => subnet.subnetId),
      ),
      NIGHTSHIFT_IMAGE_VERSION: imageVersion,
      NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID: imported("ExecutionTokenKeyId"),
      NIGHTSHIFT_TOKEN_ISSUER: `https://${apiHostnameFor(stage)}`,
    };

    const dispatchLogs = this.logGroup("DispatchFunctionLogs");
    const dispatchRole = this.executionRole("DispatchFunctionRole", dispatchLogs, [
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
        resources: [tableArn],
      }),
      // Launch a machine from the one template, create its volume (from a
      // snapshot or empty), and tag what it makes. `RunInstances` needs the
      // template, the image, the subnet, the security group, the network
      // interface and the volume as well as the instance: the resource types
      // are named, and the instance and volume must carry the managed tag.
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: [
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:volume/*`,
        ],
        conditions: { StringEquals: { [`aws:RequestTag/${MANAGED_TAG}`]: "true" } },
      }),
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: [
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:launch-template/${launchTemplate.ref}`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:network-interface/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:security-group/${machineSecurityGroup.securityGroupId}`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:subnet/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::image/ami-*`,
          // The workspace volume is made at launch from the warm snapshot (D-P10-15).
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::snapshot/*`,
        ],
      }),
      new iam.PolicyStatement({
        actions: ["ec2:CreateVolume", "ec2:CreateTags"],
        resources: [
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:volume/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::snapshot/*`,
        ],
      }),
      new iam.PolicyStatement({
        actions: ["ec2:AttachVolume", "ec2:TerminateInstances", "ec2:DeleteVolume"],
        resources: [
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:volume/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`,
        ],
        conditions: managedOnly,
      }),
      new iam.PolicyStatement({
        actions: [
          "ec2:DescribeInstances",
          "ec2:DescribeVolumes",
          "ec2:DescribeImages",
          "ec2:DescribeSnapshots",
        ],
        resources: ["*"],
      }),
      iam.PolicyStatement.fromJson({
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: machineRole.roleArn,
        Condition: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      }),
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [parameterArn],
      }),
      new iam.PolicyStatement({
        actions: ["kms:Sign"],
        resources: [imported("ExecutionTokenKeyArn")],
      }),
    ]);
    const dispatchFunction = this.nodeFunction("DispatchFunction", {
      entry: DISPATCH_ENTRY,
      role: dispatchRole,
      logGroup: dispatchLogs,
      environment: {
        ...environment,
        ...machineEnvironment,
      },
      timeout: Duration.minutes(2),
      memorySize: 512,
    });

    const reconcilerLogs = this.logGroup("ReconcilerFunctionLogs");
    const reconcilerRole = this.executionRole("ReconcilerFunctionRole", reconcilerLogs, [
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [tableArn],
      }),
      // The reconciler's one cross-project read, every dispatch by status, is a
      // query on the node index (A-07's named exception); the first live run
      // found the grant stopped at the table.
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [tableArn, `${tableArn}/index/${NODE_INDEX_NAME}`],
      }),
      new iam.PolicyStatement({
        actions: ["ec2:TerminateInstances", "ec2:DeleteVolume", "ec2:DeleteSnapshot"],
        resources: [
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:volume/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::snapshot/*`,
        ],
        conditions: managedOnly,
      }),
      // A snapshot is taken of a managed volume (its tag is on the volume) and
      // is born carrying the managed tag (the request's). A resource-tag
      // condition on the snapshot itself can never match a snapshot that does
      // not exist yet: the first live run found that out.
      new iam.PolicyStatement({
        actions: ["ec2:CreateSnapshot"],
        resources: [`arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:volume/*`],
        conditions: managedOnly,
      }),
      new iam.PolicyStatement({
        actions: ["ec2:CreateSnapshot"],
        resources: [`arn:${Aws.PARTITION}:ec2:${Aws.REGION}::snapshot/*`],
        conditions: { StringEquals: { [`aws:RequestTag/${MANAGED_TAG}`]: "true" } },
      }),
      new iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: [`arn:${Aws.PARTITION}:ec2:${Aws.REGION}::snapshot/*`],
        conditions: { StringEquals: { "ec2:CreateAction": "CreateSnapshot" } },
      }),
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeSnapshots"],
        resources: ["*"],
      }),
      // The reconciler provisions what the API's invocation did not reach and
      // launches replacements (T6), so it makes machines as the dispatch does.
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: [
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:volume/*`,
        ],
        conditions: { StringEquals: { [`aws:RequestTag/${MANAGED_TAG}`]: "true" } },
      }),
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: [
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:launch-template/${launchTemplate.ref}`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:network-interface/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:security-group/${machineSecurityGroup.securityGroupId}`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:subnet/*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::image/ami-*`,
          `arn:${Aws.PARTITION}:ec2:${Aws.REGION}::snapshot/*`,
        ],
      }),
      new iam.PolicyStatement({
        actions: ["ec2:DescribeImages"],
        resources: ["*"],
      }),
      iam.PolicyStatement.fromJson({
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: machineRole.roleArn,
        Condition: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      }),
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [parameterArn],
      }),
      new iam.PolicyStatement({
        actions: ["kms:Sign"],
        resources: [imported("ExecutionTokenKeyArn")],
      }),
    ]);
    const reconcilerFunction = this.nodeFunction("ReconcilerFunction", {
      entry: RECONCILER_ENTRY,
      role: reconcilerRole,
      logGroup: reconcilerLogs,
      environment: { ...environment, ...machineEnvironment },
      timeout: Duration.seconds(50),
      memorySize: 512,
    });
    new events.Rule(this, "ReconcilerSchedule", {
      schedule: events.Schedule.rate(RECONCILER_INTERVAL),
      targets: [new targets.LambdaFunction(reconcilerFunction)],
    });

    const publisherLogs = this.logGroup("PublisherFunctionLogs");
    const publisherRole = this.executionRole("PublisherFunctionRole", publisherLogs, [
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [tableArn],
      }),
      // The bundles the engine uploaded, read back to push (D-P10-22).
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${bucketArn}/proj_*`],
      }),
      // The GitHub App's key: the publisher's alone, in the whole account (D-P10-17).
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:${Aws.PARTITION}:secretsmanager:${Aws.REGION}:${Aws.ACCOUNT_ID}:secret:${GITHUB_APP_SECRET_NAME}-*`,
        ],
      }),
    ]);
    const publisherFunction = this.nodeFunction("PublisherFunction", {
      entry: PUBLISHER_ENTRY,
      role: publisherRole,
      logGroup: publisherLogs,
      environment: { ...environment, NIGHTSHIFT_GITHUB_APP_SECRET: GITHUB_APP_SECRET_NAME },
      timeout: Duration.minutes(5),
      memorySize: 1024,
      // One push at a time, anywhere (D-P10-22): two resolutions of one branch
      // must never race, and the lease makes the serial order the safe one.
      reservedConcurrentExecutions: 1,
    });

    // --- Outputs ------------------------------------------------------------------
    new CfnOutput(this, "ImagePipelineArn", { value: pipeline.attrArn });
    new CfnOutput(this, "ImageVersion", { value: imageVersion });
    new CfnOutput(this, "RunnerCommit", { value: runnerCommit });
    new CfnOutput(this, "LaunchTemplateId", { value: launchTemplate.ref });
    new CfnOutput(this, "MachineSubnetIds", {
      value: Fn.join(
        ",",
        vpc.publicSubnets.map((subnet) => subnet.subnetId),
      ),
    });
    new CfnOutput(this, "MachineSecurityGroupId", { value: machineSecurityGroup.securityGroupId });
    new CfnOutput(this, "MachineInstanceProfileArn", { value: machineProfile.attrArn });
    new CfnOutput(this, "DispatchFunctionName", { value: dispatchFunction.functionName });
    // The API stack imports this by name to invoke the dispatch Lambda (D-P10-18).
    new CfnOutput(this, "DispatchFunctionArn", {
      value: dispatchFunction.functionArn,
      exportName: runnerExportName(stage, "DispatchFunctionArn"),
    });
    new CfnOutput(this, "ReconcilerFunctionName", { value: reconcilerFunction.functionName });
    new CfnOutput(this, "PublisherFunctionName", { value: publisherFunction.functionName });
    new CfnOutput(this, "PublisherFunctionArn", {
      value: publisherFunction.functionArn,
      exportName: runnerExportName(stage, "PublisherFunctionArn"),
    });
    new CfnOutput(this, "WorkerUsers", { value: String(WORKER_USERS) });
    new CfnOutput(this, "Toolchain", { value: JSON.stringify(RUNNER_TOOLCHAIN) });
  }

  private logGroup(id: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  private executionRole(
    id: string,
    logGroup: logs.LogGroup,
    statements: readonly iam.PolicyStatement[],
  ): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );
    for (const statement of statements) role.addToPolicy(statement);
    return role;
  }

  private nodeFunction(
    id: string,
    props: Required<
      Pick<
        nodejs.NodejsFunctionProps,
        "entry" | "role" | "logGroup" | "environment" | "timeout" | "memorySize"
      >
    > &
      Pick<nodejs.NodejsFunctionProps, "reservedConcurrentExecutions">,
  ): nodejs.NodejsFunction {
    return new nodejs.NodejsFunction(this, id, {
      ...props,
      environment: { ...props.environment, NODE_OPTIONS: "--enable-source-maps" },
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      projectRoot: REPO_ROOT,
      depsLockFilePath: `${REPO_ROOT}package-lock.json`,
      bundling: {
        format: nodejs.OutputFormat.CJS,
        target: "node24",
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    });
  }
}
