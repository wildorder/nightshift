import { App, Token } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { NightshiftControlPlaneStack } from "./control-plane-stack.js";

/** Resource types the CDK itself may add; everything else is a P1 violation. */
const ALLOWED_RESOURCE_TYPES = new Set(["AWS::CDK::Metadata"]);

describe("NightshiftControlPlaneStack", () => {
  it("synthesizes without throwing", () => {
    const app = new App();
    const stack = new NightshiftControlPlaneStack(app, "TestStack", { stage: "dev" });

    expect(() => Template.fromStack(stack)).not.toThrow();
  });

  it("defines no resources beyond CDK metadata", () => {
    const app = new App();
    const stack = new NightshiftControlPlaneStack(app, "TestStack", { stage: "dev" });

    const template = Template.fromStack(stack).toJSON() as {
      Resources?: Record<string, { Type: string }>;
    };

    // `Resources` may be absent entirely for an empty stack.
    const resources = template.Resources ?? {};
    const unexpected = Object.entries(resources)
      .filter(([, resource]) => !ALLOWED_RESOURCE_TYPES.has(resource.Type))
      .map(([logicalId, resource]) => `${logicalId} (${resource.Type})`);

    expect(unexpected).toEqual([]);
  });

  it("is environment-agnostic", () => {
    const app = new App();
    const stack = new NightshiftControlPlaneStack(app, "TestStack", { stage: "dev" });

    // Unresolved tokens rather than a concrete account or region.
    expect(Token.isUnresolved(stack.account)).toBe(true);
    expect(Token.isUnresolved(stack.region)).toBe(true);

    const assembly = app.synth();
    const { environment } = assembly.getStackByName(stack.stackName);
    expect(environment.account).toBe("unknown-account");
    expect(environment.region).toBe("unknown-region");
    expect(environment.name).toBe("aws://unknown-account/unknown-region");
  });

  it("names the stack nightshift-<stage>-control-plane", () => {
    const app = new App();
    const dev = new NightshiftControlPlaneStack(app, "DevStack", { stage: "dev" });
    const staging = new NightshiftControlPlaneStack(app, "StagingStack", { stage: "staging" });

    expect(dev.stackName).toBe("nightshift-dev-control-plane");
    expect(staging.stackName).toBe("nightshift-staging-control-plane");
    expect(staging.stage).toBe("staging");
  });
});
