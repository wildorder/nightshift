/**
 * The stateful stack: `nightshift-<stage>-data` (D-P2-07, A-24).
 *
 * Holds everything whose loss is loss of data or identity — the DynamoDB table,
 * the artifact bucket, the Cognito user pool — and the account budget. It changes
 * rarely and carries termination protection. Nothing stateless lives here; the
 * function, the API and the stream consumer are in `nightshift-<stage>-api`, which
 * can be replaced freely.
 *
 * With one account (A-17) and no teardown testing (A-18), this split is the only
 * thing between a bad deploy and the data, so every stateful resource declares its
 * removal policy explicitly rather than inheriting a default.
 *
 * Environment-agnostic: no account, no region, so synth needs no credentials.
 * Nothing is named by hand where CDK can generate the name (contract §9).
 */
import { Aws, CfnOutput, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { MonthlyCostBudget } from "./budget.js";
import { type DataExportKey, dataExportName } from "./data-exports.js";
import { assertValidStage, type NightshiftStackProps, stackNameFor } from "./stack-props.js";

/** The one GSI (contract §4.2). */
export const NODE_INDEX_NAME = "gsi_node";

/** Monthly budget in USD, with headroom for P6's model spend (T8). */
export const BUDGET_LIMIT_USD = 500;
export const BUDGET_NOTIFY_EMAIL = "tim+nightshift@wingitlabs.com";

/** The resource server and its one scope. Machine callers request `nightshift/api`. */
export const RESOURCE_SERVER_IDENTIFIER = "nightshift";
export const API_SCOPE_NAME = "api";
export const MACHINE_SCOPE = `${RESOURCE_SERVER_IDENTIFIER}/${API_SCOPE_NAME}`;

/** The custom attribute the API reads, as claim `custom:active_org`, to select an org. */
export const ACTIVE_ORG_ATTRIBUTE = "active_org";

/**
 * Loopback redirect for the interactive client (authorization code with PKCE).
 *
 * Cognito matches callback URLs exactly, port included, so the port is fixed
 * rather than chosen at runtime. 47821 sits in the dynamic range and collides with
 * no common development server. Cognito permits plain `http` only for localhost.
 * Cognito has no OAuth device flow, so P3's CLI uses this loopback PKCE redirect —
 * the same shape `aws sso login` and `gh auth login` use.
 */
export const LOOPBACK_CALLBACK_URL = "http://localhost:47821/callback";
export const LOOPBACK_LOGOUT_URL = "http://localhost:47821/logout";

/** The only direct auth flow either app client allows. */
export const EXPLICIT_AUTH_FLOWS = ["ALLOW_REFRESH_TOKEN_AUTH"] as const;

export class NightshiftDataStack extends Stack {
  readonly stage: string;
  readonly table: dynamodb.Table;
  readonly bucket: s3.Bucket;
  readonly userPool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: NightshiftStackProps) {
    const { stage, ...stackProps } = props;
    assertValidStage(stage);
    super(scope, id, {
      stackName: stackNameFor(stage, "data"),
      // A-18, A-24: the stateful stack is never deleted by accident.
      terminationProtection: true,
      ...stackProps,
    });
    this.stage = stage;

    // --- DynamoDB: one table, one GSI (D-P2-02, contract §4) --------------------
    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // NEW_AND_OLD_IMAGES: the materializer (T6) needs the new image to find the
      // event it numbers; the old image makes an unexpected MODIFY diagnosable
      // from the stream alone. Streams are billed per read request, not per byte
      // of image, so the fuller view costs nothing extra at this volume.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: NODE_INDEX_NAME,
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      // ALL: every `listByNode` returns whole records, so a narrower projection
      // would force a second read per item.
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- S3: artifact bodies (A-08, D-P2-08) ------------------------------------
    this.bucket = new s3.Bucket(this, "ArtifactBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Artifacts are write-once; versioning would only retain overwrites that
      // should never happen.
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // --- Cognito: control-plane identity (A-19, T9) -----------------------------
    this.userPool = new cognito.UserPool(this, "UserPool", {
      signInAliases: { email: true },
      // v1 has no self-service sign-up: the operator creates users.
      selfSignUpEnabled: false,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Set explicitly rather than inherited: new pools default to Essentials.
      // Lite covers email sign-in, hosted-UI PKCE and the client credentials
      // grant. Machine-to-machine app clients and token requests are billed
      // separately from MAUs on every plan.
      featurePlan: cognito.FeaturePlan.LITE,
      customAttributes: {
        // Custom attributes cannot be removed or have their constraints changed
        // after the pool exists, so the org selector exists from creation.
        [ACTIVE_ORG_ATTRIBUTE]: new cognito.StringAttribute({ mutable: true, maxLen: 64 }),
      },
      // Losing the pool loses every user identity, and every membership keyed by
      // a `sub` would be orphaned.
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const apiScope = new cognito.ResourceServerScope({
      scopeName: API_SCOPE_NAME,
      scopeDescription: "Call the Nightshift control-plane API",
    });
    const resourceServer = this.userPool.addResourceServer("ResourceServer", {
      identifier: RESOURCE_SERVER_IDENTIFIER,
      scopes: [apiScope],
    });
    const apiOAuthScope = cognito.OAuthScope.resourceServer(resourceServer, apiScope);

    // Machine callers: the smoke suite now, the remote runner later. The token's
    // `sub` is this client's id, which is what its membership is keyed by.
    const machineClient = this.userPool.addClient("MachineClient", {
      generateSecret: true,
      authFlows: {},
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [apiOAuthScope],
      },
    });

    // Interactive callers: a local CLI signing a human in (P3 builds the UX).
    const interactiveClient = this.userPool.addClient("InteractiveClient", {
      generateSecret: false,
      authFlows: {},
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          apiOAuthScope,
        ],
        callbackUrls: [LOOPBACK_CALLBACK_URL],
        logoutUrls: [LOOPBACK_LOGOUT_URL],
      },
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes(ACTIVE_ORG_ATTRIBUTE),
      writeAttributes: new cognito.ClientAttributes().withCustomAttributes(ACTIVE_ORG_ATTRIBUTE),
    });

    // An empty `authFlows` emits no ExplicitAuthFlows, and Cognito then enables its
    // defaults, including SRP and custom auth. Neither client signs in by password
    // through the API: the machine client uses client credentials and the
    // interactive client the hosted authorization code flow. Pin both to refresh
    // tokens only, so no username/password surface exists on either.
    for (const client of [machineClient, interactiveClient]) {
      const cfn = client.node.defaultChild as cognito.CfnUserPoolClient;
      cfn.explicitAuthFlows = [...EXPLICIT_AUTH_FLOWS];
    }

    // A Cognito domain prefix is global across all AWS customers and cannot be
    // generated by CDK, so it is derived: the stage keeps two stages apart and the
    // account id keeps it unique without a hand-picked suffix.
    const domain = this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: `nightshift-${stage}-${Aws.ACCOUNT_ID}` },
    });

    // --- Budget (T8) -------------------------------------------------------------
    new MonthlyCostBudget(this, "MonthlyCostBudget", {
      limitUsd: BUDGET_LIMIT_USD,
      notifyEmail: BUDGET_NOTIFY_EMAIL,
    });

    // --- Exports, consumed by name (T1, T5) -------------------------------------
    const streamArn = this.table.tableStreamArn;
    if (streamArn === undefined) throw new Error("table stream must be enabled");

    const exports: Record<DataExportKey, string> = {
      TableName: this.table.tableName,
      TableArn: this.table.tableArn,
      TableStreamArn: streamArn,
      BucketName: this.bucket.bucketName,
      BucketArn: this.bucket.bucketArn,
      UserPoolId: this.userPool.userPoolId,
      UserPoolArn: this.userPool.userPoolArn,
      InteractiveClientId: interactiveClient.userPoolClientId,
      MachineClientId: machineClient.userPoolClientId,
      TokenEndpoint: `${domain.baseUrl()}/oauth2/token`,
      MachineScope: MACHINE_SCOPE,
    };
    for (const [key, value] of Object.entries(exports) as [DataExportKey, string][]) {
      new CfnOutput(this, key, { value, exportName: dataExportName(stage, key) });
    }
  }
}
