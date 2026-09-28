import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { App, Token } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DATA_EXPORT_KEYS, dataExportName } from "./data-exports.js";
import {
  apiHostnameFor,
  CERTIFICATE_REGION,
  NIGHTSHIFT_ACCOUNT,
  PRIMARY_REGION,
  studioHostnameFor,
  ZONE_NAME,
} from "./hostnames.js";
import { DNS_EXPORT_KEYS, dnsExportName } from "./stack-props.js";
import { composeNightshiftStacks } from "./stacks.js";
import { NightshiftStudioCertificateStack } from "./studio-cert-stack.js";
import {
  NightshiftStudioStack,
  resolveStudioAssets,
  STUDIO_CONFIG_KEY,
  STUDIO_DEPLOYMENT_LOG_RETENTION,
  STUDIO_DIST,
  STUDIO_PLACEHOLDER,
} from "./studio-stack.js";

const HOSTED_ZONE_ID = "Z0TESTZONE";

/**
 * An app that skips the API's bundling; the Studio's own assets are plain
 * directories and are staged for real, which is how the config test reads them.
 */
const testApp = (context: Record<string, unknown> = {}): App =>
  new App({ context: { "aws:cdk:bundling-stacks": [], hostedZoneId: HOSTED_ZONE_ID, ...context } });

/** Both Studio stacks for `stage`, built directly, the certificate handed across. */
const synth = (stage = "dev") => {
  const app = testApp();
  const certificate = new NightshiftStudioCertificateStack(app, "Cert", {
    stage,
    hostedZoneId: HOSTED_ZONE_ID,
  });
  const site = new NightshiftStudioStack(app, "Studio", {
    stage,
    certificate: certificate.certificate,
    assetPath: STUDIO_PLACEHOLDER,
  });
  return {
    app,
    certificate,
    site,
    certTemplate: Template.fromStack(certificate),
    template: Template.fromStack(site),
  };
};

type Resource = { Type: string; Properties?: Record<string, unknown>; DeletionPolicy?: string };

const resourcesOf = (template: Template, type: string): Resource[] =>
  Object.values(template.findResources(type)) as Resource[];

const property = <T>(resource: Resource | undefined, name: string): T => {
  const value = resource?.Properties?.[name];
  if (value === undefined) throw new Error(`resource has no ${name}`);
  return value as T;
};

const importsOf = (template: Template): Set<string> =>
  new Set(
    JSON.stringify(template.toJSON())
      .match(/"Fn::ImportValue":"[^"]+"/g)
      ?.map((match) => match.slice('"Fn::ImportValue":"'.length, -1)),
  );

describe("the Studio's stacks (P11, D-P11-02)", () => {
  it("are named nightshift-<stage>-studio and nightshift-<stage>-studio-cert", () => {
    const { certificate, site } = synth("staging");
    expect(certificate.stackName).toBe("nightshift-staging-studio-cert");
    expect(site.stackName).toBe("nightshift-staging-studio");
    expect(site.stage).toBe("staging");
  });

  it("carry an explicit account and region: the certificate in us-east-1, the site beside the API", () => {
    const { certificate, site } = synth();
    for (const stack of [certificate, site]) {
      expect(Token.isUnresolved(stack.account)).toBe(false);
      expect(Token.isUnresolved(stack.region)).toBe(false);
      expect(stack.account).toBe(NIGHTSHIFT_ACCOUNT);
    }
    expect(certificate.region).toBe(CERTIFICATE_REGION);
    expect(CERTIFICATE_REGION).toBe("us-east-1");
    expect(site.region).toBe(PRIMARY_REGION);
  });

  it("are stateless: no termination protection, and nothing retained", () => {
    const { app, certificate, site, template, certTemplate } = synth();
    const assembly = app.synth();
    for (const stack of [certificate, site]) {
      expect(assembly.getStackByName(stack.stackName).terminationProtection).toBe(false);
    }
    for (const json of [template.toJSON(), certTemplate.toJSON()]) {
      for (const [id, resource] of Object.entries(
        (json as { Resources: Record<string, Resource> }).Resources,
      )) {
        expect(resource.DeletionPolicy ?? "Delete", id).toBe("Delete");
      }
    }
  });

  describe("the certificate stack", () => {
    it("holds one certificate for studio.<stage>…, DNS validated in the zone it was told", () => {
      const { certTemplate } = synth("staging");
      const hostname = studioHostnameFor("staging");
      expect(hostname).toBe(`studio.staging.${ZONE_NAME}`);
      certTemplate.resourceCountIs("AWS::CertificateManager::Certificate", 1);
      certTemplate.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: hostname,
        ValidationMethod: "DNS",
        DomainValidationOptions: [{ DomainName: hostname, HostedZoneId: HOSTED_ZONE_ID }],
      });
      // A regional export cannot cross into us-east-1: the zone id is a value.
      expect(importsOf(certTemplate).size).toBe(0);
      certTemplate.hasOutput("StudioHostname", { Value: hostname });
    });

    it("holds nothing else but what carries the certificate across the region boundary", () => {
      const types = new Set(
        Object.values(synth().certTemplate.toJSON().Resources as Record<string, Resource>).map(
          (resource) => resource.Type,
        ),
      );
      // A bare `App` carries a cross-region reference through an exports writer
      // (a custom resource and its role); the CLI's synth uses the toolkit's
      // `Fn::GetStackOutput` and adds nothing. Either is CDK's, not ours.
      const carriers = new Set([
        "Custom::CrossRegionExportWriter",
        "AWS::Lambda::Function",
        "AWS::IAM::Role",
        "AWS::IAM::Policy",
      ]);
      for (const type of types) {
        expect(
          type === "AWS::CertificateManager::Certificate" ||
            type === "AWS::CDK::Metadata" ||
            carriers.has(type),
          type,
        ).toBe(true);
      }
    });
  });

  describe("the site stack", () => {
    it("keeps the bucket private, encrypted, over TLS, and destroys it with the stack", () => {
      const { template } = synth();
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
        VersioningConfiguration: Match.absent(),
        BucketName: Match.absent(),
      });
      template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        },
      });
      const [bucket] = resourcesOf(template, "AWS::S3::Bucket");
      expect(bucket?.DeletionPolicy).toBe("Delete");
      template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
    });

    it("fronts the bucket with CloudFront through an origin access control, on the stage's hostname", () => {
      const { template, site } = synth("staging");
      const hostname = studioHostnameFor("staging");
      expect(site.hostname).toBe(hostname);
      expect(site.url).toBe(`https://${hostname}`);
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
      template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
      const config = property<Record<string, unknown>>(
        resourcesOf(template, "AWS::CloudFront::Distribution")[0],
        "DistributionConfig",
      );
      expect(config.Aliases).toEqual([hostname]);
      expect(config.DefaultRootObject).toBe("index.html");
      expect(config.Enabled).toBe(true);
      expect(config.DefaultCacheBehavior).toMatchObject({
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: ["GET", "HEAD", "OPTIONS"],
        Compress: true,
      });
      const [origin] = config.Origins as Record<string, unknown>[];
      expect(origin?.OriginAccessControlId).toBeDefined();
      // The control, not the legacy identity.
      expect(origin?.S3OriginConfig).toEqual({ OriginAccessIdentity: "" });
      expect(config.ViewerCertificate).toMatchObject({
        MinimumProtocolVersion: "TLSv1.2_2021",
        SslSupportMethod: "sni-only",
      });
    });

    it("lets only this distribution read the bucket", () => {
      const { template } = synth();
      template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:GetObject",
              Condition: { StringEquals: { "AWS:SourceArn": Match.anyValue() } },
            }),
          ]),
        },
      });
    });

    it("takes the certificate from the us-east-1 stack across the region boundary", () => {
      const { template, certificate } = synth();
      const config = property<{ ViewerCertificate: { AcmCertificateArn: unknown } }>(
        resourcesOf(template, "AWS::CloudFront::Distribution")[0],
        "DistributionConfig",
      );
      const arn = JSON.stringify(config.ViewerCertificate.AcmCertificateArn);
      // Whichever mechanism CDK chose (an exports reader here, the toolkit's
      // `Fn::GetStackOutput` under the CLI), the value names the certificate
      // stack's resource in us-east-1 and is no literal.
      expect(arn).toMatch(/StudioCertificate/);
      expect(arn.replace(/-/g, "")).toContain(CERTIFICATE_REGION.replace(/-/g, ""));
      expect(arn).toContain(certificate.stackName.replace(/-/g, "").slice(0, 10));
      expect(arn).not.toMatch(/^"arn:/);
    });

    it("answers a path the bucket does not hold with the app, so the router owns deep links", () => {
      const config = property<{ CustomErrorResponses: unknown }>(
        resourcesOf(synth().template, "AWS::CloudFront::Distribution")[0],
        "DistributionConfig",
      );
      expect(config.CustomErrorResponses).toEqual(
        [403, 404].map((ErrorCode) => ({
          ErrorCode,
          ResponseCode: 200,
          ResponsePagePath: "/index.html",
          ErrorCachingMinTTL: 0,
        })),
      );
    });

    it("creates the alias record in the zone, imported by export name", () => {
      const { template } = synth("staging");
      template.resourceCountIs("AWS::Route53::RecordSet", 1);
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `${studioHostnameFor("staging")}.`,
        Type: "A",
        HostedZoneId: { "Fn::ImportValue": dnsExportName("HostedZoneId") },
        AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
      });
    });

    it("consumes the data and DNS stacks only through export names, and never the API stack", () => {
      const imports = importsOf(synth("staging").template);
      const allowed = new Set([
        ...DATA_EXPORT_KEYS.map((key) => dataExportName("staging", key)),
        ...DNS_EXPORT_KEYS.map((key) => dnsExportName(key)),
      ]);
      expect(imports.size).toBeGreaterThan(0);
      for (const name of imports) expect(allowed.has(name), name).toBe(true);
      for (const name of imports) expect(name.includes("-api-"), name).toBe(false);
    });

    it("deploys the app and a config.json, pruning what the last deploy left and invalidating every edge", () => {
      const { template } = synth();
      template.resourceCountIs("Custom::CDKBucketDeployment", 1);
      const deployment = resourcesOf(template, "Custom::CDKBucketDeployment")[0];
      expect(property<unknown[]>(deployment, "SourceObjectKeys")).toHaveLength(2);
      expect(property<boolean>(deployment, "Prune")).toBe(true);
      expect(property<string[]>(deployment, "DistributionPaths")).toEqual(["/*"]);
      // The two values a deploy learns from the data stack, spliced into the file.
      const markers = JSON.stringify(property<unknown>(deployment, "SourceMarkers"));
      expect(markers).toContain(dataExportName("dev", "AuthDomain"));
      expect(markers).toContain(dataExportName("dev", "StudioClientId"));
    });

    it("writes config.json with the API's hostname, the auth domain, the client id and the stage", () => {
      const { app, template } = synth("staging");
      const assembly = app.synth();
      // `Source.jsonData` stages the file as an asset directory; read it back.
      const staged = readdirSync(assembly.directory)
        .filter((entry) => entry.startsWith("asset."))
        .map((entry) => join(assembly.directory, entry, STUDIO_CONFIG_KEY))
        .filter((file) => existsSync(file));
      expect(staged).toHaveLength(1);
      // Deploy-time values are bare `<<marker:…>>` tokens in the staged file,
      // which the deployment replaces (quotes included) with the imported
      // values; quoted here so the rest of the file can be read as JSON.
      const text = readFileSync(staged[0] as string, "utf8");
      const config = JSON.parse(
        text.replace(/<<marker:[^>]+>>/g, (m) => JSON.stringify(m)),
      ) as Record<string, unknown>;
      expect(Object.keys(config).sort()).toEqual([
        "apiEndpoint",
        "authDomain",
        "clientId",
        "stage",
      ]);
      expect(config.apiEndpoint).toBe(`https://${apiHostnameFor("staging")}`);
      expect(config.stage).toBe("staging");
      expect(config.authDomain).toMatch(/^<<marker:/);
      expect(config.clientId).toMatch(/^<<marker:/);
      template.hasOutput("ConfigApiEndpoint", { Value: `https://${apiHostnameFor("staging")}` });
    });

    it("logs the deployment to an explicit group with 30-day retention (D-P2-10)", () => {
      const { template } = synth();
      template.resourceCountIs("AWS::Logs::LogGroup", 1);
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: Number(STUDIO_DEPLOYMENT_LOG_RETENTION),
      });
    });

    it("outputs the hosted URL and hostname for the smoke suite", () => {
      const { template } = synth();
      template.hasOutput("StudioUrl", { Value: `https://${studioHostnameFor("dev")}` });
      template.hasOutput("StudioHostname", { Value: studioHostnameFor("dev") });
      template.hasOutput("DistributionId", {});
      template.hasOutput("SiteBucketName", {});
    });
  });

  describe("what is deployed", () => {
    it("is an explicit directory, else the built app, else the placeholder", () => {
      expect(resolveStudioAssets("/somewhere/else")).toBe("/somewhere/else");
      expect(resolveStudioAssets(undefined)).toBe(
        existsSync(STUDIO_DIST) ? STUDIO_DIST : STUDIO_PLACEHOLDER,
      );
      expect(resolveStudioAssets("")).toBe(resolveStudioAssets(undefined));
    });

    it("has a placeholder page in the repository, so the hosting is provable before the app is", () => {
      const page = readFileSync(join(STUDIO_PLACEHOLDER, "index.html"), "utf8");
      expect(page).toContain("<title>Nightshift Studio</title>");
      expect(page).toContain("/config.json");
    });
  });
});

describe("the whole app (bin/app.ts, through composeNightshiftStacks)", () => {
  it("builds both Studio stacks in full mode, depending on the data and DNS stacks", () => {
    const app = testApp({ studioAssets: STUDIO_PLACEHOLDER });
    const stacks = composeNightshiftStacks(app);
    expect(stacks.hostnames).toBe("full");
    expect(stacks.studio).toBeDefined();
    const names = app.synth().stacks.map((stack) => stack.stackName);
    expect(names).toEqual(
      expect.arrayContaining([
        "nightshift-dns",
        "nightshift-dev-data",
        "nightshift-dev-api",
        "nightshift-dev-studio-cert",
        "nightshift-dev-studio",
      ]),
    );
    expect(names).toHaveLength(5);
    expect(stacks.studio?.site.dependencies).toEqual(
      expect.arrayContaining([stacks.data, stacks.dns, stacks.studio?.certificate]),
    );
  });

  it("builds neither in zone-only mode, as it omits the API's domain", () => {
    const app = testApp({ hostnames: "zone-only" });
    const stacks = composeNightshiftStacks(app);
    expect(stacks.studio).toBeUndefined();
    expect(stacks.api.customEndpoint).toBeUndefined();
    const names = app.synth().stacks.map((stack) => stack.stackName);
    expect(names.sort()).toEqual(["nightshift-dev-api", "nightshift-dev-data", "nightshift-dns"]);
  });

  it("refuses full mode without a zone id, naming the context key and the way out", () => {
    const app = new App({
      context: { "aws:cdk:bundling-stacks": [], studioAssets: STUDIO_PLACEHOLDER },
    });
    expect(() => composeNightshiftStacks(app)).toThrow(/hostedZoneId[\s\S]*zone-only/);
    // Refused before any stack was built, so nothing half-composed remains.
    expect(app.node.children).toHaveLength(0);
  });

  it("names a non-default stage everywhere", () => {
    const app = testApp({ stage: "staging", studioAssets: STUDIO_PLACEHOLDER });
    composeNightshiftStacks(app);
    const names = app.synth().stacks.map((stack) => stack.stackName);
    expect(names).toEqual(
      expect.arrayContaining([
        "nightshift-staging-data",
        "nightshift-staging-api",
        "nightshift-staging-studio-cert",
        "nightshift-staging-studio",
      ]),
    );
  });
});
