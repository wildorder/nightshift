/**
 * The stateless stack: `nightshift-<stage>-api` (D-P2-07, A-24, T5).
 *
 * The control-plane handler, the HTTP API in front of it with Nightshift's own
 * Lambda authorizer (P4, D-P4-04), the sequence materializer on the table's
 * stream, their log groups and their IAM. It holds no state, so it can be
 * replaced freely and carries no termination protection.
 *
 * It consumes the data stack's outputs by export name (`dataExportName`), never by
 * construct reference, so either stack can be deployed or replaced on its own.
 *
 * ## What "internet-facing" means here
 *
 * The API endpoint is on public DNS and reachable from anywhere. That is required:
 * it is how a local MCP server on a laptop reaches the control plane, and later
 * the AgentCore runtime. Every route is behind the Nightshift authorizer and none
 * is anonymous, so the endpoint is publicly *reachable* but not publicly
 * *usable*. A private API behind a VPC endpoint was not chosen because a laptop
 * cannot reach one without a VPN.
 *
 * ## The hostname a client stores (D-P3-18)
 *
 * `api.<stage>.nightshift.wildorder.dev`, an alias to a custom domain on the HTTP
 * API, with a certificate validated against the zone the DNS stack owns. The
 * generated `execute-api` endpoint stays and the smoke suite keeps using it, but
 * it is never the name a CLI stores: this stack can be replaced (D-P2-07), and
 * replacing it changes that name. In `zone-only` mode none of this exists, so the
 * first deploy of a new account can land the zone, be delegated, and only then
 * create a certificate CloudFormation would otherwise wait on.
 */
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  ApiMapping,
  CorsHttpMethod,
  DomainName,
  HttpApi,
  HttpMethod,
  HttpNoneAuthorizer,
} from "aws-cdk-lib/aws-apigatewayv2";
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { type DataExportKey, dataExportName } from "./data-exports.js";
import { NODE_INDEX_NAME } from "./data-stack.js";
import { apiHostnameFor, type HostnamesMode, studioOriginsFor, ZONE_NAME } from "./hostnames.js";
import {
  assertValidStage,
  dnsExportName,
  hostnamesModeOf,
  type NightshiftStackProps,
  stackNameFor,
} from "./stack-props.js";

/**
 * Where ratified plan documents live in the artifact bucket (P7, D-P7-02).
 * Restates `planDocumentObjectKey` in `@nightshift/core`, which this package does
 * not import; the smoke suite ratifies against the deployed stack, so a drift
 * between the two is a failed read there rather than a silent one.
 */
export const PLAN_DOCUMENT_PREFIX = "plans/";

/**
 * Where artifact bodies live in the artifact bucket (D-P2-08):
 * `<projectId>/<programId>/<runId>/<artifactId>`, and a project id is `proj_` +
 * a ULID. Restates `artifactObjectKey` in `@nightshift/core` the way
 * `PLAN_DOCUMENT_PREFIX` restates `planDocumentObjectKey`.
 *
 * D-P11-06 names the second S3 read "`GetObject` on `artifacts/*`", but no
 * object has ever been written under `artifacts/`: the layout P2 ratified puts
 * the project id first, and every `Artifact.uri` in the table says so. A grant
 * on the literal prefix would sign URLs S3 refuses. So the grant is on the
 * prefix the bodies actually have, which is the decision's intent — the
 * artifact bodies and nothing else, `plans/*` in particular excluded, since no
 * `proj_` id can spell `plans`. Recorded as a departure for the owner (T2
 * report, contract §12).
 */
export const ARTIFACT_BODY_PREFIX = "proj_";

/**
 * CORS for the Studio (P11, D-P11-03), on the HTTP API itself so a preflight is
 * answered by the gateway before the authorizer sees it — an `OPTIONS` carries
 * no `Authorization` header and would otherwise be a 401.
 *
 * Bearer tokens, not cookies, so no credentials flag: the browser sends the
 * token in a header it asked to be allowed. The origins are `studioOriginsFor`,
 * the same list the Studio's app client trusts, so a browser Cognito will send
 * a code to is a browser the API will answer, and no other.
 */
export const CORS_ALLOW_METHODS = [
  CorsHttpMethod.GET,
  CorsHttpMethod.PUT,
  CorsHttpMethod.POST,
  CorsHttpMethod.OPTIONS,
] as const;
export const CORS_ALLOW_HEADERS = ["authorization", "content-type"] as const;

/**
 * The one route not behind the authorizer: `OPTIONS` on every path, so the
 * gateway answers a preflight rather than refusing it for the token a preflight
 * never carries. See the note where it is added.
 */
export const PREFLIGHT_ROUTE_PATH = "/{proxy+}";

/**
 * The repository root, resolved from this module. `src/lib` and `dist/lib` sit at
 * the same depth, so the path holds for the assertion tests and for `cdk synth`.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * The functions are bundled from `apps/api`'s **compiled** output, the same
 * choice D-P1-10 makes for the CDK app: `npm run synth` and `npm run deploy` build
 * the workspace first, so esbuild resolves `@nightshift/*` through the workspace
 * links to built JavaScript and no TypeScript loader is involved.
 */
export const API_ENTRY = `${REPO_ROOT}apps/api/dist/lambda/api.js`;
export const MATERIALIZER_ENTRY = `${REPO_ROOT}apps/api/dist/lambda/materializer.js`;
export const AUTHORIZER_ENTRY = `${REPO_ROOT}apps/api/dist/lambda/authorizer-entry.js`;

/**
 * Stream consumer tuning, chosen for latency over throughput because it sets how
 * far the realtime surface runs behind durability (T5 deliverable 4).
 *
 * - No batching window: Lambda invokes as soon as records arrive rather than
 *   waiting to fill a batch.
 * - A batch of 25 caps the work per invocation. Each record is a few consistent
 *   reads and one transaction, so 25 finish well inside the timeout, and a
 *   burst still drains in few invocations.
 * - Parallelization factor 1: a run's events live on one shard, and numbering
 *   must follow that shard's order. Higher factors split a shard by partition key,
 *   which would still be correct per run but buys nothing at this volume.
 * - Ten retries before a record goes to the dead-letter queue: enough to ride
 *   out throttling, few enough that a poison record stalls its shard for minutes,
 *   not the stream's 24-hour retention.
 */
export const STREAM_BATCH_SIZE = 25;
export const STREAM_RETRY_ATTEMPTS = 10;

/** D-P2-10: enough to debug a run, cheap, and never infinite. */
export const LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

/**
 * How long API Gateway caches one authorizer answer, keyed by the identity
 * source (P4, T3 deliverable 2).
 *
 * Five minutes, and deliberately not zero: a worker makes many calls with one
 * token, and re-verifying a signature per call buys nothing. Deliberately not
 * longer either — the cache is keyed by the token itself, so a *revoked* token
 * (which Nightshift has no way to revoke anyway; see the bearer non-guarantee in
 * the contract) or an expired one stays usable for at most this long past its
 * expiry. Bounded and asserted, because an unbounded cache would quietly extend
 * every token's life.
 */
export const AUTHORIZER_CACHE_TTL = Duration.minutes(5);

export class NightshiftApiStack extends Stack {
  readonly stage: string;
  readonly hostnames: HostnamesMode;
  /** `https://api.<stage>.nightshift.wildorder.dev`, or `undefined` in `zone-only` mode. */
  readonly customEndpoint: string | undefined;

  constructor(scope: Construct, id: string, props: NightshiftStackProps) {
    const { stage, hostnames: _hostnames, ...stackProps } = props;
    assertValidStage(stage);
    super(scope, id, { stackName: stackNameFor(stage, "api"), ...stackProps });
    this.stage = stage;
    this.hostnames = hostnamesModeOf(props);

    const imported = (key: DataExportKey): string => Fn.importValue(dataExportName(stage, key));
    const tableArn = imported("TableArn");
    const streamArn = imported("TableStreamArn");

    const executionTokenKeyArn = imported("ExecutionTokenKeyArn");

    const environment = {
      NIGHTSHIFT_TABLE_NAME: imported("TableName"),
      NIGHTSHIFT_BUCKET_NAME: imported("BucketName"),
      NIGHTSHIFT_STAGE: stage,
    };

    /**
     * What the API function needs beyond the data stack's names (P4, T2).
     *
     * The issuer is derived here, from the same rule that names the custom
     * domain, rather than restated inside `apps/api`: there is one hostname rule
     * per surface and it lives in `hostnames.ts`. The API reads the issuer it was
     * given, so a stage cannot mint tokens claiming to be another stage's.
     */
    const tokenEnvironment = {
      NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID: imported("ExecutionTokenKeyId"),
      NIGHTSHIFT_TOKEN_ISSUER: `https://${apiHostnameFor(stage)}`,
    };

    // --- The control-plane API function ------------------------------------------
    const apiLogs = this.logGroup("ApiFunctionLogs");
    const apiRole = this.executionRole("ApiFunctionRole", apiLogs, [
      // Exactly what the adapters call: gets and puts (including the puts inside
      // TransactWriteItems, which IAM authorises per item) and queries on the
      // table and its one index. No update or delete: the API never issues one.
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [tableArn],
      }),
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [tableArn, `${tableArn}/index/${NODE_INDEX_NAME}`],
      }),
      // `s3:PutObject` on the bucket's objects, for **signing only** (T2, A-08).
      // The presigned-upload route computes a signature from the credentials the
      // role already holds; the function never calls S3 and never reads an
      // object. A signature can only convey permission the signer holds, which
      // is why this statement is exactly one action and no more: adding
      // `GetObject` here would make every signed URL a potential read.
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${imported("BucketArn")}/*`],
      }),
      // `s3:GetObject` on ratified plan documents, `plans/*`, and on nothing
      // else (P7, D-P7-02). Ratification reads the uploaded plan back and hashes
      // it, so the record holds what was approved rather than what a client
      // said it uploaded, and a run is reconstructable from the control plane
      // alone. The prefix is the whole point: artifact bodies live under
      // `<projectId>/…`, which no `proj_` id can spell `plans`, so the reasoning
      // above still holds for every artifact a signed URL could name.
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${imported("BucketArn")}/${PLAN_DOCUMENT_PREFIX}*`],
      }),
      // `s3:GetObject` on artifact bodies, the second read (P11, D-P11-06), for
      // **signing only**: the download route computes a presigned `GET` from the
      // credentials the role holds and the function never fetches a body. A
      // signature conveys only what the signer may do, which is exactly why
      // this statement had to exist before a download URL could work, and why
      // it is its own statement on its own prefix rather than a widening of the
      // upload's: the two prefixes together are the whole of what this role may
      // read, and the stack test pins both.
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${imported("BucketArn")}/${ARTIFACT_BODY_PREFIX}*`],
      }),
      // `kms:Sign` on exactly one key, and no other KMS action on any key
      // (T2 deliverable 2). The function mints execution tokens; it never
      // decrypts anything, never reads key material, and cannot verify — the
      // authorizer holds `kms:GetPublicKey` and does that.
      new iam.PolicyStatement({
        actions: ["kms:Sign"],
        resources: [executionTokenKeyArn],
      }),
    ]);
    const apiFunction = this.nodeFunction("ApiFunction", {
      entry: API_ENTRY,
      role: apiRole,
      logGroup: apiLogs,
      environment: { ...environment, ...tokenEnvironment },
      // API Gateway gives an HTTP API integration 30 seconds; stay well inside it.
      timeout: Duration.seconds(10),
      memorySize: 512,
    });

    // --- The Nightshift authorizer (P4, T3, D-P4-04, A-36) --------------------------
    //
    // This replaces API Gateway's built-in `HttpJwtAuthorizer`, which accepts one
    // OIDC issuer. Nightshift now has two token kinds — Cognito's and its own
    // execution tokens — and the alternative to this function was becoming an
    // OIDC provider with a public JWKS endpoint. The gateway still rejects a bad
    // token before the handler runs; the verifying code is now ours.
    //
    // Its whole world is two public keys, so its IAM is one KMS action: no table,
    // no bucket, no private key. The audiences list both clients, because an
    // interactive caller presents an ID token (`aud`) and a machine caller an
    // access token (`client_id`).
    const authorizerLogs = this.logGroup("AuthorizerFunctionLogs");
    const authorizerRole = this.executionRole("AuthorizerFunctionRole", authorizerLogs, [
      new iam.PolicyStatement({
        actions: ["kms:GetPublicKey"],
        resources: [executionTokenKeyArn],
      }),
    ]);
    const authorizerFunction = this.nodeFunction("AuthorizerFunction", {
      entry: AUTHORIZER_ENTRY,
      role: authorizerRole,
      logGroup: authorizerLogs,
      environment: {
        ...tokenEnvironment,
        NIGHTSHIFT_COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${imported("UserPoolId")}`,
        // **Every** app client the pool issues tokens for. A client missing from
        // this list is refused by the authorizer with no body a caller can read,
        // which is how the second machine principal (D-P4-07) failed its first
        // live run: the client existed, held a membership, and every request it
        // made came back as a bare 403 from the gateway.
        NIGHTSHIFT_COGNITO_AUDIENCES: Fn.join(",", [
          imported("InteractiveClientId"),
          imported("MachineClientId"),
          imported("TestPrincipalClientId"),
          // P11 (D-P11-04): the Studio's client, or every browser call is that
          // same bare 403.
          imported("StudioClientId"),
        ]),
      },
      // One JWKS fetch on a cold instance, then signature checks. Short, because
      // every request waits on it.
      timeout: Duration.seconds(5),
      memorySize: 256,
    });

    const authorizer = new HttpLambdaAuthorizer("NightshiftAuthorizer", authorizerFunction, {
      // The simple response shape: `isAuthorized` plus a context the handler
      // reads the principal out of. An IAM-policy response would let the
      // authorizer decide *which routes* a caller may reach, which is precisely
      // the decision `authorize` in `core` owns (D-P4-05).
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ["$request.header.Authorization"],
      resultsCacheTtl: AUTHORIZER_CACHE_TTL,
    });
    // One `$default` route carrying the authorizer: the handler owns routing, and
    // there is no second route that could be authored without authorization, but
    // for the preflight route below. The `$default` stage keeps `rawPath`
    // unprefixed, which the handler relies on.
    const integration = new HttpLambdaIntegration("ApiIntegration", apiFunction);
    const httpApi = new HttpApi(this, "HttpApi", {
      description: `Nightshift control plane (${stage})`,
      defaultAuthorizer: authorizer,
      defaultIntegration: integration,
      createDefaultStage: true,
      // The Studio's origins and nothing else (D-P11-03). A preflight from any
      // other origin gets no `Access-Control-Allow-Origin`, and the browser
      // refuses the request itself. `allowCredentials` is deliberately unset.
      corsPreflight: {
        allowOrigins: [...studioOriginsFor(stage)],
        allowMethods: [...CORS_ALLOW_METHODS],
        allowHeaders: [...CORS_ALLOW_HEADERS],
      },
    });
    // The preflight route (D-P11-03). A browser's preflight carries no
    // `Authorization` header, and `$default` matches every method: routed there,
    // the gateway answered `OPTIONS` with a 401 *with* the CORS headers attached
    // — a preflight a browser refuses. Found on the first deploy, 2026-09-28.
    // An `OPTIONS` route more specific than `$default` and bound to no
    // authorizer is what lets the gateway answer the preflight itself from the
    // configuration above. It is the one route not behind the authorizer; it
    // matches `OPTIONS` and nothing else, and an `OPTIONS` that does reach the
    // handler is answered 204 with no body before a principal is looked for.
    httpApi.addRoutes({
      path: PREFLIGHT_ROUTE_PATH,
      methods: [HttpMethod.OPTIONS],
      integration,
      authorizer: new HttpNoneAuthorizer(),
    });

    // --- The sequence materializer (T6) ---------------------------------------------
    // Operationally, anything in this queue is an event that is durable but will
    // never be numbered: the materializer gave up on it after every retry. Readers
    // tolerate unnumbered events (A-22), so nothing breaks, but `findSequenceGaps`
    // cannot see the problem — the run's later events are numbered past it and its
    // position in the order is lost. The same failure follows an outage longer than
    // the stream's 24-hour retention: records expire unread and their events stay
    // unnumbered. A repair path (re-drive from the queue, or rescan a run for null
    // sequences) is not in P2's scope; this comment is where the failure mode is
    // written down instead of discovered.
    const deadLetters = new sqs.Queue(this, "MaterializerDeadLetters", {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // The messages are diagnostics about events that remain in DynamoDB; losing
      // the queue with the stateless stack loses no data.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const materializerLogs = this.logGroup("MaterializerFunctionLogs");
    const materializerRole = this.executionRole("MaterializerFunctionRole", materializerLogs, [
      new iam.PolicyStatement({
        actions: [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
        ],
        resources: [streamArn],
      }),
      // Reads of the event and counter, the counter's first put, and the
      // transactional updates that advance it and stamp the event.
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [tableArn],
      }),
    ]);
    const materializer = this.nodeFunction("MaterializerFunction", {
      entry: MATERIALIZER_ENTRY,
      role: materializerRole,
      logGroup: materializerLogs,
      environment,
      timeout: Duration.seconds(60),
      memorySize: 256,
    });

    new lambda.EventSourceMapping(this, "MaterializerStreamMapping", {
      target: materializer,
      eventSourceArn: streamArn,
      // From the oldest retained record, so an event written before the first
      // deploy of this stack is still numbered.
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: STREAM_BATCH_SIZE,
      maxBatchingWindow: Duration.seconds(0),
      parallelizationFactor: 1,
      // The handler returns the records it did not commit; without this flag
      // Lambda ignores that and retries whole batches.
      reportBatchItemFailures: true,
      retryAttempts: STREAM_RETRY_ATTEMPTS,
      bisectBatchOnError: false,
      onFailure: new SqsDlq(deadLetters),
    });

    // --- The stable hostname (D-P3-18) ---------------------------------------------
    this.customEndpoint =
      this.hostnames === "full" ? this.publicHostname(httpApi, apiHostnameFor(stage)) : undefined;

    // --- Outputs, for the smoke suite and for operators ------------------------------
    new CfnOutput(this, "ApiEndpoint", { value: httpApi.apiEndpoint });
    if (this.customEndpoint !== undefined) {
      new CfnOutput(this, "ApiCustomEndpoint", { value: this.customEndpoint });
    }
    new CfnOutput(this, "ApiFunctionName", { value: apiFunction.functionName });
    new CfnOutput(this, "AuthorizerFunctionName", { value: authorizerFunction.functionName });
    new CfnOutput(this, "MaterializerFunctionName", { value: materializer.functionName });
    new CfnOutput(this, "MaterializerDeadLetterQueueUrl", { value: deadLetters.queueUrl });
  }

  /**
   * `https://<hostname>` in front of `httpApi`: a certificate validated against
   * the zone the DNS stack owns, a custom domain, a mapping to the `$default`
   * stage, and an alias record. Every route stays behind the authorizer: the
   * mapping is to the same API, and a hostname adds no route.
   *
   * The zone arrives by export name, exactly as the data stack's outputs do, so
   * the DNS stack can be deployed and (never, one hopes) replaced on its own.
   */
  private publicHostname(httpApi: HttpApi, hostname: string): string {
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: Fn.importValue(dnsExportName("HostedZoneId")),
      zoneName: ZONE_NAME,
    });
    // DNS validation: CloudFormation writes the validation CNAME into the zone
    // itself, so this needs the zone to be delegated before it can complete.
    // That is the whole reason `zone-only` mode exists.
    const certificate = new acm.Certificate(this, "ApiCertificate", {
      domainName: hostname,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const domain = new DomainName(this, "ApiDomain", { domainName: hostname, certificate });
    new ApiMapping(this, "ApiMapping", { api: httpApi, domainName: domain });
    new route53.ARecord(this, "ApiAlias", {
      zone,
      recordName: hostname,
      target: route53.RecordTarget.fromAlias(
        new ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId),
      ),
      comment: `Nightshift control plane (${this.stage})`,
    });
    return `https://${hostname}`;
  }

  /** A log group with the retention D-P2-10 sets, instead of Lambda's infinite default. */
  private logGroup(id: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      retention: LOG_RETENTION,
      // Logs are diagnostics, not records; they go with the stateless stack.
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  /**
   * A role with no managed policies and exactly the given statements, plus writes
   * to its own log group. `AWSLambdaBasicExecutionRole` is deliberately not used:
   * it grants log writes on every resource.
   */
  private executionRole(
    id: string,
    logGroup: logs.LogGroup,
    statements: readonly iam.PolicyStatement[],
  ): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    // The group ARN ends in `:*`, naming the streams inside that one group; IAM
    // offers no narrower way to name streams Lambda creates on demand.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );
    for (const statement of statements) role.addToPolicy(statement);
    return role;
  }

  /**
   * A bundled Node 22 function. `arm64` because nothing here needs x86 and
   * Graviton is cheaper per millisecond. The AWS SDK is bundled rather than taken
   * from the runtime, so the deployed SDK is the pinned one the tests ran against.
   */
  private nodeFunction(
    id: string,
    props: Required<
      Pick<
        nodejs.NodejsFunctionProps,
        "entry" | "role" | "logGroup" | "environment" | "timeout" | "memorySize"
      >
    >,
  ): nodejs.NodejsFunction {
    return new nodejs.NodejsFunction(this, id, {
      ...props,
      // Bundling emits source maps; Node only applies them to stack traces when
      // asked, and CDK does not ask on our behalf.
      environment: { ...props.environment, NODE_OPTIONS: "--enable-source-maps" },
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      projectRoot: REPO_ROOT,
      depsLockFilePath: `${REPO_ROOT}package-lock.json`,
      bundling: {
        format: nodejs.OutputFormat.CJS,
        target: "node22",
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    });
  }
}
