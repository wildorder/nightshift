import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const complete = {
  NIGHTSHIFT_TABLE_NAME: "table",
  NIGHTSHIFT_BUCKET_NAME: "bucket",
  NIGHTSHIFT_STAGE: "dev",
};

describe("loadConfig", () => {
  it("reads a complete environment", () => {
    expect(loadConfig({ ...complete, UNRELATED: "ignored" })).toEqual({
      tableName: "table",
      bucketName: "bucket",
      stage: "dev",
    });
  });

  it("names every missing or empty variable at once", () => {
    const attempt = () => loadConfig({ NIGHTSHIFT_TABLE_NAME: "", NIGHTSHIFT_STAGE: "dev" });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/NIGHTSHIFT_TABLE_NAME, NIGHTSHIFT_BUCKET_NAME/);
  });
});
