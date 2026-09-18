import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadTokenConfig } from "./config.js";

/** What the CDK stack gives **every** function. */
const shared = {
  NIGHTSHIFT_TABLE_NAME: "table",
  NIGHTSHIFT_BUCKET_NAME: "bucket",
  NIGHTSHIFT_STAGE: "dev",
};

/** What it gives the API function on top, because only that one signs. */
const tokens = {
  NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID: "11111111-2222-3333-4444-555555555555",
  NIGHTSHIFT_TOKEN_ISSUER: "https://api.dev.nightshift.wildorder.dev",
};

describe("loadConfig", () => {
  it("reads a complete environment", () => {
    expect(loadConfig({ ...shared, ...tokens, UNRELATED: "ignored" })).toEqual({
      tableName: "table",
      bucketName: "bucket",
      stage: "dev",
    });
  });

  /**
   * The regression this pins (2026-09-17). P4 added the token variables to this
   * shared schema, and the **materializer** — which shares it and signs nothing
   * — crashed at cold start on every invocation. The stream backed up behind a
   * function that could not load, and the smoke suite reported it as "the
   * materializer looks broken" sixty seconds at a time.
   *
   * A shared config schema holds the intersection of what the functions need,
   * never the union.
   */
  it("holds only what every function has, so the materializer still starts", () => {
    expect(() => loadConfig(shared)).not.toThrow();
  });
});

describe("loadTokenConfig", () => {
  it("reads the API function's own variables", () => {
    expect(loadTokenConfig({ ...shared, ...tokens })).toEqual({
      executionTokenKeyId: "11111111-2222-3333-4444-555555555555",
      tokenIssuer: "https://api.dev.nightshift.wildorder.dev",
    });
  });

  it("refuses an environment without them, naming both", () => {
    const attempt = () => loadTokenConfig(shared);
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/NIGHTSHIFT_EXECUTION_TOKEN_KEY_ID, NIGHTSHIFT_TOKEN_ISSUER/);
  });
});

describe("loadConfig refusals", () => {
  it("names every missing or empty variable at once", () => {
    const attempt = () => loadConfig({ NIGHTSHIFT_TABLE_NAME: "", NIGHTSHIFT_STAGE: "dev" });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/NIGHTSHIFT_TABLE_NAME, NIGHTSHIFT_BUCKET_NAME/);
  });
});
