import { App, Token } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BODY_PREFIX,
  AUTHORIZER_CACHE_TTL,
  CORS_ALLOW_HEADERS,
  NightshiftApiStack,
  PLAN_DOCUMENT_PREFIX,
  PREFLIGHT_ROUTE_PATH,
  STREAM_BATCH_SIZE,
  STREAM_RETRY_ATTEMPTS,
} from "./api-stack.js";
import { DATA_EXPORT_KEYS, dataExportName } from "./data-exports.js";
import { NightshiftDataStack } from "./data-stack.js";
import { NightshiftDnsStack } from "./dns-stack.js";
import {
  apiHostnameFor,
  type HostnamesMode,
  STUDIO_DEV_ORIGIN,
  studioOriginsFor,
  ZONE_NAME,
} from "./hostnames.js";
import { GITHUB_APP_SECRET_NAME, runnerExportName } from "./runner-stack.js";
import { DNS_EXPORT_KEYS, dnsExportName } from "./stack-props.js";

/**
 * An app that skips asset bundling. Bundling runs esbuild over the compiled API
 * and proves nothing these assertions check; `npm run synth` bundles for real.
 */
const testApp = (): App => new App({ context: { "aws:cdk:bundling-stacks": [] } });

const synth = (stage = "dev", hostnames: HostnamesMode = "full", runner = false) => {
  const stack = new NightshiftApiStack(testApp(), "Api", { stage, hostnames, runner });
  return { stack, template: Template.fromStack(stack) };
};

type Resource = { Type: string; Properties?: Record<string, unknown> };

const resourcesOf = (template: Template, type: string): Resource[] =>
  Object.values(template.findResources(type)) as Resource[];

/** The one resource of `type` whose logical id starts with `prefix`. */
const resourceNamed = (template: Template, type: string, prefix: string): Resource => {
  const found = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  );
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${type} named ${prefix}*, found ${found.length}`);
  }
  return found[0]?.[1] as Resource;
};

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

  describe("authentication (A-19 as amended, A-36)", () => {
    /**
     * The P2 assertion, retargeted (T3 deliverable 2), with P11's one exception
     * named: the preflight route (D-P11-03) is `OPTIONS` and nothing else, and
     * it is the only route not behind the authorizer.
     */
    it("binds every route but the OPTIONS preflight to the Nightshift authorizer", () => {
      const { template } = synth();
      const routes = resourcesOf(template, "AWS::ApiGatewayV2::Route");
      expect(routes.length).toBeGreaterThan(1);

      const authorizers = template.findResources("AWS::ApiGatewayV2::Authorizer");
      expect(Object.keys(authorizers)).toHaveLength(1);
      const [authorizerId] = Object.keys(authorizers) as [string];

      const preflight = routes.filter(
        (route) => route.Properties?.RouteKey === `OPTIONS ${PREFLIGHT_ROUTE_PATH}`,
      );
      expect(preflight).toHaveLength(1);
      expect(preflight[0]?.Properties?.AuthorizationType).toBe("NONE");

      const guarded = routes.filter((route) => !preflight.includes(route));
      expect(guarded.map((route) => route.Properties?.RouteKey)).toEqual(["$default"]);
      for (const route of guarded) {
        expect(route.Properties?.AuthorizationType).toBe("CUSTOM");
        // Bound to *this* authorizer, not merely to some authorizer.
        expect(stringsIn(route.Properties?.AuthorizerId)).toContain(authorizerId);
      }
    });

    it("lets no method but OPTIONS past the authorizer", () => {
      const anonymous = resourcesOf(synth().template, "AWS::ApiGatewayV2::Route").filter(
        (route) => route.Properties?.AuthorizationType !== "CUSTOM",
      );
      for (const route of anonymous) {
        expect(String(route.Properties?.RouteKey)).toMatch(/^OPTIONS /);
      }
    });

    it("is a request authorizer over the Authorization header, with a bounded cache", () => {
      const { template } = synth();
      template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
        AuthorizerType: "REQUEST",
        IdentitySource: ["$request.header.Authorization"],
        EnableSimpleResponses: true,
        AuthorizerResultTtlInSeconds: AUTHORIZER_CACHE_TTL.toSeconds(),
      });
      // Set, and bounded: an unbounded cache would quietly extend every token's
      // life past its expiry.
      expect(AUTHORIZER_CACHE_TTL.toSeconds()).toBeGreaterThan(0);
      expect(AUTHORIZER_CACHE_TTL.toSeconds()).toBeLessThanOrEqual(3600);
    });

    it("tells the authorizer the pool's issuer and every app client, the Studio's included", () => {
      const { template } = synth();
      const { Variables: variables } = property<{ Variables: Record<string, unknown> }>(
        resourceNamed(template, "AWS::Lambda::Function", "AuthorizerFunction"),
        "Environment",
      );
      const issuer = stringsIn(variables.NIGHTSHIFT_COGNITO_ISSUER);
      expect(issuer.some((part) => part.includes("cognito-idp."))).toBe(true);
      expect(issuer).toContain(dataExportName("dev", "UserPoolId"));

      const audiences = stringsIn(variables.NIGHTSHIFT_COGNITO_AUDIENCES);
      expect(audiences).toContain(dataExportName("dev", "InteractiveClientId"));
      expect(audiences).toContain(dataExportName("dev", "MachineClientId"));
      expect(audiences).toContain(dataExportName("dev", "TestPrincipalClientId"));
      // P11 (D-P11-04): a browser's ID token names the Studio's client.
      expect(audiences).toContain(dataExportName("dev", "StudioClientId"));
    });

    /**
     * Every app client the data stack exports, with none left out.
     *
     * A client the authorizer does not list is refused with a bare gateway 403
     * and no body — a failure that looks like an authorisation bug rather than a
     * configuration one. That is exactly how `TestPrincipalClient` failed its
     * first live run, so the assertion is on the whole set rather than on
     * membership of it.
     */
    it("accepts every app client the data stack exports, and no others", () => {
      const { template } = synth();
      const { Variables: variables } = property<{ Variables: Record<string, unknown> }>(
        resourceNamed(template, "AWS::Lambda::Function", "AuthorizerFunction"),
        "Environment",
      );
      const listed = stringsIn(variables.NIGHTSHIFT_COGNITO_AUDIENCES).filter((value) =>
        value.startsWith("nightshift-dev-data-"),
      );
      const clientExports = DATA_EXPORT_KEYS.filter((key) => key.endsWith("ClientId")).map((key) =>
        dataExportName("dev", key),
      );
      expect(new Set(listed)).toEqual(new Set(clientExports));
    });

    it("serves the $default stage, so the handler sees unprefixed paths", () => {
      synth().template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        StageName: "$default",
        AutoDeploy: true,
      });
    });
  });

  /**
   * D-P11-03: the Studio's origins and no other, on the API itself so the
   * gateway answers a preflight before the authorizer would refuse it for
   * carrying no token. The origin list per stage is the assertion: the hosted
   * Studio on every stage, the local development origin on `dev` alone
   * (D-P11-01), and nothing that could be read as "any".
   */
  describe("CORS for the Studio (D-P11-03)", () => {
    const corsOf = (stage: string): Record<string, unknown> =>
      property<Record<string, unknown>>(
        resourcesOf(synth(stage).template, "AWS::ApiGatewayV2::Api")[0],
        "CorsConfiguration",
      );

    it("allows the dev Studio's hosted origin and the local development origin, and no other", () => {
      const cors = corsOf("dev");
      expect(cors.AllowOrigins).toEqual([
        "https://studio.dev.nightshift.wildorder.dev",
        "http://localhost:5173",
      ]);
      expect(cors.AllowOrigins).toEqual([...studioOriginsFor("dev")]);
      expect(STUDIO_DEV_ORIGIN).toBe("http://localhost:5173");
    });

    it("allows a later stage its hosted origin only: localhost is dev's alone (D-P11-01)", () => {
      for (const stage of ["staging", "prod"]) {
        const cors = corsOf(stage);
        expect(cors.AllowOrigins, stage).toEqual([`https://studio.${stage}.${ZONE_NAME}`]);
        expect(JSON.stringify(cors), stage).not.toContain("localhost");
      }
    });

    it("allows the methods and headers a bearer-token client needs, and never a wildcard or credentials", () => {
      const cors = corsOf("dev");
      expect(cors.AllowMethods).toEqual(["GET", "PUT", "POST", "OPTIONS"]);
      expect(cors.AllowHeaders).toEqual([...CORS_ALLOW_HEADERS]);
      expect(CORS_ALLOW_HEADERS).toEqual(["authorization", "content-type"]);
      // Bearer tokens, not cookies: a credentials flag would be a lie about how
      // the token travels and would forbid the list above being anything but exact.
      expect(cors.AllowCredentials).toBeUndefined();
      expect(JSON.stringify(cors)).not.toContain('"*"');
    });

    it("is the same in zone-only mode: an origin is a string, not a record", () => {
      const cors = property<Record<string, unknown>>(
        resourcesOf(synth("dev", "zone-only").template, "AWS::ApiGatewayV2::Api")[0],
        "CorsConfiguration",
      );
      expect(cors.AllowOrigins).toEqual([...studioOriginsFor("dev")]);
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
        //  - a key prefix inside the artifact bucket, `<BucketArn>/<prefix>*`
        //    (T2, P7, P11). S3 offers no way to name a bucket's objects without
        //    it, the statement is still pinned to one bucket, and the prefixes
        //    themselves are pinned below.
        const tolerated =
          actions.every((action) => action.startsWith("logs:")) ||
          (actions.every((action) => action.startsWith("s3:")) &&
            wildcarded.every((resource) => /^\/[^*]*\*$/.test(resource)));
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
     * upload (T2) and nothing else; P4 adds `kms:Sign` for minting execution
     * tokens (T2, D-P4-03). An action added without a decision fails here, which
     * is the point of asserting the set.
     */
    it("gives the API function exactly the actions its adapters and the signers use", () => {
      expect(dataActionsOf(synth().template, "ApiFunctionRole")).toEqual(
        new Set([
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "s3:PutObject",
          // P7 (D-P7-02): ratification reads the uploaded plan document back.
          "s3:GetObject",
          "kms:Sign",
          // P10 (D-P10-23): a data key per credential, and its unwrapping.
          "kms:GenerateDataKey",
          "kms:Decrypt",
        ]),
      );
    });

    it("reads and writes the credentials table from the API function alone (P10, D-P10-23)", () => {
      const { template } = synth();
      const onCredentials = resourcesOf(template, "AWS::IAM::Policy").filter((policy) =>
        JSON.stringify(policy.Properties?.PolicyDocument).includes(
          dataExportName("dev", "CredentialsTableArn"),
        ),
      );
      expect(onCredentials).toHaveLength(1);
      expect(stringsIn(onCredentials[0]?.Properties?.Roles)[0]).toMatch(/^ApiFunctionRole/);
    });

    it("unwraps credentials only under the credentials key and only with an org in the context", () => {
      const statements = statementsOf(synth().template).filter((statement) =>
        actionsOf(statement).includes("kms:Decrypt"),
      ) as (Statement & { Condition?: unknown })[];
      expect(statements).toHaveLength(1);
      expect(actionsOf(statements[0] as Statement).sort()).toEqual([
        "kms:Decrypt",
        "kms:GenerateDataKey",
      ]);
      expect(JSON.stringify(statements[0]?.Resource)).toContain(
        dataExportName("dev", "CredentialsKeyArn"),
      );
      expect(statements[0]?.Condition).toEqual({
        Null: { "kms:EncryptionContext:orgId": "false" },
      });
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
      const writes = statements.filter((statement) =>
        actionsOf(statement).some(
          (action) => action.startsWith("s3:") && action !== "s3:GetObject",
        ),
      );
      expect(writes).toHaveLength(1);
      expect(writes.flatMap(actionsOf)).toEqual(["s3:PutObject"]);

      const resources = JSON.stringify(writes[0]?.Resource);
      expect(resources).toContain("BucketArn");
      expect(resources).toContain("/*");
    });

    /**
     * P7 (D-P7-02) is the decision that brings a read: ratification hashes the
     * stored plan document itself. P11 (D-P11-06) brings the second and last:
     * a signed download conveys only a read the signer holds, so the role reads
     * artifact bodies — under the prefix they actually have, `proj_…`, the
     * project id P2 put first in every key. The reasoning above survives
     * because each read is confined to its prefix and is its own statement, so
     * neither can ride along with the signing grant, and the two prefixes are
     * pinned here as the whole of what this role may read.
     */
    it("grants s3:GetObject on plan documents and artifact bodies, and on no other object", () => {
      const reads = statementsOf(synth().template).filter((statement) =>
        actionsOf(statement).includes("s3:GetObject"),
      );
      expect(reads).toHaveLength(2);
      for (const read of reads) {
        expect(actionsOf(read)).toEqual(["s3:GetObject"]);
        expect(JSON.stringify(read.Resource)).toContain("BucketArn");
      }
      const prefixes = reads
        .flatMap((read) => stringsIn(read.Resource))
        .filter((value) => value.endsWith("*"))
        .sort();
      expect(prefixes).toEqual([`/${PLAN_DOCUMENT_PREFIX}*`, `/${ARTIFACT_BODY_PREFIX}*`].sort());
      expect(PLAN_DOCUMENT_PREFIX).toBe("plans/");
      // Artifact keys begin with the project id (D-P2-08), and no `proj_` id
      // can spell `plans`, so the two reads are disjoint by construction.
      expect(ARTIFACT_BODY_PREFIX).toBe("proj_");
    });

    /**
     * The function signs execution tokens and does nothing else with any key
     * (T2 deliverable 2). `kms:Decrypt`, `kms:GenerateDataKey` or a wildcard
     * resource here would each turn one signing key into general KMS access.
     */
    it("grants exactly kms:Sign, on the execution-token key and nothing else", () => {
      expect(dataActionsOf(synth().template, "ApiFunctionRole")).toContain("kms:Sign");
      const signing = statementsOf(synth().template).filter(
        (statement) => actionsOf(statement).length === 1 && actionsOf(statement)[0] === "kms:Sign",
      );
      expect(signing).toHaveLength(1);

      const resources = JSON.stringify(signing[0]?.Resource);
      expect(resources).toContain(dataExportName("dev", "ExecutionTokenKeyArn"));
      expect(resources).not.toContain("*");
    });

    /**
     * The authorizer's whole world is two public keys. Anything else in its IAM
     * — the table, the bucket, `kms:Sign` — would mean it could do something
     * other than check a signature.
     */
    it("gives the authorizer kms:GetPublicKey and nothing else", () => {
      expect(dataActionsOf(synth().template, "AuthorizerFunctionRole")).toEqual(
        new Set(["kms:GetPublicKey"]),
      );
    });

    it("grants no KMS action beyond signing, reading the public key, and sealing credentials", () => {
      const kmsActions = new Set(
        statementsOf(synth().template)
          .flatMap(actionsOf)
          .filter((action) => action.startsWith("kms:")),
      );
      expect(kmsActions).toEqual(
        new Set(["kms:Sign", "kms:GetPublicKey", "kms:GenerateDataKey", "kms:Decrypt"]),
      );
    });
  });

  describe("functions", () => {
    it("runs every function on Node 24, arm64", () => {
      const functions = resourcesOf(synth().template, "AWS::Lambda::Function");
      expect(functions).toHaveLength(3);
      for (const fn of functions) {
        expect(fn.Properties?.Runtime).toBe("nodejs24.x");
        expect(fn.Properties?.Architectures).toEqual(["arm64"]);
      }
    });

    it("configures functions with table, bucket, stage and source maps, and nothing secret", () => {
      const common = [
        "NIGHTSHIFT_BUCKET_NAME",
        "NIGHTSHIFT_STAGE",
        "NIGHTSHIFT_TABLE_NAME",
        "NODE_OPTIONS",
      ];
      // The API function alone mints execution tokens (P4, T2), so it alone
      // carries the key id and the issuer. Neither is a secret: the key id names
      // a key whose private half never leaves KMS, and the issuer is a public
      // hostname. The materializer gets neither, because it signs nothing.
      const apiOnly = [
        "NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID",
        "NIGHTSHIFT_TOKEN_ISSUER",
        // P10 (D-P10-23): the credentials table and key, the API function's alone.
        "NIGHTSHIFT_CREDENTIALS_TABLE_NAME",
        "NIGHTSHIFT_CREDENTIALS_KEY_ID",
      ];
      const { template } = synth();

      const api = property<{ Variables: Record<string, unknown> }>(
        resourceNamed(template, "AWS::Lambda::Function", "ApiFunction"),
        "Environment",
      );
      expect(Object.keys(api.Variables).sort()).toEqual([...common, ...apiOnly].sort());

      const materializer = property<{ Variables: Record<string, unknown> }>(
        resourceNamed(template, "AWS::Lambda::Function", "MaterializerFunction"),
        "Environment",
      );
      expect(Object.keys(materializer.Variables).sort()).toEqual(common.sort());
    });

    it("names the issuer from the one hostname rule, per stage (D-P3-18, T2)", () => {
      for (const stage of ["dev", "staging"]) {
        const { template } = synth(stage);
        const { Variables: variables } = property<{ Variables: Record<string, string> }>(
          resourceNamed(template, "AWS::Lambda::Function", "ApiFunction"),
          "Environment",
        );
        expect(variables.NIGHTSHIFT_TOKEN_ISSUER).toBe(`https://${apiHostnameFor(stage)}`);
      }
    });

    it("logs to explicit groups with 30-day retention (D-P2-10)", () => {
      const { template } = synth();
      const groups = template.findResources("AWS::Logs::LogGroup");
      expect(Object.keys(groups)).toHaveLength(3);
      for (const group of Object.values(groups) as Resource[]) {
        expect(group.Properties?.RetentionInDays).toBe(30);
      }
      for (const fn of resourcesOf(template, "AWS::Lambda::Function")) {
        const { LogGroup: logGroup } = property<{ LogGroup: { Ref: string } }>(fn, "LoggingConfig");
        expect(Object.keys(groups)).toContain(logGroup.Ref);
      }
    });
  });

  describe("the remote runner beside it (P10, D-P10-02, D-P10-18)", () => {
    const apiEnvironment = (template: Template): Record<string, unknown> =>
      property<{ Variables: Record<string, unknown> }>(
        resourceNamed(template, "AWS::Lambda::Function", "ApiFunction"),
        "Environment",
      ).Variables;

    it("with the runner stack, names the dispatch function and the GitHub App's secret, and may call both", () => {
      const { template } = synth("dev", "full", true);
      const variables = apiEnvironment(template);
      expect(variables.NIGHTSHIFT_GITHUB_APP_SECRET).toBe(GITHUB_APP_SECRET_NAME);
      expect(variables.NIGHTSHIFT_DISPATCH_FUNCTION_ARN).toEqual({
        "Fn::ImportValue": runnerExportName("dev", "DispatchFunctionArn"),
      });
      const statements = statementsOf(template);
      const invoke = statements.find((statement) =>
        actionsOf(statement).includes("lambda:InvokeFunction"),
      );
      expect(invoke?.Resource).toEqual([
        { "Fn::ImportValue": runnerExportName("dev", "DispatchFunctionArn") },
        { "Fn::ImportValue": runnerExportName("dev", "PublisherFunctionArn") },
      ]);
      expect(variables.NIGHTSHIFT_PUBLISHER_FUNCTION_ARN).toEqual({
        "Fn::ImportValue": runnerExportName("dev", "PublisherFunctionArn"),
      });
      const secret = statements.find((statement) =>
        actionsOf(statement).includes("secretsmanager:GetSecretValue"),
      );
      expect(stringsIn(secret?.Resource).join("")).toContain(GITHUB_APP_SECRET_NAME);
    });

    it("without it, knows nothing of the runner: no import, no variable, no permission", () => {
      const { template } = synth();
      const variables = apiEnvironment(template);
      expect(variables.NIGHTSHIFT_GITHUB_APP_SECRET).toBeUndefined();
      expect(variables.NIGHTSHIFT_DISPATCH_FUNCTION_ARN).toBeUndefined();
      const actions = statementsOf(template).flatMap(actionsOf);
      expect(actions).not.toContain("lambda:InvokeFunction");
      expect(actions).not.toContain("secretsmanager:GetSecretValue");
      expect(JSON.stringify(template.toJSON())).not.toContain(
        runnerExportName("dev", "DispatchFunctionArn"),
      );
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
