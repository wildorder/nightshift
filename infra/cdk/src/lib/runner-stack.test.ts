/**
 * The runner stack (P10, T2): the image pipeline, the machines' identity, the
 * three functions, and least privilege over all of it.
 */
import { App, Token } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { dataExportName } from "./data-exports.js";
import { ENGINE_USER, RUNNER_TOOLCHAIN, WORKER_USERS } from "./runner-image.js";
import {
  AMI_VERSION_TAG,
  dispatchParameterPrefix,
  GITHUB_APP_SECRET_NAME,
  MANAGED_TAG,
  NightshiftRunnerStack,
} from "./runner-stack.js";
import { composeNightshiftStacks } from "./stacks.js";

const COMMIT = "3bf02c0a3bf02c0a3bf02c0a3bf02c0a3bf02c0a";

const testApp = (context: Record<string, unknown> = {}): App =>
  new App({ context: { "aws:cdk:bundling-stacks": [], ...context } });

const synth = (stage = "dev") => {
  const stack = new NightshiftRunnerStack(testApp(), "Runner", {
    stage,
    runnerCommit: COMMIT,
    imageVersion: "1.0.0",
  });
  return { stack, template: Template.fromStack(stack) };
};

type Resource = { Type: string; Properties?: Record<string, unknown> };

const resourcesOf = (template: Template, type: string): Resource[] =>
  Object.values(template.findResources(type)) as Resource[];

const resourceNamed = (template: Template, type: string, prefix: string): Resource => {
  const found = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  );
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${type} named ${prefix}*, found ${found.length}`);
  }
  return found[0]?.[1] as Resource;
};

const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
};

interface Statement {
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

const property = <T>(resource: Resource | undefined, name: string): T => {
  const value = resource?.Properties?.[name];
  if (value === undefined) throw new Error(`resource has no ${name}`);
  return value as T;
};

const statementsOf = (template: Template): Statement[] =>
  resourcesOf(template, "AWS::IAM::Policy").flatMap(
    (policy) => property<{ Statement: Statement[] }>(policy, "PolicyDocument").Statement,
  );

const actionsOf = (statement: Statement): string[] =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];

/** The non-logging actions granted to the role whose logical id starts with `rolePrefix`. */
const actionsOfRole = (template: Template, rolePrefix: string): Set<string> =>
  new Set(
    resourcesOf(template, "AWS::IAM::Policy")
      .filter((policy) =>
        stringsIn(policy.Properties?.Roles).some((ref) => ref.startsWith(rolePrefix)),
      )
      .flatMap((policy) => property<{ Statement: Statement[] }>(policy, "PolicyDocument").Statement)
      .flatMap(actionsOf)
      .filter((action) => !action.startsWith("logs:")),
  );

describe("NightshiftRunnerStack", () => {
  it("synthesizes, named nightshift-<stage>-runner, environment-agnostic", () => {
    const { stack, template } = synth();
    expect(Object.keys(template.toJSON().Resources ?? {}).length).toBeGreaterThan(0);
    expect(stack.stackName).toBe("nightshift-dev-runner");
    expect(Token.isUnresolved(stack.account)).toBe(true);
    expect(synth("staging").stack.stackName).toBe("nightshift-staging-runner");
  });

  it("refuses a short commit or a version that is not semantic", () => {
    expect(
      () =>
        new NightshiftRunnerStack(testApp(), "Bad", {
          stage: "dev",
          runnerCommit: "abc123",
          imageVersion: "1.0.0",
        }),
    ).toThrow(/full commit SHA/);
    expect(
      () =>
        new NightshiftRunnerStack(testApp(), "Bad", {
          stage: "dev",
          runnerCommit: COMMIT,
          imageVersion: "latest",
        }),
    ).toThrow(/semantic version/);
  });

  it("consumes the data stack only through export names", () => {
    const json = JSON.stringify(synth().template.toJSON());
    for (const key of ["TableName", "TableArn", "BucketName", "BucketArn"] as const) {
      expect(json).toContain(dataExportName("dev", key));
    }
    expect(json).not.toContain("Credentials");
  });

  describe("the image (D-P10-16, D-P10-17)", () => {
    it("builds from Amazon Linux 2023 arm64 with three versioned components, run by hand", () => {
      const { template } = synth();
      const recipe = resourceNamed(template, "AWS::ImageBuilder::ImageRecipe", "RunnerRecipe");
      expect(recipe.Properties?.ParentImage).toContain("al2023-ami-kernel-default-arm64");
      expect(recipe.Properties?.Version).toBe("1.0.0");
      const components = resourcesOf(template, "AWS::ImageBuilder::Component");
      expect(components).toHaveLength(3);
      for (const component of components) expect(component.Properties?.Version).toBe("1.0.0");
      const pipeline = resourceNamed(
        template,
        "AWS::ImageBuilder::ImagePipeline",
        "RunnerPipeline",
      );
      expect(pipeline.Properties?.Schedule).toBeUndefined();
      const infrastructure = resourceNamed(
        template,
        "AWS::ImageBuilder::InfrastructureConfiguration",
        "RunnerImageInfrastructure",
      );
      expect(infrastructure.Properties?.InstanceTypes).toEqual(["m7g.large"]);
    });

    it("pins every tool it installs, and builds the runner from the named commit", () => {
      const data = resourcesOf(synth().template, "AWS::ImageBuilder::Component")
        .map((component) => String(component.Properties?.Data))
        .join("\n");
      expect(data).toContain(`node-v${RUNNER_TOOLCHAIN.node}-linux-arm64`);
      expect(data).toContain(`pnpm@${RUNNER_TOOLCHAIN.pnpm}`);
      expect(data).toContain(`@anthropic-ai/claude-code@${RUNNER_TOOLCHAIN.claude}`);
      expect(data).toContain(`@openai/codex@${RUNNER_TOOLCHAIN.codex}`);
      expect(data).toContain(`git checkout --detach ${COMMIT}`);
      expect(data).not.toMatch(/@latest/);
    });

    it("lays down the engine, the worker users, the sudoers rule and the IMDS firewall", () => {
      const data = resourcesOf(synth().template, "AWS::ImageBuilder::Component")
        .map((component) => String(component.Properties?.Data))
        .join("\n");
      expect(data).toContain(`useradd --system --create-home --home-dir /home/${ENGINE_USER}`);
      expect(data).toContain(`useradd --create-home --home-dir /home/worker-${WORKER_USERS}`);
      expect(data).toContain(`${ENGINE_USER} ALL=(WORKERS) NOPASSWD: ALL`);
      expect(data).toContain("169.254.169.254");
      expect(data).toContain(`meta skuid != \\"${ENGINE_USER}\\"`);
      expect(data).toContain("systemctl disable --now docker.service");
      expect(data).toContain(`User=${ENGINE_USER}`);
    });

    it("tags the AMI with its version and the managed tag", () => {
      const distribution = resourceNamed(
        synth().template,
        "AWS::ImageBuilder::DistributionConfiguration",
        "RunnerDistribution",
      );
      const json = JSON.stringify(distribution.Properties);
      expect(json).toContain(AMI_VERSION_TAG);
      expect(json).toContain(MANAGED_TAG);
    });
  });

  describe("the machines (D-P10-17, D-P10-18)", () => {
    it("launch into public subnets with no NAT, no inbound, IMDSv2 only, tags in metadata", () => {
      const { template } = synth();
      template.resourceCountIs("AWS::EC2::NatGateway", 0);
      expect(resourcesOf(template, "AWS::EC2::Subnet").length).toBeGreaterThanOrEqual(2);
      const group = resourceNamed(template, "AWS::EC2::SecurityGroup", "MachineSecurityGroup");
      expect(group.Properties?.SecurityGroupIngress).toBeUndefined();
      const launch = resourceNamed(template, "AWS::EC2::LaunchTemplate", "MachineLaunchTemplate");
      const data = property<Record<string, unknown>>(launch, "LaunchTemplateData");
      expect(data.MetadataOptions).toEqual({
        HttpTokens: "required",
        HttpPutResponseHopLimit: 1,
        InstanceMetadataTags: "enabled",
      });
      expect(JSON.stringify(data.TagSpecifications)).toContain(MANAGED_TAG);
    });

    it("gives the machine's role its first token, its artifacts and a session, and nothing else", () => {
      const actions = actionsOfRole(synth().template, "MachineRole");
      expect(actions).toEqual(
        new Set([
          "ssm:GetParameter",
          "ssm:DeleteParameter",
          "s3:PutObject",
          "ssm:UpdateInstanceInformation",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]),
      );
      for (const action of actions) {
        expect(action.startsWith("dynamodb:") || action.startsWith("kms:")).toBe(false);
        expect(action.startsWith("ec2:")).toBe(false);
      }
      const parameters = statementsOf(synth().template).filter((statement) =>
        actionsOf(statement).includes("ssm:GetParameter"),
      );
      expect(JSON.stringify(parameters[0]?.Resource)).toContain(dispatchParameterPrefix("dev"));
    });
  });

  describe("the functions (D-P10-21)", () => {
    it("runs three functions on Node 24 arm64, the reconciler every minute", () => {
      const { template } = synth();
      const functions = resourcesOf(template, "AWS::Lambda::Function");
      expect(functions).toHaveLength(3);
      for (const fn of functions) {
        expect(fn.Properties?.Runtime).toBe("nodejs24.x");
        expect(fn.Properties?.Architectures).toEqual(["arm64"]);
      }
      template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(1 minute)" });
    });

    it("lets only the publisher read the GitHub App's secret, and no machine", () => {
      const { template } = synth();
      const secretReaders = resourcesOf(template, "AWS::IAM::Policy").filter((policy) =>
        JSON.stringify(policy.Properties?.PolicyDocument).includes("secretsmanager:GetSecretValue"),
      );
      expect(secretReaders).toHaveLength(1);
      expect(stringsIn(secretReaders[0]?.Properties?.Roles)[0]).toMatch(/^PublisherFunctionRole/);
      expect(JSON.stringify(secretReaders[0]?.Properties?.PolicyDocument)).toContain(
        GITHUB_APP_SECRET_NAME,
      );
    });

    it("lets the dispatch and the reconciler touch only managed machines and volumes", () => {
      const mutating = statementsOf(synth().template).filter((statement) =>
        actionsOf(statement).some((action) =>
          [
            "ec2:TerminateInstances",
            "ec2:DeleteVolume",
            "ec2:AttachVolume",
            "ec2:CreateSnapshot",
          ].includes(action),
        ),
      );
      expect(mutating.length).toBeGreaterThan(0);
      for (const statement of mutating) {
        expect(statement.Condition).toEqual({
          StringEquals: { [`aws:ResourceTag/${MANAGED_TAG}`]: "true" },
        });
      }
    });

    it("passes only the machine's role to EC2, from the two functions that make machines", () => {
      const { template } = synth();
      const passes = statementsOf(template).filter((statement) =>
        actionsOf(statement).includes("iam:PassRole"),
      );
      // The dispatch Lambda and the reconciler (which provisions what the API's
      // invocation did not reach, and replacements in T6); never the publisher.
      expect(passes).toHaveLength(2);
      for (const pass of passes) {
        expect(JSON.stringify(pass.Resource)).toContain("MachineRole");
        expect(pass.Condition).toEqual({
          StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" },
        });
      }
      expect(actionsOfRole(template, "DispatchFunctionRole")).toContain("kms:Sign");
      expect(actionsOfRole(template, "ReconcilerFunctionRole")).toContain("kms:Sign");
      expect(actionsOfRole(template, "PublisherFunctionRole")).not.toContain("kms:Sign");
      expect(actionsOfRole(template, "PublisherFunctionRole")).not.toContain("ec2:RunInstances");
    });

    it("exports the dispatch function's ARN for the API stack to invoke", () => {
      const { template } = synth();
      const outputs = template.toJSON().Outputs as Record<string, { Export?: { Name?: string } }>;
      expect(outputs.DispatchFunctionArn?.Export?.Name).toBe(
        "nightshift-dev-runner-DispatchFunctionArn",
      );
    });

    it("attaches no managed policy to any role, and no wildcard action anywhere", () => {
      const { template } = synth();
      for (const role of resourcesOf(template, "AWS::IAM::Role")) {
        expect(role.Properties?.ManagedPolicyArns).toBeUndefined();
      }
      for (const statement of statementsOf(template)) {
        for (const action of actionsOf(statement)) expect(action).not.toContain("*");
      }
    });

    it("logs to explicit groups with 30-day retention", () => {
      const groups = resourcesOf(synth().template, "AWS::Logs::LogGroup");
      expect(groups.length).toBe(3);
      for (const group of groups) expect(group.Properties?.RetentionInDays).toBe(30);
    });
  });
});

describe("the whole app, with and without the runner", () => {
  it("builds the runner stack only when runnerCommit is given", () => {
    const without = composeNightshiftStacks(testApp({ hostnames: "zone-only" }));
    expect(without.runner).toBeUndefined();
    const withRunner = composeNightshiftStacks(
      testApp({ hostnames: "zone-only", runnerCommit: COMMIT }),
    );
    expect(withRunner.runner?.stackName).toBe("nightshift-dev-runner");
    expect(withRunner.runner?.dependencies.map((stack) => stack.stackName)).toContain(
      "nightshift-dev-data",
    );
  });
});
