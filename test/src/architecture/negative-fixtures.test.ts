/**
 * Layer 2 of the architecture suite: every rule is handed a synthetic tree that
 * violates it and must report the offending file by name. Without this layer, a
 * rule that stopped matching anything would keep the real-repo suite green
 * forever.
 *
 * Each rule also gets a positive control — a synthetic tree that is legal and
 * must produce no violations — so a rule that starts firing unconditionally is
 * caught too.
 *
 * Fixture sources are built through `staticImport` rather than written as
 * literal import statements. This file is itself part of the tracked tree that
 * `architecture.test.ts` scans, and a literal import of a forbidden specifier
 * here would (correctly) trip the very rule under test.
 */
import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_RULES,
  type ArchitectureRule,
  extractImports,
  formatViolations,
  makeRepo,
  type PackageManifest,
  type SourceFile,
  type Tsconfig,
} from "./rules.js";

const covered = new Set<string>();

const rule = (id: string): ArchitectureRule => {
  const found = ARCHITECTURE_RULES.find((r) => r.id === id);
  if (found === undefined) throw new Error(`unknown architecture rule ${id}`);
  covered.add(id);
  return found;
};

/** A synthetic source file whose only content is imports of `specifiers`. */
const staticImport = (path: string, ...specifiers: readonly string[]): SourceFile => ({
  path,
  text: specifiers.map((s, i) => `import x${i} from "${s}";`).join("\n"),
});

const manifest = (dir: string, json: PackageManifest) => ({
  dir,
  path: dir === "" ? "package.json" : `${dir}/package.json`,
  json,
});

const tsconfig = (dir: string, refs: readonly string[]): Tsconfig => ({
  dir,
  path: `${dir}/tsconfig.json`,
  json: { references: refs.map((path) => ({ path })) },
});

/** Assert that the reported violations mention exactly `paths`. */
const offendingPaths = (violations: readonly { path: string }[]): string[] =>
  [...new Set(violations.map((v) => v.path))].sort();

describe("AR-1 negative fixtures: contracts and core purity", () => {
  const r = rule("AR-1");

  it("reports a Node builtin, an AWS SDK import, and a forbidden manifest dependency", () => {
    const violations = r.check(
      makeRepo({
        sources: [
          staticImport("packages/core/src/index.ts", "node:fs"),
          staticImport("packages/contracts/src/job.ts", "@aws-sdk/client-dynamodb"),
        ],
        manifests: [manifest("packages/core", { dependencies: { "@aws-sdk/client-s3": "3.0.0" } })],
      }),
    );
    expect(offendingPaths(violations)).toEqual([
      "packages/contracts/src/job.ts",
      "packages/core/package.json",
      "packages/core/src/index.ts",
    ]);
    expect(formatViolations(violations).join("\n")).toContain("node:fs");
  });

  it("reports bare Node builtins, CDK, MCP, harness, and persistence imports", () => {
    const forbidden = [
      "fs",
      "node:crypto",
      "aws-cdk-lib",
      "@modelcontextprotocol/sdk/server/index.js",
      "@nightshift/harness",
      "@nightshift/harness-claude",
      "@nightshift/persistence/memory",
    ];
    for (const specifier of forbidden) {
      const violations = r.check(
        makeRepo({ sources: [staticImport("packages/core/src/x.ts", specifier)] }),
      );
      expect(violations, `expected ${specifier} to be forbidden in packages/core`).toHaveLength(1);
    }
  });

  it("accepts zod, ulid, sibling contracts, and relative imports", () => {
    const violations = r.check(
      makeRepo({
        sources: [
          staticImport(
            "packages/core/src/index.ts",
            "zod",
            "ulid",
            "@nightshift/contracts",
            "./a.js",
          ),
        ],
        manifests: [
          manifest("packages/contracts", { dependencies: { zod: "4.6.4" } }),
          manifest("packages/core", {
            dependencies: { "@nightshift/contracts": "*", ulid: "3.0.2" },
          }),
          // Layers above `core` are not this rule's business.
          manifest("packages/execution", { dependencies: { "@aws-sdk/client-s3": "3.0.0" } }),
        ],
      }),
    );
    expect(formatViolations(violations)).toEqual([]);
  });
});

describe("AR-2 negative fixtures: no harness or provider SDK above the adapter layer", () => {
  const r = rule("AR-2");

  it("reports harness implementations and provider SDKs above the adapter layer", () => {
    const violations = r.check(
      makeRepo({
        sources: [
          staticImport("packages/execution/src/scheduler.ts", "@nightshift/harness-claude"),
          staticImport("packages/routing/src/select.ts", "@nightshift/harness-codex"),
          staticImport("packages/verification/src/run.ts", "@nightshift/harness-agentcore"),
          staticImport("apps/mcp/src/index.ts", "@anthropic-ai/sdk"),
          staticImport("apps/api/src/index.ts", "openai"),
          staticImport("packages/core/src/route.ts", "@aws-sdk/client-bedrock-runtime"),
        ],
      }),
    );
    expect(offendingPaths(violations)).toEqual([
      "apps/api/src/index.ts",
      "apps/mcp/src/index.ts",
      "packages/core/src/route.ts",
      "packages/execution/src/scheduler.ts",
      "packages/routing/src/select.ts",
      "packages/verification/src/run.ts",
    ]);
  });

  it("allows the same imports inside a harness-* package and the adapter contract", () => {
    const violations = r.check(
      makeRepo({
        sources: [
          staticImport("packages/harness-claude/src/index.ts", "@anthropic-ai/sdk"),
          staticImport("packages/harness-codex/src/index.ts", "openai"),
          staticImport(
            "packages/harness-agentcore/src/index.ts",
            "@aws-sdk/client-bedrock-runtime",
          ),
          staticImport("packages/execution/src/scheduler.ts", "@nightshift/harness"),
        ],
      }),
    );
    expect(formatViolations(violations)).toEqual([]);
  });
});

describe("AR-3 negative fixtures: the memory and http adapters stay offline", () => {
  const r = rule("AR-3");

  it("reports an AWS SDK import under packages/persistence/src/http", () => {
    const violations = r.check(
      makeRepo({
        sources: [staticImport("packages/persistence/src/http/stores.ts", "@aws-sdk/client-s3")],
      }),
    );
    expect(offendingPaths(violations)).toEqual(["packages/persistence/src/http/stores.ts"]);
  });

  it("reports an AWS SDK import under packages/persistence/src/memory", () => {
    const violations = r.check(
      makeRepo({
        sources: [
          staticImport("packages/persistence/src/memory/job-store.ts", "@aws-sdk/lib-dynamodb"),
        ],
      }),
    );
    expect(offendingPaths(violations)).toEqual(["packages/persistence/src/memory/job-store.ts"]);
  });

  it("allows the AWS SDK in the aws adapter directory", () => {
    const violations = r.check(
      makeRepo({
        sources: [
          staticImport("packages/persistence/src/aws/job-store.ts", "@aws-sdk/lib-dynamodb"),
        ],
      }),
    );
    expect(formatViolations(violations)).toEqual([]);
  });
});

describe("AR-4 negative fixtures: @nightshift/persistence/aws is not reachable from above", () => {
  const r = rule("AR-4");
  const specifier = "@nightshift/persistence/aws";

  it("reports an import from packages/* and from test/", () => {
    const violations = r.check(
      makeRepo({
        sources: [
          staticImport("packages/execution/src/integrate.ts", specifier),
          staticImport("test/src/conformance/store.test.ts", specifier),
        ],
      }),
    );
    expect(offendingPaths(violations)).toEqual([
      "packages/execution/src/integrate.ts",
      "test/src/conformance/store.test.ts",
    ]);
  });

  it("allows apps/* and infra/cdk", () => {
    const violations = r.check(
      makeRepo({
        sources: [
          staticImport("apps/api/src/index.ts", specifier),
          staticImport("infra/cdk/src/lib/control-plane-stack.ts", specifier),
          staticImport("packages/execution/src/integrate.ts", "@nightshift/persistence/memory"),
        ],
      }),
    );
    expect(formatViolations(violations)).toEqual([]);
  });
});

describe("AR-5 negative fixtures: tsconfig reference direction", () => {
  const r = rule("AR-5");

  it("reports an upward reference and an unknown package directory", () => {
    const violations = r.check(
      makeRepo({
        tsconfigs: [
          tsconfig("packages/core", ["../persistence"]),
          tsconfig("apps/cli", ["../../packages/execution"]),
          tsconfig("packages/mystery", []),
        ],
      }),
    );
    expect(offendingPaths(violations)).toEqual([
      "apps/cli/tsconfig.json",
      "packages/core/tsconfig.json",
      "packages/mystery/tsconfig.json",
    ]);
    expect(formatViolations(violations).join("\n")).toContain("packages/persistence");
  });

  it("accepts the permitted edges, including a path that names tsconfig.json", () => {
    const violations = r.check(
      makeRepo({
        tsconfigs: [
          tsconfig("packages/core", ["../contracts"]),
          tsconfig("packages/harness-claude", [
            "../contracts",
            "../core",
            "../harness/tsconfig.json",
          ]),
          tsconfig("test", [
            "../packages/contracts",
            "../packages/core",
            "../packages/persistence",
          ]),
          tsconfig("infra/cdk", []),
        ],
      }),
    );
    expect(formatViolations(violations)).toEqual([]);
  });

  it("reports an unparseable tsconfig", () => {
    const violations = r.check(
      makeRepo({
        tsconfigs: [{ dir: "packages/core", path: "packages/core/tsconfig.json", json: undefined }],
      }),
    );
    expect(offendingPaths(violations)).toEqual(["packages/core/tsconfig.json"]);
  });
});

describe("AR-6 negative fixtures: exact dependency pins (contract §7)", () => {
  const r = rule("AR-6");

  it("reports carets, tildes, ranges, tags, and unpinned workspace deps", () => {
    const violations = r.check(
      makeRepo({
        manifests: [
          manifest("packages/contracts", { dependencies: { zod: "^4.6.4" } }),
          manifest("packages/core", { dependencies: { ulid: "~3.0.2" } }),
          manifest("apps/cli", { devDependencies: { vitest: ">=5" } }),
          manifest("apps/api", { dependencies: { openai: "latest" } }),
          manifest("apps/mcp", { dependencies: { "@nightshift/core": "^0.0.0" } }),
        ],
      }),
    );
    expect(offendingPaths(violations)).toEqual([
      "apps/api/package.json",
      "apps/cli/package.json",
      "apps/mcp/package.json",
      "packages/contracts/package.json",
      "packages/core/package.json",
    ]);
  });

  it("accepts exact versions, prereleases, and workspace `*`", () => {
    const violations = r.check(
      makeRepo({
        manifests: [
          manifest("", { devDependencies: { typescript: "7.0.2", vitest: "5.0.0" } }),
          manifest("packages/core", {
            dependencies: { "@nightshift/contracts": "*", ulid: "3.0.2" },
            peerDependencies: { zod: "4.6.4-beta.1" },
          }),
        ],
      }),
    );
    expect(formatViolations(violations)).toEqual([]);
  });
});

describe("specifier extraction", () => {
  it("finds static, type-only, re-export, dynamic, and require forms", () => {
    const text = [
      'import a from "./a.js";',
      'import type { B } from "./b.js";',
      'export { c } from "./c.js";',
      'export * from "./d.js";',
      'const e = await import("./e.js");',
      'const f = require("./f.js");',
      'import "./g.js";',
    ].join("\n");
    expect(extractImports(text).map((r) => r.specifier)).toEqual([
      "./a.js",
      "./b.js",
      "./c.js",
      "./d.js",
      "./e.js",
      "./f.js",
      "./g.js",
    ]);
  });

  it("reports the line number of each specifier", () => {
    const text = ["const x = 1;", "", 'import y from "./y.js";'].join("\n");
    expect(extractImports(text)).toEqual([{ specifier: "./y.js", line: 3 }]);
  });
});

it("every architecture rule has a negative fixture", () => {
  expect([...covered].sort()).toEqual(ARCHITECTURE_RULES.map((r) => r.id).sort());
});
