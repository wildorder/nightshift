import { describe, expect, it } from "vitest";
import {
  apiHostnameFor,
  CERTIFICATE_REGION,
  NIGHTSHIFT_ACCOUNT,
  PRIMARY_REGION,
  parseHostnamesMode,
  STUDIO_DEV_ORIGIN,
  studioHostnameFor,
  studioOriginsFor,
} from "./hostnames.js";

/**
 * The hostname rule, pinned as literals (D-P3-18, D-P11-02). The CLI and the
 * Studio each restate it and pin the same literals; a drift between any two is
 * a red test rather than a hostname that resolves to nothing.
 */
describe("the hostname rule", () => {
  it("pins the dev literals the CLI and the Studio restate", () => {
    expect(apiHostnameFor("dev")).toBe("api.dev.nightshift.wildorder.dev");
    expect(studioHostnameFor("dev")).toBe("studio.dev.nightshift.wildorder.dev");
  });

  it("puts the stage in the name, so a later stage is a new record and never a rename", () => {
    expect(studioHostnameFor("prod")).toBe("studio.prod.nightshift.wildorder.dev");
    expect(apiHostnameFor("prod")).toBe("api.prod.nightshift.wildorder.dev");
  });

  it("lists the Studio's origins: hosted everywhere, localhost on dev alone (D-P11-01)", () => {
    expect(studioOriginsFor("dev")).toEqual([
      "https://studio.dev.nightshift.wildorder.dev",
      "http://localhost:5173",
    ]);
    expect(studioOriginsFor("prod")).toEqual(["https://studio.prod.nightshift.wildorder.dev"]);
    expect(STUDIO_DEV_ORIGIN).toBe("http://localhost:5173");
  });

  it("restates the one account and its regions as the CLI and the deploy guard do", () => {
    expect(NIGHTSHIFT_ACCOUNT).toBe("755348349819");
    expect(PRIMARY_REGION).toBe("us-west-2");
    expect(CERTIFICATE_REGION).toBe("us-east-1");
  });

  it("parses the hostnames mode and refuses anything else", () => {
    expect(parseHostnamesMode(undefined)).toBe("full");
    expect(parseHostnamesMode("zone-only")).toBe("zone-only");
    expect(() => parseHostnamesMode("all")).toThrow(/invalid hostnames mode/);
  });
});
