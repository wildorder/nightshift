import { App, Token } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { NightshiftApiStack, STREAM_BATCH_SIZE, STREAM_RETRY_ATTEMPTS } from "./api-stack.js";
import { DATA_EXPORT_KEYS, dataExportName } from "./data-exports.js";
import { NightshiftDataStack } from "./data-stack.js";

/**
 * An app that skips asset bundling. Bundling runs esbuild over the compiled API
 * and proves nothing these assertions check; `npm run synth` bundles for real.
 */
const testApp = (): App => new App({ context: { "aws:cdk:bundling-stacks": [] } });

const synth = (stage = "dev") => {
  const stack = new NightshiftApiStack(testApp(), "Api", { stage });
  return { stack, template: Template.fromStack(stack) };
};

type Resource = { Type: string; Properties?: Record<string, unknown> };

const resourcesOf = (template: Template, type: string): Resource[] =>
  Object.values(template.findResources(type)) as Resource[];

/** Every string anywhere inside a CloudFormation value, intrinsics included. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
};

interface Statement {
  Action: string | string[];
  Resource: unknown;
}

/** A property the test requires to exist, typed by the caller; throws if absent. */
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

describe("NightshiftApiStack", () => {
  it("synthesizes", () => {
    expect(() => synth()).not.toThrow();
  });

  it("is named nightshift-<stage>-api, including for a non-default stage", () => {
    const app = testApp();
    expect(new NightshiftApiStack(app, "Dev", { stage: "dev" }).stackName).toBe(
      "nightshift-dev-api",
    );
    const staging = new NightshiftApiStack(app, "Staging", { stage: "staging" });
    expect(staging.stackName).toBe("nightshift-staging-api");
    expect(staging.stage).toBe("staging");
  });

  it("is stateless, so it carries no termination protection and can be replaced", () => {
    expect(synth().stack.terminationProtection).toBe(false);
  });

  it("is environment-agnostic, so synth needs no account", () => {
    const app = testApp();
    const stack = new NightshiftApiStack(app, "Api", { stage: "dev" });
    expect(Token.isUnresolved(stack.account)).toBe(true);
    expect(Token.isUnresolved(stack.region)).toBe(true);
    expect(app.synth().getStackByName(stack.stackName).environment.name).toBe(
      "aws://unknown-account/unknown-region",
    );
  });

  it("can depend on the data stack without a construct reference", () => {
    const app = testApp();
    const data = new NightshiftDataStack(app, "Data", { stage: "dev" });
    const api = new NightshiftApiStack(app, "Api", { stage: "dev" });
    api.addStackDependency(data, "imports the data stack's exports by name");
    expect(api.dependencies).toEqual([data]);
  });

  it("consumes the data stack only through its stage's export names", () => {
    const { template } = synth("staging");
    const imports = new Set(
      JSON.stringify(template.toJSON())
        .match(/"Fn::ImportValue":"[^"]+"/g)
        ?.map((match) => match.slice('"Fn::ImportValue":"'.length, -1)),
    );
    expect(imports.size).toBeGreaterThan(0);
    const allowed = new Set(DATA_EXPORT_KEYS.map((key) => dataExportName("staging", key)));
    for (const name of imports) expect(allowed.has(name), name).toBe(true);
  });

  describe("authentication (A-19)", () => {
    it("binds every route to the Cognito JWT authorizer, leaving none anonymous", () => {
      const { template } = synth();
      const routes = resourcesOf(template, "AWS::ApiGatewayV2::Route");
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.Properties?.AuthorizationType).toBe("JWT");
        expect(route.Properties?.AuthorizerId).toBeDefined();
      }
    });

    it("trusts the user pool as issuer and both app clients as audience", () => {
      const { template } = synth();
      template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
        AuthorizerType: "JWT",
        IdentitySource: ["$request.header.Authorization"],
        JwtConfiguration: {
          Issuer: Match.anyValue(),
          Audience: [
            { "Fn::ImportValue": dataExportName("dev", "InteractiveClientId") },
            { "Fn::ImportValue": dataExportName("dev", "MachineClientId") },
          ],
        },
      });
      const authorizer = resourcesOf(template, "AWS::ApiGatewayV2::Authorizer")[0];
      const issuer = stringsIn(authorizer?.Properties?.JwtConfiguration);
      expect(issuer.some((part) => part.includes("cognito-idp."))).toBe(true);
      expect(issuer).toContain(dataExportName("dev", "UserPoolId"));
    });

    it("serves the $default stage, so the handler sees unprefixed paths", () => {
      synth().template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        StageName: "$default",
        AutoDeploy: true,
      });
    });
  });

  describe("least privilege", () => {
    it("grants no wildcard action and no wildcard resource beyond a function's own log streams", () => {
      const statements = statementsOf(synth().template);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        const actions = actionsOf(statement);
        expect(
          actions.every((action) => !action.includes("*")),
          actions.join(),
        ).toBe(true);
        const resources = stringsIn(statement.Resource);
        expect(resources).not.toContain("*");
        const wildcarded = resources.filter((resource) => resource.includes("*"));
        if (wildcarded.length === 0) continue;
        // The one tolerated form: CloudFormation's log group ARN, which ends `:*`
        // to name the streams inside that single group.
        expect(actions.every((action) => action.startsWith("logs:"))).toBe(true);
      }
    });

    it("attaches no managed policy to any role", () => {
      for (const role of resourcesOf(synth().template, "AWS::IAM::Role")) {
        expect(role.Properties?.ManagedPolicyArns).toBeUndefined();
      }
    });

    /** The non-logging actions granted to the role whose logical id starts with `rolePrefix`. */
    const dataActionsOf = (template: Template, rolePrefix: string): Set<string> =>
      new Set(
        resourcesOf(template, "AWS::IAM::Policy")
          .filter((policy) =>
            stringsIn(policy.Properties?.Roles).some((ref) => ref.startsWith(rolePrefix)),
          )
          .flatMap(
            (policy) => property<{ Statement: Statement[] }>(policy, "PolicyDocument").Statement,
          )
          .flatMap(actionsOf)
          .filter((action) => !action.startsWith("logs:")),
      );

    it("gives the API function exactly the DynamoDB actions its adapters use", () => {
      expect(dataActionsOf(synth().template, "ApiFunctionRole")).toEqual(
        new Set(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]),
      );
    });

    it("gives the materializer the stream, its reads and writes, and its dead-letter queue", () => {
      const actions = dataActionsOf(synth().template, "MaterializerFunctionRole");
      const dynamo = [...actions].filter((action) => action.startsWith("dynamodb:"));
      expect(new Set(dynamo)).toEqual(
        new Set([
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]),
      );
      expect([...actions].filter((action) => !action.startsWith("dynamodb:"))).toContain(
        "sqs:SendMessage",
      );
    });

    it("grants no S3 action to anything", () => {
      const all = statementsOf(synth().template).flatMap(actionsOf);
      expect(all.some((action) => action.startsWith("s3:"))).toBe(false);
    });
  });

  describe("functions", () => {
    it("runs every function on Node 22, arm64", () => {
      const functions = resourcesOf(synth().template, "AWS::Lambda::Function");
      expect(functions).toHaveLength(2);
      for (const fn of functions) {
        expect(fn.Properties?.Runtime).toBe("nodejs22.x");
        expect(fn.Properties?.Architectures).toEqual(["arm64"]);
      }
    });

    it("configures functions with table, bucket, stage and source maps, and nothing secret", () => {
      for (const fn of resourcesOf(synth().template, "AWS::Lambda::Function")) {
        const { Variables: variables } = property<{ Variables: Record<string, unknown> }>(
          fn,
          "Environment",
        );
        expect(Object.keys(variables).sort()).toEqual(
          [
            "NIGHTSHIFT_BUCKET_NAME",
            "NIGHTSHIFT_STAGE",
            "NIGHTSHIFT_TABLE_NAME",
            "NODE_OPTIONS",
          ].sort(),
        );
      }
    });

    it("logs to explicit groups with 30-day retention (D-P2-10)", () => {
      const { template } = synth();
      const groups = template.findResources("AWS::Logs::LogGroup");
      expect(Object.keys(groups)).toHaveLength(2);
      for (const group of Object.values(groups) as Resource[]) {
        expect(group.Properties?.RetentionInDays).toBe(30);
      }
      for (const fn of resourcesOf(template, "AWS::Lambda::Function")) {
        const { LogGroup: logGroup } = property<{ LogGroup: { Ref: string } }>(fn, "LoggingConfig");
        expect(Object.keys(groups)).toContain(logGroup.Ref);
      }
    });
  });

  describe("stream consumer (T6)", () => {
    it("reports partial batch failures, keeps shard order, and has a dead-letter queue", () => {
      const { template } = synth();
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        EventSourceArn: { "Fn::ImportValue": dataExportName("dev", "TableStreamArn") },
        FunctionResponseTypes: ["ReportBatchItemFailures"],
        StartingPosition: "TRIM_HORIZON",
        BatchSize: STREAM_BATCH_SIZE,
        MaximumBatchingWindowInSeconds: 0,
        ParallelizationFactor: 1,
        MaximumRetryAttempts: STREAM_RETRY_ATTEMPTS,
        DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
      });
      expect(Object.keys(template.findResources("AWS::SQS::Queue"))).toHaveLength(1);
    });
  });
});
