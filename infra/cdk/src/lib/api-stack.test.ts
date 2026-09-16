import { App, Token } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { NightshiftApiStack, STREAM_BATCH_SIZE, STREAM_RETRY_ATTEMPTS } from "./api-stack.js";
import { DATA_EXPORT_KEYS, dataExportName } from "./data-exports.js";
import { NightshiftDataStack } from "./data-stack.js";
import { NightshiftDnsStack } from "./dns-stack.js";
import { apiHostnameFor, type HostnamesMode, ZONE_NAME } from "./hostnames.js";
import { DNS_EXPORT_KEYS, dnsExportName } from "./stack-props.js";

/**
 * An app that skips asset bundling. Bundling runs esbuild over the compiled API
 * and proves nothing these assertions check; `npm run synth` bundles for real.
 */
const testApp = (): App => new App({ context: { "aws:cdk:bundling-stacks": [] } });

const synth = (stage = "dev", hostnames: HostnamesMode = "full") => {
  const stack = new NightshiftApiStack(testApp(), "Api", { stage, hostnames });
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

  it("consumes the data and DNS stacks only through export names", () => {
    const { template } = synth("staging");
    const imports = new Set(
      JSON.stringify(template.toJSON())
        .match(/"Fn::ImportValue":"[^"]+"/g)
        ?.map((match) => match.slice('"Fn::ImportValue":"'.length, -1)),
    );
    expect(imports.size).toBeGreaterThan(0);
    const allowed = new Set([
      ...DATA_EXPORT_KEYS.map((key) => dataExportName("staging", key)),
      ...DNS_EXPORT_KEYS.map((key) => dnsExportName(key)),
    ]);
    for (const name of imports) expect(allowed.has(name), name).toBe(true);
    // And it does import the zone: that is how the stable hostname is anchored.
    expect(imports.has(dnsExportName("HostedZoneId"))).toBe(true);
  });

  /**
   * D-P3-18. The hostname a client stores is `api.<stage>.nightshift.wildorder.dev`;
   * these pin how it is built and that `zone-only` builds none of it.
   */
  describe("the stable hostname (D-P3-18)", () => {
    it("fronts the API with api.<stage>.nightshift.wildorder.dev, certificate validated in the zone", () => {
      const { stack, template } = synth("staging");
      const hostname = apiHostnameFor("staging");
      expect(hostname).toBe(`api.staging.${ZONE_NAME}`);
      expect(stack.customEndpoint).toBe(`https://${hostname}`);
      template.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: hostname,
        ValidationMethod: "DNS",
        DomainValidationOptions: [
          {
            DomainName: hostname,
            HostedZoneId: { "Fn::ImportValue": dnsExportName("HostedZoneId") },
          },
        ],
      });
      template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
        DomainName: hostname,
        DomainNameConfigurations: [Match.objectLike({ EndpointType: "REGIONAL" })],
      });
      template.hasResourceProperties("AWS::ApiGatewayV2::ApiMapping", { Stage: "$default" });
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `${hostname}.`,
        Type: "A",
        HostedZoneId: { "Fn::ImportValue": dnsExportName("HostedZoneId") },
        AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
      });
      template.hasOutput("ApiCustomEndpoint", { Value: `https://${hostname}` });
    });

    it("pins the literal the CLI restates, so the two rules cannot drift apart", () => {
      expect(apiHostnameFor("dev")).toBe("api.dev.nightshift.wildorder.dev");
    });

    it("builds none of it in zone-only mode, and still serves the generated endpoint", () => {
      const { stack, template } = synth("dev", "zone-only");
      expect(stack.customEndpoint).toBeUndefined();
      template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
      template.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
      template.resourceCountIs("AWS::Route53::RecordSet", 0);
      template.hasOutput("ApiEndpoint", {});
      expect(JSON.stringify(template.toJSON())).not.toContain(dnsExportName("HostedZoneId"));
    });

    it("adds no route: a hostname is not a way around the authorizer", () => {
      const full = resourcesOf(synth("dev", "full").template, "AWS::ApiGatewayV2::Route");
      const zoneOnly = resourcesOf(synth("dev", "zone-only").template, "AWS::ApiGatewayV2::Route");
      expect(full.length).toBe(zoneOnly.length);
    });

    it("can depend on the DNS stack without a construct reference", () => {
      const app = testApp();
      const dns = new NightshiftDnsStack(app, "Dns");
      const api = new NightshiftApiStack(app, "Api", { stage: "dev" });
      api.addStackDependency(dns, "imports the DNS stack's exports by name");
      expect(api.dependencies).toEqual([dns]);
    });
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
        // Two tolerated forms, both of which name one resource's contents rather
        // than a class of resources:
        //
        //  - CloudFormation's log group ARN, which ends `:*` to name the streams
        //    inside that single group;
        //  - the artifact bucket's object prefix, `<BucketArn>/*` (T2). S3 offers
        //    no way to say "every object in this bucket" without it, and the
        //    statement is still pinned to one bucket.
        const tolerated =
          actions.every((action) => action.startsWith("logs:")) ||
          (actions.every((action) => action.startsWith("s3:")) &&
            wildcarded.every((resource) => resource.endsWith("/*")));
        expect(tolerated, `${actions.join()} on ${wildcarded.join()}`).toBe(true);
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

    /**
     * The whole set, not a containment. P2 granted DynamoDB gets, puts and
     * queries and no more; P3 adds `s3:PutObject` for signing the artifact
     * upload (T2) and nothing else. An action added without a decision fails
     * here, which is the point of asserting the set.
     */
    it("gives the API function exactly the actions its adapters and the signer use", () => {
      expect(dataActionsOf(synth().template, "ApiFunctionRole")).toEqual(
        new Set(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "s3:PutObject"]),
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

    /**
     * P2 granted no S3 action at all and said the first route needing one would
     * bring a policy change. That route is the presigned upload (T2), and this is
     * the change: exactly `s3:PutObject`, scoped to the bucket's objects.
     *
     * The action list is asserted as a set rather than a containment, because a
     * signature can only convey permission the signer holds — adding
     * `s3:GetObject` here would silently turn every signed URL into a potential
     * read of any artifact in the account.
     */
    it("grants exactly s3:PutObject, on the artifact bucket's objects and nothing else", () => {
      const statements = statementsOf(synth().template);
      const s3Statements = statements.filter((statement) =>
        actionsOf(statement).some((action) => action.startsWith("s3:")),
      );
      expect(s3Statements).toHaveLength(1);
      expect(s3Statements.flatMap(actionsOf)).toEqual(["s3:PutObject"]);

      const resources = JSON.stringify(s3Statements[0]?.Resource);
      expect(resources).toContain("BucketArn");
      expect(resources).toContain("/*");
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
