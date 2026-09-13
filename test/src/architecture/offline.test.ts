/**
 * SC-P1-18 — no network or AWS dependency is required for the domain tests.
 *
 * The architecture rules already forbid the *imports* that would make a network
 * call possible from `contracts` or `core`. This file states the criterion
 * directly, so the claim is a named failing test if it is ever broken rather
 * than a sentence in a comment, and extends it to the test files themselves: a
 * property test that reached for the network would be just as disqualifying as
 * a source file that did.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRepo, type SourceFile } from "./rules.js";

/**
 * Specifiers that imply reaching outside the process. `node:` builtins are
 * covered separately by AR-1; these are the libraries that would carry traffic.
 */
const NETWORK_SPECIFIERS = [
  "@aws-sdk/",
  "@smithy/",
  "aws-sdk",
  "aws-cdk-lib",
  "node-fetch",
  "axios",
  "undici",
  "got",
  "superagent",
  "ws",
  "@modelcontextprotocol/",
];

/** Globals whose use would perform I/O without an import to catch. */
const NETWORK_GLOBALS = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bnew\s+WebSocket\b/];

const OFFLINE_PACKAGES = ["packages/contracts/", "packages/core/"];

const inOfflinePackages = (files: readonly SourceFile[]): readonly SourceFile[] =>
  files.filter((file) => OFFLINE_PACKAGES.some((prefix) => file.path.startsWith(prefix)));

describe("SC-P1-18: the domain runs offline", () => {
  const snapshot = loadRepo();
  const offline = inOfflinePackages(snapshot.sources);

  it("finds the files it claims to be checking", () => {
    // A silent empty set would make every assertion below vacuous.
    expect(offline.length).toBeGreaterThan(20);
    expect(offline.some((file) => file.path.endsWith(".test.ts"))).toBe(true);
  });

  it("imports no networking or AWS library, including from test files", () => {
    const offenders = offline.flatMap((file) =>
      NETWORK_SPECIFIERS.filter((specifier) =>
        new RegExp(`from\\s+["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(
          file.text,
        ),
      ).map((specifier) => `${file.path} imports ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("calls no network global", () => {
    const offenders = offline.flatMap((file) =>
      NETWORK_GLOBALS.filter((pattern) => pattern.test(file.text)).map(
        (pattern) => `${file.path} matches ${String(pattern)}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("declares no runtime dependency beyond zod and ulid", () => {
    const permitted = new Set(["zod", "ulid", "@nightshift/contracts"]);
    for (const manifest of snapshot.manifests) {
      if (!OFFLINE_PACKAGES.some((prefix) => `${manifest.dir}/`.startsWith(prefix))) continue;
      const declared = Object.keys(manifest.json.dependencies ?? {});
      for (const name of declared) {
        expect(permitted.has(name), `${manifest.dir} depends on ${name}`).toBe(true);
      }
    }
  });

  it("needs no AWS credentials: nothing reads an AWS environment variable", () => {
    const offenders = offline
      .filter((file) => /process\.env\.AWS_|AWS_PROFILE|AWS_REGION/.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("keeps the CDK app environment-agnostic, so synth needs no account", () => {
    // SC-P1-09's companion: synth is part of the same credential-free gate.
    const app = readFileSync("infra/cdk/src/bin/app.ts", "utf8");
    expect(app).not.toMatch(/CDK_DEFAULT_ACCOUNT|CDK_DEFAULT_REGION/);
    expect(app).not.toMatch(/\benv\s*:/);
  });
});
