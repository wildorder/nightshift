import { App, Token } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ACTUAL_THRESHOLDS, FORECAST_THRESHOLD } from "./budget.js";
import { DATA_EXPORT_KEYS, dataExportName } from "./data-exports.js";
import {
  BUDGET_LIMIT_USD,
  BUDGET_NOTIFY_EMAIL,
  EXPLICIT_AUTH_FLOWS,
  LOOPBACK_CALLBACK_URL,
  MACHINE_SCOPE,
  NightshiftDataStack,
  NODE_INDEX_NAME,
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
  // Configuration that CloudFormation can recreate exactly from this template.
  "AWS::S3::BucketPolicy": "Delete",
  "AWS::Cognito::UserPoolResourceServer": "Delete",
  "AWS::Cognito::UserPoolClient": "Delete",
  "AWS::Cognito::UserPoolDomain": "Delete",
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

    it("has a machine client with a secret and only the client credentials grant", () => {
      const machine = dev.template.findResources("AWS::Cognito::UserPoolClient", {
        Properties: { GenerateSecret: true },
      });
      const clients = Object.values(machine);
      expect(clients).toHaveLength(1);
      const props = clients[0]?.Properties as Record<string, unknown>;
      expect(props.AllowedOAuthFlows).toEqual(["client_credentials"]);
      expect(props.ExplicitAuthFlows).toEqual([...EXPLICIT_AUTH_FLOWS]);
      expect(props.CallbackURLs).toBeUndefined();
      expect(JSON.stringify(props.AllowedOAuthScopes)).toContain("/api");
    });

    it("has an interactive public client using the code grant with a loopback redirect", () => {
      const interactive = dev.template.findResources("AWS::Cognito::UserPoolClient", {
        Properties: { GenerateSecret: false },
      });
      const clients = Object.values(interactive);
      expect(clients).toHaveLength(1);
      const props = clients[0]?.Properties as Record<string, unknown>;
      expect(props.AllowedOAuthFlows).toEqual(["code"]);
      expect(props.CallbackURLs).toEqual([LOOPBACK_CALLBACK_URL]);
      expect(LOOPBACK_CALLBACK_URL).toMatch(/^http:\/\/localhost:\d+\//);
      expect(props.ExplicitAuthFlows).toEqual([...EXPLICIT_AUTH_FLOWS]);
      expect(props.AllowedOAuthScopes).toEqual(expect.arrayContaining(["openid", "email"]));
      expect(JSON.stringify(props.AllowedOAuthScopes)).toContain("/api");
      expect(props.WriteAttributes).toEqual(["custom:active_org"]);
    });

    it("derives the domain prefix from the stage and account", () => {
      dev.template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: { "Fn::Join": ["", ["nightshift-dev-", { Ref: "AWS::AccountId" }]] },
      });
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
  });
});
