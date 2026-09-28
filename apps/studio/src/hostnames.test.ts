import { describe, expect, it } from "vitest";
import {
  apiEndpointFor,
  authDomainFor,
  DEV_PORT,
  STUDIO_CLIENT_IDS,
  studioOriginFor,
} from "./hostnames.js";

describe("hostnames", () => {
  // The literals the CLI and the CDK stacks pin as well; a drift is a red test.
  it("pins the dev stage's names", () => {
    expect(apiEndpointFor("dev")).toBe("https://api.dev.nightshift.wildorder.dev");
    expect(studioOriginFor("dev")).toBe("https://studio.dev.nightshift.wildorder.dev");
    expect(authDomainFor("dev")).toBe(
      "nightshift-dev-755348349819.auth.us-west-2.amazoncognito.com",
    );
  });

  it("bakes the dev Studio client id", () => {
    expect(STUDIO_CLIENT_IDS.dev).toBe("5ouksqs8o9tnakehqnit7pumig");
  });

  it("serves on the port the dev Studio client registers", () => {
    expect(DEV_PORT).toBe(5173);
  });
});
