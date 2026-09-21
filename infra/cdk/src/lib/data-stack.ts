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
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { MonthlyCostBudget } from "./budget.js";
import { type DataExportKey, dataExportName } from "./data-exports.js";
import { assertValidStage, type NightshiftStackProps, stackNameFor } from "./stack-props.js";

/** The one GSI (contract §4.2). */
export const NODE_INDEX_NAME = "gsi_node";

/** Monthly budget in USD, with headroom for P8's model spend (T8). */
export const BUDGET_LIMIT_USD = 500;
export const BUDGET_NOTIFY_EMAIL = "tim+nightshift@wingitlabs.com";

/** The resource server and its one scope. Machine callers request `nightshift/api`. */
export const RESOURCE_SERVER_IDENTIFIER = "nightshift";
export const API_SCOPE_NAME = "api";
export const MACHINE_SCOPE = `${RESOURCE_SERVER_IDENTIFIER}/${API_SCOPE_NAME}`;

/**
 * The alias of the key that signs execution tokens (P4, T2, D-P4-03).
 *
 * Aliased so the key is nameable by a human in the console and by a script that
 * has not read a stack output; the API function is still given the key id.
 */
export const executionTokenKeyAlias = (stage: string): string =>
  `nightshift-${stage}-execution-tokens`;

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

/**
 * Delivery-error logging for the pool (D-P3-16).
 *
 * The incident this exists for: on 2026-09-15 an invitation appeared lost and it
 * took an afternoon to prove the cause was a dead recipient domain rather than
 * Cognito, because the pool logged nothing at all. CloudTrail showed the send
 * being accepted every time and there was no record of what happened next.
 *
 * `userNotification` at `ERROR` is the narrowest configuration that would have
 * answered the question in a minute. It was enabled by hand during that
 * diagnosis against a hand-made log group; this construct replaces both, so the
 * setting survives a stack replacement.
 */
export const DELIVERY_LOG_EVENT_SOURCE = "userNotification";
export const DELIVERY_LOG_LEVEL = "ERROR";

export const INVITATION_SUBJECT = "Your Nightshift sign-in";

/**
 * The invitation body (D-P3-16).
 *
 * Cognito substitutes `{username}` and `{####}` and refuses a template that
 * omits either. What its default template omits is *where to go*, which on
 * 2026-09-15 left the operator holding a temporary password and no URL.
 *
 * ## Why this carries the domain and not the full sign-in URL
 *
 * T2 asked for "the hosted sign-in URL for the interactive client". A complete
 * Cognito hosted-UI URL needs `client_id`, and a user pool that referenced its
 * own app client would be a CloudFormation **circular dependency**: the client
 * refers to the pool it belongs to, so the pool cannot refer back. CDK's template
 * validator reports it (F3004) and CloudFormation refuses the deploy outright.
 *
 * So the template names the hosted domain, which is the part the recipient cannot
 * work out, and the complete URL — client id included — is the stack's
 * `HostedSignInUrl` output, printed by `npm run admin:user` and used by
 * `nightshift login`. Recorded as a departure in the P3 contract §12.
 *
 * Note also what this template does *not* carry responsibility for: the
 * bootstrap script suppresses the invitation entirely and sets a permanent
 * password, so on the intended path nobody reads this at all. It exists for a
 * user created by hand in the console.
 */
export const invitationBody = (authDomain: string): string =>
  [
    "<p>You have been given access to the Nightshift control plane.</p>",
    "<p>Username: <strong>{username}</strong><br/>",
    "Temporary password: <strong>{####}</strong></p>",
    `<p>Sign in through the hosted login for <strong>${authDomain}</strong>.`,
    " Your operator has the complete sign-in link (the stack output",
    " <code>HostedSignInUrl</code>); <code>nightshift login</code> opens it for you.</p>",
    "<p>You will be asked to choose a password on first sign-in.</p>",
  ].join("\n");

/** D-P2-10: enough to debug a delivery failure, cheap, and never infinite. */
export const DELIVERY_LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

export class NightshiftDataStack extends Stack {
  readonly stage: string;
  readonly table: dynamodb.Table;
  readonly bucket: s3.Bucket;
  readonly userPool: cognito.UserPool;
  readonly executionTokenKey: kms.Key;

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

    // --- KMS: the execution-token signing key (P4, T2, D-P4-03, A-35) -----------
    //
    // Asymmetric, sign/verify, RSA-2048. The reasoning for RSA over ECC P-256 is
    // in `apps/api/src/tokens/mint.ts`, beside the code that depends on it:
    // verification is the hot path and RSA verifies cheaply, and KMS returns an
    // ECDSA signature DER-encoded where JOSE wants raw `r‖s`.
    //
    // The private key never leaves KMS. The API function holds `kms:Sign` on
    // this one key and the authorizer holds `kms:GetPublicKey`; no process
    // Nightshift runs can read the key material at all.
    //
    // Retained, and in the stateful stack, because losing it invalidates every
    // token in flight and because a key is identity, not configuration. Rotation
    // is not applicable: KMS does not rotate asymmetric key material, and an
    // eight-hour token ceiling makes replacing the key a deploy plus a wait.
    this.executionTokenKey = new kms.Key(this, "ExecutionTokenKey", {
      description: `Signs Nightshift execution tokens (${stage})`,
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: executionTokenKeyAlias(stage),
      removalPolicy: RemovalPolicy.RETAIN,
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

    /**
     * A **second** machine caller, for the smoke suite and for nothing else
     * (P4, T5, D-P4-07).
     *
     * Its whole purpose is to give the deployed isolation matrix a second
     * principal in a second organisation. Interactive users cannot obtain tokens
     * without a browser (P3 §13.4), so proving cross-org refusal live needs two
     * client-credentials callers — and an isolation proof that only runs offline
     * is half a proof.
     *
     * It is identical to `MachineClient` in every respect but its identity. It
     * holds no standing membership: the smoke suite writes one into a throwaway
     * org at the start of a run and deletes it at the end, so between runs this
     * client can do nothing at all.
     */
    const testPrincipalClient = this.userPool.addClient("TestPrincipalClient", {
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
    for (const client of [machineClient, testPrincipalClient, interactiveClient]) {
      const cfn = client.node.defaultChild as cognito.CfnUserPoolClient;
      cfn.explicitAuthFlows = [...EXPLICIT_AUTH_FLOWS];
    }

    // A Cognito domain prefix is global across all AWS customers and cannot be
    // generated by CDK, so it is derived: the stage keeps two stages apart and the
    // account id keeps it unique without a hand-picked suffix.
    //
    // The prefix is a local so the exported host below is built from the same
    // expression the domain is created with, and the two cannot drift.
    const domainPrefix = `nightshift-${stage}-${Aws.ACCOUNT_ID}`;
    const domain = this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix },
    });
    const authDomain = `${domainPrefix}.auth.${Aws.REGION}.amazoncognito.com`;
    /**
     * Where a human finishes signing in (D-P3-16).
     *
     * It carries the loopback redirect, so completing it while `nightshift login`
     * is listening lands the code where the CLI wants it. Completing it *without*
     * the CLI running still works for the thing it exists for — setting a
     * password — and merely fails at the final redirect, which is what the
     * operator did by hand on 2026-09-15.
     */
    const hostedSignInUrl =
      `https://${authDomain}/login?client_id=${interactiveClient.userPoolClientId}` +
      `&response_type=code&scope=openid+email+profile+${encodeURIComponent(MACHINE_SCOPE)}` +
      `&redirect_uri=${encodeURIComponent(LOOPBACK_CALLBACK_URL)}`;

    // The invitation template is set by override rather than through
    // `userInvitation` in the pool's props, because the body has to name the
    // hosted sign-in URL, which needs the app client and the domain — both
    // created after the pool. The override touches one field and leaves
    // `AllowAdminCreateUserOnly`, which `selfSignUpEnabled: false` sets, alone.
    const cfnUserPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.addPropertyOverride(
      "AdminCreateUserConfig.InviteMessageTemplate.EmailSubject",
      INVITATION_SUBJECT,
    );
    cfnUserPool.addPropertyOverride(
      "AdminCreateUserConfig.InviteMessageTemplate.EmailMessage",
      invitationBody(authDomain),
    );

    // --- Delivery-error logging (D-P3-16) ---------------------------------------
    // An explicitly created group with an explicit retention (D-P2-10), rather
    // than the infinite-retention group Cognito would make on demand. This
    // replaces the hand-made
    // `/aws/cognito/nightshift-dev-userpool-delivery-diag`, which is deleted
    // after the deploy.
    const deliveryLogs = new logs.LogGroup(this, "UserPoolDeliveryLogs", {
      retention: DELIVERY_LOG_RETENTION,
      // Diagnostics, not records: they go with the pool but their loss loses nothing.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new cognito.CfnLogDeliveryConfiguration(this, "UserPoolLogDelivery", {
      userPoolId: this.userPool.userPoolId,
      logConfigurations: [
        {
          eventSource: DELIVERY_LOG_EVENT_SOURCE,
          logLevel: DELIVERY_LOG_LEVEL,
          // Deliberately **not** `deliveryLogs.logGroupArn`, which ends `:*` to
          // name the streams inside the group. Cognito validates this field
          // against `[\w+=/,.@-]`, which excludes `*`, and refuses the deploy
          // with a regex error. The group ARN without the stream suffix is what
          // it wants.
          cloudWatchLogsConfiguration: {
            logGroupArn: `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${deliveryLogs.logGroupName}`,
          },
        },
      ],
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
      TestPrincipalClientId: testPrincipalClient.userPoolClientId,
      TokenEndpoint: `${domain.baseUrl()}/oauth2/token`,
      MachineScope: MACHINE_SCOPE,
      AuthDomain: authDomain,
      HostedSignInUrl: hostedSignInUrl,
      ExecutionTokenKeyId: this.executionTokenKey.keyId,
      ExecutionTokenKeyArn: this.executionTokenKey.keyArn,
    };
    for (const [key, value] of Object.entries(exports) as [DataExportKey, string][]) {
      new CfnOutput(this, key, { value, exportName: dataExportName(stage, key) });
    }
  }
}
