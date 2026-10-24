import { describe, expect, it } from "vitest";
import { inheritFromConfig, NightshiftConfigSchema } from "./config.js";
import { declaredSecrets, redactSecrets, SecretNameSchema } from "./secrets.js";

describe("a project secret's name (A-62)", () => {
  it("is an environment variable name nothing else already sets", () => {
    for (const name of ["NPM_TOKEN", "_x", "GH_PACKAGES_TOKEN2"]) {
      expect(SecretNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of [
      "",
      "2FA",
      "NPM-TOKEN",
      "PATH",
      "home",
      "NIGHTSHIFT_API_TOKEN",
      "OPENAI_API_KEY",
    ]) {
      expect(SecretNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it("is declared by name in a project's config, and nowhere by value", () => {
    const config = NightshiftConfigSchema.parse({
      schemaVersion: 1,
      projectId: "proj_01J0000000000000000000000A",
      contextDocs: [],
      verification: [{ id: "test", command: "npm test" }],
      modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
      delegationLimits: { maxDepth: 3, maxConcurrency: 4 },
      costPolicy: {},
      secrets: ["NPM_TOKEN"],
    });
    const merged = inheritFromConfig({ objective: "x" }, config) as Record<string, unknown>;
    expect(merged.secrets).toEqual(["NPM_TOKEN"]);
  });
});

describe("declaredSecrets", () => {
  it("picks the declared names an environment holds a value for, and nothing else", () => {
    expect(
      declaredSecrets(["NPM_TOKEN", "MISSING", "EMPTY"], {
        NPM_TOKEN: "ghp_abc123",
        EMPTY: "",
        OTHER: "not declared",
      }),
    ).toEqual({ NPM_TOKEN: "ghp_abc123" });
    expect(declaredSecrets(undefined, { NPM_TOKEN: "x" })).toEqual({});
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence of a value with its name, longest first", () => {
    const secrets = { SHORT: "abcd1234", LONG: "abcd1234-and-more" };
    expect(redactSecrets("a abcd1234-and-more b abcd1234 c abcd1234", secrets)).toBe(
      "a «LONG» b «SHORT» c «SHORT»",
    );
  });

  it("leaves a value too short to mask, and text with no secret, untouched", () => {
    expect(redactSecrets("x=abc and more", { TINY: "abc" })).toBe("x=abc and more");
    expect(redactSecrets("nothing here", { NPM_TOKEN: "ghp_abc123" })).toBe("nothing here");
  });
});
