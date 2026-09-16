import { describe, expect, it } from "vitest";
import {
  apiEndpointFor,
  authDomainFor,
  DEFAULT_STAGE,
  defaultsFor,
  INTERACTIVE_CLIENT_IDS,
  isGeneratedEndpoint,
} from "./hostnames.js";

describe("stage defaults (D-P3-18)", () => {
  it("pins the literal the CDK rule also pins, so the two cannot drift apart", () => {
    expect(apiEndpointFor("dev")).toBe("https://api.dev.nightshift.wildorder.dev");
  });

  it("derives the Cognito hosted domain from the stage, the account and the region", () => {
    expect(authDomainFor("dev")).toBe(
      "nightshift-dev-755348349819.auth.us-west-2.amazoncognito.com",
    );
  });

  it("knows the dev interactive client and admits it knows no other", () => {
    expect(defaultsFor(DEFAULT_STAGE).clientId).toBe(INTERACTIVE_CLIENT_IDS.dev);
    expect(defaultsFor("prod").clientId).toBeUndefined();
    expect(defaultsFor("prod").apiEndpoint).toBe("https://api.prod.nightshift.wildorder.dev");
  });

  it("recognises a generated endpoint a stack replacement would change", () => {
    expect(isGeneratedEndpoint("https://4xnsx809u6.execute-api.us-west-2.amazonaws.com")).toBe(
      true,
    );
    expect(isGeneratedEndpoint("https://api.dev.nightshift.wildorder.dev")).toBe(false);
  });
});
