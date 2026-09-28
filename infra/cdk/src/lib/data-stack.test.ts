import { App, Token } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ACTUAL_THRESHOLDS, FORECAST_THRESHOLD } from "./budget.js";
import { DATA_EXPORT_KEYS, dataExportName } from "./data-exports.js";
import {
  BUDGET_LIMIT_USD,
  BUDGET_NOTIFY_EMAIL,
  DELIVERY_LOG_EVENT_SOURCE,
  DELIVERY_LOG_LEVEL,
  DELIVERY_LOG_RETENTION,
  EXPLICIT_AUTH_FLOWS,
  executionTokenKeyAlias,
  INVITATION_SUBJECT,
  LOOPBACK_CALLBACK_URL,
  MACHINE_SCOPE,
  NightshiftDataStack,
  NODE_INDEX_NAME,
  studioCallbackUrlsFor,
  studioLogoutUrlsFor,
} from "./data-stack.js";

interface CfnResource {
  readonly Type: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly Properties?: Record<string, unknown>;
}

interface CfnTemplate {
  readonly Resources?: Record<string, CfnResource>;
  readonly Outputs?: Record<string, { Export?: { Name?: string } }>;
}

/**
 * The removal policy every resource type in the data stack is expected to carry
 * (A-18, A-24). `Delete` means CloudFormation's default, i.e. the attribute is
 * absent or `Delete`.
 *
 * This table is deliberately exhaustive. A resource type added to the data stack
 * without an entry here fails the test, forcing its author to decide whether
 * losing it on stack deletion or replacement is acceptable, rather than inheriting
 * whatever CDK defaults to.
 */
const POLICY_BY_TYPE: Readonly<Record<string, "Retain" | "Delete">> = {
  // Stateful: losing any of these is losing data or identity.
  "AWS::DynamoDB::Table": "Retain",
  "AWS::S3::Bucket": "Retain",
  "AWS::Cognito::UserPool": "Retain",
  // The execution-token signing key (P4, T2). Losing it invalidates every token
  // in flight and is the loss of an identity, not of a setting.
  "AWS::KMS::Key": "Retain",
  // Configuration that CloudFormation can recreate exactly from this template.
  "AWS::S3::BucketPolicy": "Delete",
  "AWS::Cognito::UserPoolResourceServer": "Delete",
  "AWS::Cognito::UserPoolClient": "Delete",
  "AWS::Cognito::UserPoolDomain": "Delete",
  // An alias is a name for the retained key, and CloudFormation recreates it
  // from this template exactly.
  "AWS::KMS::Alias": "Delete",
  // Delivery-error logging (D-P3-16): diagnostics, not records. Losing the group
  // loses nothing that is not reproducible by the next failed send.
  "AWS::Logs::LogGroup": "Delete",
  "AWS::Cognito::LogDeliveryConfiguration": "Delete",
  "AWS::Budgets::Budget": "Delete",
  "AWS::CDK::Metadata": "Delete",
};

const removalPolicyViolations = (template: CfnTemplate): string[] => {
  const violations: string[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    const expected = POLICY_BY_TYPE[resource.Type];
    if (expected === undefined) {
      violations.push(
        `${logicalId} (${resource.Type}) has no declared removal policy: set one explicitly in the stack and add the type to POLICY_BY_TYPE`,
      );
      continue;
    }
    const deletion = resource.DeletionPolicy ?? "Delete";
    const replace = resource.UpdateReplacePolicy ?? "Delete";
    if (deletion !== expected || replace !== expected) {
      violations.push(
        `${logicalId} (${resource.Type}) has DeletionPolicy=${deletion}, UpdateReplacePolicy=${replace}; expected ${expected}`,
      );
    }
  }
  return violations;
};

const synth = (stage: string) => {
  const app = new App();
  const stack = new NightshiftDataStack(app, `Data-${stage}`, { stage });
  const template = Template.fromStack(stack);
  return { app, stack, template, json: template.toJSON() as CfnTemplate };
};

describe("NightshiftDataStack", () => {
  let dev: ReturnType<typeof synth>;

  beforeAll(() => {
    dev = synth("dev");
  });

  describe("stack", () => {
    it("synthesizes", () => {
      expect(Object.keys(dev.json.Resources ?? {}).length).toBeGreaterThan(0);
    });

    it("is named nightshift-<stage>-data, including for a non-default stage", () => {
      expect(dev.stack.stackName).toBe("nightshift-dev-data");
      const staging = synth("staging");
      expect(staging.stack.stackName).toBe("nightshift-staging-data");
      expect(staging.stack.stage).toBe("staging");
    });

    it("carries termination protection (A-18, A-24)", () => {
      expect(dev.stack.terminationProtection).toBe(true);
      const artifact = dev.app.synth().getStackByName(dev.stack.stackName);
      expect(artifact.terminationProtection).toBe(true);
    });

    it("is environment-agnostic, so synth needs no account", () => {
      expect(Token.isUnresolved(dev.stack.account)).toBe(true);
      expect(Token.isUnresolved(dev.stack.region)).toBe(true);
      const artifact = dev.app.synth().getStackByName(dev.stack.stackName);
      expect(artifact.environment.name).toBe("aws://unknown-account/unknown-region");
    });

    it("refuses a stage that cannot appear in a Cognito domain prefix", () => {
      expect(() => new NightshiftDataStack(new App(), "Bad", { stage: "Bad_Stage" })).toThrow(
        /invalid stage/,
      );
    });
  });

  describe("removal policies", () => {
    it("declares an expected policy for every resource, and it matches", () => {
      expect(removalPolicyViolations(dev.json)).toEqual([]);
    });

    it("retains every stateful resource", () => {
      for (const type of ["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::Cognito::UserPool"]) {
        const found = Object.values(dev.json.Resources ?? {}).filter((r) => r.Type === type);
        expect(found, type).toHaveLength(1);
        expect(found[0]?.DeletionPolicy).toBe("Retain");
        expect(found[0]?.UpdateReplacePolicy).toBe("Retain");
      }
    });

    it("fails loudly for a resource type nobody chose a policy for", () => {
      const violations = removalPolicyViolations({
        Resources: { Queue: { Type: "AWS::SQS::Queue" } },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/no declared removal policy/);
    });

    it("fails for a stateful resource left on the default policy", () => {
      expect(
        removalPolicyViolations({ Resources: { T: { Type: "AWS::DynamoDB::Table" } } }),
      ).toHaveLength(1);
    });
  });

  describe("DynamoDB table (contract §4)", () => {
    it("has the documented key schema, on-demand billing, and no hand-set name", () => {
      dev.template.resourceCountIs("AWS::DynamoDB::Table", 1);
      dev.template.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        TableName: Match.absent(),
      });
    });

    it("has exactly one GSI, gsi_node, projecting all attributes", () => {
      const [table] = Object.values(dev.template.findResources("AWS::DynamoDB::Table"));
      expect(table).toBeDefined();
      const indexes = ((table as CfnResource).Properties as { GlobalSecondaryIndexes: unknown[] })
        .GlobalSecondaryIndexes;
      expect(indexes).toEqual([
        {
          IndexName: NODE_INDEX_NAME,
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ]);
    });

    it("streams new and old images for the materializer", () => {
      dev.template.hasResourceProperties("AWS::DynamoDB::Table", {
        StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
      });
    });
  });

  describe("artifact bucket (A-08, D-P2-08)", () => {
    it("uses SSE-S3, no versioning, full public access block, and no hand-set name", () => {
      dev.template.resourceCountIs("AWS::S3::Bucket", 1);
      dev.template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
        VersioningConfiguration: Match.absent(),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketName: Match.absent(),
      });
    });

    it("enforces TLS through the bucket policy", () => {
      dev.template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        },
      });
    });
  });

  describe("Cognito (T9)", () => {
    it("has an email-sign-in pool with no self sign-up, deletion protection and an explicit plan", () => {
      dev.template.resourceCountIs("AWS::Cognito::UserPool", 1);
      dev.template.hasResourceProperties("AWS::Cognito::UserPool", {
        UsernameAttributes: ["email"],
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        DeletionProtection: "ACTIVE",
        UserPoolTier: "LITE",
      });
    });

    it("defines the mutable active_org attribute the API reads as custom:active_org", () => {
      dev.template.hasResourceProperties("AWS::Cognito::UserPool", {
        Schema: Match.arrayWith([
          Match.objectLike({ Name: "active_org", AttributeDataType: "String", Mutable: true }),
        ]),
      });
    });

    it("defines the nightshift resource server with the api scope", () => {
      dev.template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
        Identifier: "nightshift",
        Scopes: [Match.objectLike({ ScopeName: "api" })],
      });
      expect(MACHINE_SCOPE).toBe("nightshift/api");
    });

    /**
     * Two machine clients since P4 (T5, D-P4-07): the operational one, and the
     * smoke suite's second principal. Asserted together because they must be
     * identical in everything but identity — a second client with a *different*
     * grant or scope would prove something other than isolation.
     */
    it("has two machine clients with secrets and only the client credentials grant", () => {
      const machine = dev.template.findResources("AWS::Cognito::UserPoolClient", {
        Properties: { GenerateSecret: true },
      });
      const clients = Object.values(machine);
      expect(clients).toHaveLength(2);
      for (const client of clients) {
        const props = client.Properties as Record<string, unknown>;
        expect(props.AllowedOAuthFlows).toEqual(["client_credentials"]);
        expect(props.ExplicitAuthFlows).toEqual([...EXPLICIT_AUTH_FLOWS]);
        expect(props.CallbackURLs).toBeUndefined();
        expect(JSON.stringify(props.AllowedOAuthScopes)).toContain("/api");
      }
    });

    it("exports the second machine client, which exists for the smoke suite alone", () => {
      dev.template.hasOutput("TestPrincipalClientId", {
        Export: { Name: dataExportName("dev", "TestPrincipalClientId") },
      });
    });

    /** The public clients of `template`, keyed by logical id prefix. */
    const publicClientsOf = (template: Template): Record<string, Record<string, unknown>> =>
      Object.fromEntries(
        Object.entries(
          template.findResources("AWS::Cognito::UserPoolClient", {
            Properties: { GenerateSecret: false },
          }),
        ).map(([id, client]) => [id, client.Properties as Record<string, unknown>]),
      );

    const publicClient = (template: Template, prefix: string): Record<string, unknown> => {
      const found = Object.entries(publicClientsOf(template)).filter(([id]) =>
        id.startsWith(prefix),
      );
      expect(found, prefix).toHaveLength(1);
      return found[0]?.[1] as Record<string, unknown>;
    };

    it("has an interactive public client using the code grant with a loopback redirect", () => {
      // Two public clients since P11 (D-P11-04): the CLI's and the Studio's.
      expect(Object.keys(publicClientsOf(dev.template))).toHaveLength(2);
      const props = publicClient(dev.template, "UserPoolInteractiveClient");
      expect(props.AllowedOAuthFlows).toEqual(["code"]);
      expect(props.CallbackURLs).toEqual([LOOPBACK_CALLBACK_URL]);
      expect(LOOPBACK_CALLBACK_URL).toMatch(/^http:\/\/localhost:\d+\//);
      expect(props.ExplicitAuthFlows).toEqual([...EXPLICIT_AUTH_FLOWS]);
      expect(props.AllowedOAuthScopes).toEqual(expect.arrayContaining(["openid", "email"]));
      expect(JSON.stringify(props.AllowedOAuthScopes)).toContain("/api");
      expect(props.WriteAttributes).toEqual(["custom:active_org"]);
    });

    /**
     * The Studio's client (P11, T2, D-P11-04): the CLI's shape with the
     * Studio's origins as its URLs. A second client rather than a second
     * callback on the CLI's, so a browser flow cannot redeem a code meant for a
     * terminal; asserted against the CLI's client field by field so the two
     * cannot drift apart in anything but their URLs.
     */
    it("has a Studio public client, the interactive client's twin but for its URLs", () => {
      const studio = publicClient(dev.template, "UserPoolStudioClient");
      const interactive = publicClient(dev.template, "UserPoolInteractiveClient");
      for (const field of [
        "AllowedOAuthFlows",
        "AllowedOAuthFlowsUserPoolClient",
        "AllowedOAuthScopes",
        "ExplicitAuthFlows",
        "GenerateSecret",
        "PreventUserExistenceErrors",
        "ReadAttributes",
        "WriteAttributes",
        "SupportedIdentityProviders",
      ]) {
        expect(studio[field], field).toEqual(interactive[field]);
      }
      expect(studio.AllowedOAuthFlows).toEqual(["code"]);
      expect(studio.ExplicitAuthFlows).toEqual([...EXPLICIT_AUTH_FLOWS]);
      expect(studio.CallbackURLs).not.toEqual(interactive.CallbackURLs);
    });

    it("gives the Studio client the Studio's origins: hosted on every stage, localhost on dev alone (D-P11-01)", () => {
      const onDev = publicClient(dev.template, "UserPoolStudioClient");
      expect(onDev.CallbackURLs).toEqual([
        "https://studio.dev.nightshift.wildorder.dev/callback",
        "http://localhost:5173/callback",
      ]);
      expect(onDev.LogoutURLs).toEqual([
        "https://studio.dev.nightshift.wildorder.dev/",
        "http://localhost:5173/",
      ]);
      expect(onDev.CallbackURLs).toEqual([...studioCallbackUrlsFor("dev")]);
      expect(onDev.LogoutURLs).toEqual([...studioLogoutUrlsFor("dev")]);

      const onStaging = publicClient(synth("staging").template, "UserPoolStudioClient");
      expect(onStaging.CallbackURLs).toEqual([
        "https://studio.staging.nightshift.wildorder.dev/callback",
      ]);
      expect(onStaging.LogoutURLs).toEqual(["https://studio.staging.nightshift.wildorder.dev/"]);
      expect(JSON.stringify(onStaging)).not.toContain("localhost");
    });

    it("exports the Studio client id, for the authorizer and for config.json", () => {
      dev.template.hasOutput("StudioClientId", {
        Export: { Name: dataExportName("dev", "StudioClientId") },
      });
      expect(JSON.stringify(dev.json.Outputs?.StudioClientId)).toContain("UserPoolStudioClient");
    });

    it("derives the domain prefix from the stage and account", () => {
      dev.template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: { "Fn::Join": ["", ["nightshift-dev-", { Ref: "AWS::AccountId" }]] },
      });
    });
  });

  /**
   * The key that signs execution tokens (P4, T2, D-P4-03, A-35).
   *
   * Asserted in full because every property here is a decision: the spec fixes
   * the JWT algorithm the authorizer accepts, the usage forbids using it to
   * encrypt anything, and the retention is what stops a stack replacement from
   * invalidating every token in flight.
   */
  describe("execution-token key (P4, T2)", () => {
    it("is one asymmetric RSA-2048 sign/verify key", () => {
      dev.template.resourceCountIs("AWS::KMS::Key", 1);
      dev.template.hasResourceProperties("AWS::KMS::Key", {
        KeySpec: "RSA_2048",
        KeyUsage: "SIGN_VERIFY",
      });
    });

    it("carries the stage's alias", () => {
      dev.template.hasResourceProperties("AWS::KMS::Alias", {
        AliasName: `alias/${executionTokenKeyAlias("dev")}`,
      });
      const staging = synth("staging");
      staging.template.hasResourceProperties("AWS::KMS::Alias", {
        AliasName: `alias/${executionTokenKeyAlias("staging")}`,
      });
    });

    it("is retained, so replacing the stack does not invalidate every token", () => {
      const keys = Object.values(dev.json.Resources ?? {}).filter(
        (resource) => resource.Type === "AWS::KMS::Key",
      );
      expect(keys).toHaveLength(1);
      expect(keys[0]?.DeletionPolicy).toBe("Retain");
      expect(keys[0]?.UpdateReplacePolicy).toBe("Retain");
    });

    it("does not ask for rotation, which KMS does not offer for asymmetric keys", () => {
      const keys = Object.values(dev.json.Resources ?? {}).filter(
        (resource) => resource.Type === "AWS::KMS::Key",
      );
      expect(keys[0]?.Properties?.EnableKeyRotation).toBeUndefined();
    });
  });

  describe("budget (T8, D-P2-11)", () => {
    it("is a monthly 500 USD cost budget with no hand-set name", () => {
      dev.template.resourceCountIs("AWS::Budgets::Budget", 1);
      dev.template.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: {
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetLimit: { Amount: BUDGET_LIMIT_USD, Unit: "USD" },
          BudgetName: Match.absent(),
        },
      });
      expect(BUDGET_LIMIT_USD).toBe(500);
    });

    it("notifies at 50, 80 and 100 percent actual and 100 percent forecast, by email", () => {
      const [budget] = Object.values(dev.template.findResources("AWS::Budgets::Budget"));
      expect(budget).toBeDefined();
      const notifications = (
        (budget as CfnResource).Properties as {
          NotificationsWithSubscribers: {
            Notification: Record<string, unknown>;
            Subscribers: unknown[];
          }[];
        }
      ).NotificationsWithSubscribers;

      expect(
        notifications.map((n) => [n.Notification.NotificationType, n.Notification.Threshold]),
      ).toEqual([
        ...ACTUAL_THRESHOLDS.map((t) => ["ACTUAL", t]),
        ["FORECASTED", FORECAST_THRESHOLD],
      ]);
      expect([...ACTUAL_THRESHOLDS]).toEqual([50, 80, 100]);
      for (const n of notifications) {
        expect(n.Notification.ThresholdType).toBe("PERCENTAGE");
        expect(n.Subscribers).toEqual([
          { SubscriptionType: "EMAIL", Address: "tim+nightshift@wingitlabs.com" },
        ]);
      }
      expect(BUDGET_NOTIFY_EMAIL).toBe("tim+nightshift@wingitlabs.com");
    });
  });

  /**
   * D-P3-16. The incident these two assertions exist for: an invitation that
   * appeared lost, a pool that logged nothing, and an afternoon spent proving the
   * cause was a dead recipient domain. Both settings were applied by hand during
   * that diagnosis; these tests are what stops a stack replacement from silently
   * dropping them again.
   */
  describe("pool hardening (D-P3-16)", () => {
    it("puts the hosted domain in the invitation, beside the username and password", () => {
      dev.template.hasResourceProperties("AWS::Cognito::UserPool", {
        AdminCreateUserConfig: Match.objectLike({
          AllowAdminCreateUserOnly: true,
          InviteMessageTemplate: Match.objectLike({ EmailSubject: INVITATION_SUBJECT }),
        }),
      });
      const pool = Object.values(dev.json.Resources ?? {}).find(
        (resource) => resource.Type === "AWS::Cognito::UserPool",
      );
      const invite = JSON.stringify(
        (pool?.Properties?.AdminCreateUserConfig as Record<string, unknown> | undefined)
          ?.InviteMessageTemplate,
      );
      // Cognito refuses a template missing either placeholder.
      expect(invite).toContain("{username}");
      expect(invite).toContain("{####}");
      // And the thing the default template omitted: where to go.
      expect(invite).toContain(".auth.");
      expect(invite).toContain("amazoncognito.com");
    });

    it("delivers userNotification errors to an explicit log group with finite retention", () => {
      dev.template.hasResourceProperties("AWS::Cognito::LogDeliveryConfiguration", {
        LogConfigurations: [
          Match.objectLike({
            EventSource: DELIVERY_LOG_EVENT_SOURCE,
            LogLevel: DELIVERY_LOG_LEVEL,
            CloudWatchLogsConfiguration: Match.objectLike({ LogGroupArn: Match.anyValue() }),
          }),
        ],
      });
      // Cognito validates the ARN against a character class excluding `*`, so
      // CloudWatch's `:*` stream suffix makes it refuse the deploy outright.
      const delivery = Object.values(dev.json.Resources ?? {}).find(
        (resource) => resource.Type === "AWS::Cognito::LogDeliveryConfiguration",
      );
      expect(JSON.stringify(delivery?.Properties)).not.toContain(":*");
      dev.template.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: Number(DELIVERY_LOG_RETENTION),
      });
      // Exactly one group, so nobody has quietly added a second, infinite one.
      dev.template.resourceCountIs("AWS::Logs::LogGroup", 1);
    });

    it("names no app client inside the pool, which would be a circular dependency", () => {
      // The pool cannot refer to a client that refers to the pool. The complete
      // sign-in URL, client id included, is the HostedSignInUrl output instead.
      const pool = Object.values(dev.json.Resources ?? {}).find(
        (resource) => resource.Type === "AWS::Cognito::UserPool",
      );
      expect(JSON.stringify(pool?.Properties)).not.toContain("InteractiveClient");
    });
  });

  describe("exports", () => {
    it("exports exactly the documented keys, each named by dataExportName", () => {
      for (const stage of ["dev", "staging"]) {
        const outputs = (stage === "dev" ? dev : synth(stage)).json.Outputs ?? {};
        expect(Object.keys(outputs).sort()).toEqual([...DATA_EXPORT_KEYS].sort());
        for (const key of DATA_EXPORT_KEYS) {
          expect(outputs[key]?.Export?.Name).toBe(dataExportName(stage, key));
        }
      }
    });

    it("exports the machine scope and a token endpoint on the Cognito domain", () => {
      dev.template.hasOutput("MachineScope", { Value: "nightshift/api" });
      const endpoint = JSON.stringify(dev.json.Outputs?.TokenEndpoint);
      expect(endpoint).toContain(".amazoncognito.com/oauth2/token");
    });

    it("exports the auth domain and a complete hosted sign-in URL (T2, T7)", () => {
      const domain = JSON.stringify(dev.json.Outputs?.AuthDomain);
      expect(domain).toContain(".auth.");
      expect(domain).toContain("amazoncognito.com");

      const signIn = JSON.stringify(dev.json.Outputs?.HostedSignInUrl);
      expect(signIn).toContain("/login?client_id=");
      expect(signIn).toContain("response_type=code");
      // The loopback redirect the CLI listens on, percent-encoded.
      expect(signIn).toContain(encodeURIComponent(LOOPBACK_CALLBACK_URL));
      // And it names the interactive client, which is why it cannot live on the pool.
      expect(signIn).toContain("InteractiveClient");
    });
  });
});
