/**
 * The Studio's hosting: `nightshift-<stage>-studio` (P11, D-P11-02).
 *
 * A private bucket, a CloudFront distribution reading it through an origin
 * access control, the alias record `studio.<stage>.nightshift.wildorder.dev`,
 * and a deployment that fills the bucket from the built app on every deploy
 * beside a `config.json` written from stack values: the API endpoint, the
 * Cognito hosted domain, the Studio's app client id and the stage. The app
 * reads that file at startup (T1) and holds no other configuration.
 *
 * Nothing here is stateful. The bucket is rebuilt from the repository on every
 * deploy and destroyed with the stack; the distribution and the record are
 * configuration CloudFormation recreates exactly. The certificate comes from
 * `nightshift-<stage>-studio-cert` in `us-east-1` by CDK cross-region reference,
 * which is why this stack carries an explicit account and region.
 *
 * ## What it imports, and how
 *
 * The zone id, the auth domain and the Studio client id arrive by export name
 * from the DNS and data stacks in the same region, exactly as the API stack
 * consumes them. The API endpoint is not imported at all: it is the hostname
 * rule (`api.<stage>…`, D-P3-18), which is the address the Studio must call
 * (D-P11-03) and the reason the studio stack does not depend on the API stack.
 *
 * ## The app it serves
 *
 * `assetPath` is the directory deployed: `apps/studio/dist` once T1's build
 * exists, else the placeholder page beside this package, and
 * `-c studioAssets=<dir>` to point anywhere. Deep links (`/projects/…`) are a
 * single-page app's: the distribution answers a missing key with `index.html`
 * and a 200, so React Router owns the path.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { dataExportName } from "./data-exports.js";
import {
  apiHostnameFor,
  NIGHTSHIFT_ACCOUNT,
  PRIMARY_REGION,
  studioHostnameFor,
  ZONE_NAME,
} from "./hostnames.js";
import { assertValidStage, dnsExportName, stackNameFor } from "./stack-props.js";

/** The repository root, resolved from this module (`src/lib` and `dist/lib` sit at the same depth). */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Where `vite build` puts the Studio (T1). */
export const STUDIO_DIST = `${REPO_ROOT}apps/studio/dist`;

/**
 * What is served until T1's build exists: one page saying so. Tracked in the
 * repository so a synth from a fresh checkout has something to deploy and the
 * hosting is provable before the app is.
 */
export const STUDIO_PLACEHOLDER = `${REPO_ROOT}infra/cdk/studio-placeholder`;

/**
 * The directory to deploy: an explicit override, else the built app when it
 * exists, else the placeholder. Decided at synth, on the machine that synths.
 */
export const resolveStudioAssets = (override: unknown): string => {
  if (typeof override === "string" && override.length > 0) return override;
  return existsSync(STUDIO_DIST) ? STUDIO_DIST : STUDIO_PLACEHOLDER;
};

/** The file the app reads at startup, and its keys (T1 deliverable 6). */
export const STUDIO_CONFIG_KEY = "config.json";

/** Its shape. Every value is a public fact about the stage; nothing here is a secret. */
export interface StudioConfig {
  /** `https://api.<stage>.nightshift.wildorder.dev`. */
  readonly apiEndpoint: string;
  /** The Cognito hosted domain, without a scheme. */
  readonly authDomain: string;
  /** The Studio's app client id (`StudioClientId`). */
  readonly clientId: string;
  readonly stage: string;
}

/** D-P2-10: enough to debug a deploy, cheap, and never infinite. */
export const STUDIO_DEPLOYMENT_LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

export interface NightshiftStudioStackProps {
  /** Deployment stage, e.g. `dev`. Part of the stack name and the hostname. */
  readonly stage: string;
  /** The certificate from `nightshift-<stage>-studio-cert`, in `us-east-1`. */
  readonly certificate: acm.ICertificate;
  /** The directory to deploy; see `resolveStudioAssets`. */
  readonly assetPath: string;
  readonly description?: string;
}

export class NightshiftStudioStack extends Stack {
  readonly stage: string;
  readonly hostname: string;
  /** `https://studio.<stage>.nightshift.wildorder.dev`. */
  readonly url: string;
  readonly bucket: s3.IBucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: NightshiftStudioStackProps) {
    const { stage, certificate, assetPath, ...stackProps } = props;
    assertValidStage(stage);
    super(scope, id, {
      stackName: stackNameFor(stage, "studio"),
      // Explicit, because a cross-region reference needs both ends to know
      // where they are; the primary region, beside the API it is a client of.
      env: { account: NIGHTSHIFT_ACCOUNT, region: PRIMARY_REGION },
      crossRegionReferences: true,
      ...stackProps,
    });
    this.stage = stage;
    this.hostname = studioHostnameFor(stage);
    this.url = `https://${this.hostname}`;

    // --- The bucket: private, rebuilt on every deploy ------------------------------
    // Held as `IBucket`: `Bucket` declares `isWebsite` as `boolean | undefined`
    // where the interface says `boolean?`, which `exactOptionalPropertyTypes`
    // refuses to pass through. Nothing below needs the class.
    this.bucket = new s3.Bucket(this, "SiteBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Nothing in it exists anywhere but the repository, so it goes with the
      // stack, contents included.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    }) as s3.IBucket;

    // --- The distribution, on the stage's hostname -----------------------------------
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `Nightshift Studio (${stage})`,
      defaultBehavior: {
        // An origin access control: the bucket stays private and only this
        // distribution may read it. Not the legacy origin access identity.
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      defaultRootObject: "index.html",
      domainNames: [this.hostname],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // North America and Europe: one owner, one continent, no reason to pay
      // for every edge.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      // A single-page app: a path the bucket does not hold is a route the app
      // does. S3 behind an origin access control answers a missing key with
      // 403 (it may not list), so both codes map to the app's entry, with a
      // 200 so the browser treats it as a page rather than an error.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
        ttl: Duration.seconds(0),
      })),
    });

    // --- The alias record, in the zone the DNS stack owns ---------------------------
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: Fn.importValue(dnsExportName("HostedZoneId")),
      zoneName: ZONE_NAME,
    });
    new route53.ARecord(this, "StudioAlias", {
      zone,
      recordName: this.hostname,
      target: route53.RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
      comment: `Nightshift Studio (${stage})`,
    });

    // --- The app, and its configuration ------------------------------------------
    const config: StudioConfig = {
      apiEndpoint: `https://${apiHostnameFor(stage)}`,
      authDomain: Fn.importValue(dataExportName(stage, "AuthDomain")),
      clientId: Fn.importValue(dataExportName(stage, "StudioClientId")),
      stage,
    };
    const deploymentLogs = new logs.LogGroup(this, "SiteDeploymentLogs", {
      retention: STUDIO_DEPLOYMENT_LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new BucketDeployment(this, "SiteDeployment", {
      destinationBucket: this.bucket,
      sources: [Source.asset(assetPath), Source.jsonData(STUDIO_CONFIG_KEY, config)],
      // The bucket holds exactly this deploy's files: what a previous deploy
      // wrote and this one did not is removed, and every edge cache is
      // invalidated so `index.html` and `config.json` are the new ones at once.
      prune: true,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      logGroup: deploymentLogs,
    });

    // --- Outputs, for the smoke suite and for operators ------------------------------
    new CfnOutput(this, "StudioUrl", { value: this.url });
    new CfnOutput(this, "StudioHostname", { value: this.hostname });
    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
    new CfnOutput(this, "SiteBucketName", { value: this.bucket.bucketName });
    new CfnOutput(this, "ConfigApiEndpoint", { value: config.apiEndpoint });
  }
}
