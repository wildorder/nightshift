import { App, Token } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { NightshiftDnsStack } from "./dns-stack.js";
import { ZONE_NAME } from "./hostnames.js";
import { DNS_EXPORT_KEYS, DNS_STACK_NAME, dnsExportName } from "./stack-props.js";

interface CfnResource {
  readonly Type: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

const synth = () => {
  const app = new App();
  const stack = new NightshiftDnsStack(app, "Dns");
  const template = Template.fromStack(stack);
  return {
    app,
    stack,
    template,
    json: template.toJSON() as {
      Resources?: Record<string, CfnResource>;
      Outputs?: Record<string, { Export?: { Name?: string } }>;
    },
  };
};

describe("NightshiftDnsStack (D-P3-18)", () => {
  it("is the one unstaged stack, named nightshift-dns, with termination protection", () => {
    const { stack, app } = synth();
    expect(stack.stackName).toBe(DNS_STACK_NAME);
    expect(DNS_STACK_NAME).not.toMatch(/dev|staging|prod/);
    expect(app.synth().getStackByName(stack.stackName).terminationProtection).toBe(true);
  });

  it("is environment-agnostic, so synth needs no account", () => {
    const { stack } = synth();
    expect(Token.isUnresolved(stack.account)).toBe(true);
    expect(Token.isUnresolved(stack.region)).toBe(true);
  });

  it("holds exactly one public hosted zone, nightshift.wildorder.dev, retained", () => {
    const { template, json } = synth();
    template.resourceCountIs("AWS::Route53::HostedZone", 1);
    template.hasResourceProperties("AWS::Route53::HostedZone", { Name: `${ZONE_NAME}.` });
    const zone = Object.values(json.Resources ?? {}).find(
      (resource) => resource.Type === "AWS::Route53::HostedZone",
    );
    expect(zone?.DeletionPolicy).toBe("Retain");
    expect(zone?.UpdateReplacePolicy).toBe("Retain");
    expect(ZONE_NAME).toBe("nightshift.wildorder.dev");
  });

  it("creates no records of its own: stages own their records", () => {
    synth().template.resourceCountIs("AWS::Route53::RecordSet", 0);
  });

  it("exports the zone id, the zone name and the nameservers a human delegates to", () => {
    const { json, template } = synth();
    expect(Object.keys(json.Outputs ?? {}).sort()).toEqual([...DNS_EXPORT_KEYS].sort());
    for (const key of DNS_EXPORT_KEYS) {
      expect(json.Outputs?.[key]?.Export?.Name).toBe(dnsExportName(key));
    }
    template.hasOutput("NameServers", {
      Value: {
        "Fn::Join": [" ", { "Fn::GetAtt": [Match.stringLikeRegexp("^Zone"), "NameServers"] }],
      },
    });
  });
});
