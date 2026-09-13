#!/usr/bin/env node
/**
 * One-shot scaffold for the P1 workspace package skeletons (T1).
 *
 * Encodes the layering of docs/architecture.md §1: each package's permitted
 * reference targets are listed explicitly rather than derived from a layer
 * number, because the harness-* and persistence/aws restrictions are not
 * expressible as "anything below me".
 *
 * Safe to re-run: it never overwrites an existing src file.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");

const EXTERNAL = {
  zod: "4.6.4",
  ulid: "3.0.2",
  "aws-cdk-lib": "2.269.0",
  constructs: "10.8.1",
};

/** dir -> { refs: workspace package dirs it may reference, ext: external deps, stub } */
const PACKAGES = {
  "packages/contracts": { refs: [], ext: ["zod"] },
  "packages/core": { refs: ["packages/contracts"], ext: ["ulid"] },
  "packages/persistence": { refs: ["packages/contracts", "packages/core"], ext: [] },
  "packages/harness": { refs: ["packages/contracts", "packages/core"], ext: [] },
  "packages/harness-claude": {
    refs: ["packages/contracts", "packages/core", "packages/harness"],
    ext: [],
  },
  "packages/harness-codex": {
    refs: ["packages/contracts", "packages/core", "packages/harness"],
    ext: [],
  },
  "packages/harness-agentcore": {
    refs: ["packages/contracts", "packages/core", "packages/harness"],
    ext: [],
  },
  "packages/execution": {
    refs: ["packages/contracts", "packages/core", "packages/harness"],
    ext: [],
  },
  "packages/routing": { refs: ["packages/contracts", "packages/core"], ext: [] },
  "packages/verification": { refs: ["packages/contracts", "packages/core"], ext: [] },
  "apps/api": {
    refs: ["packages/contracts", "packages/core", "packages/persistence"],
    ext: [],
  },
  "apps/cli": { refs: ["packages/contracts"], ext: [] },
  "apps/mcp": {
    refs: [
      "packages/contracts",
      "packages/core",
      "packages/persistence",
      "packages/execution",
      "packages/routing",
      "packages/verification",
    ],
    ext: [],
  },
  "infra/cdk": { refs: [], ext: ["aws-cdk-lib", "constructs"] },
  test: {
    refs: ["packages/contracts", "packages/core", "packages/persistence"],
    ext: [],
  },
};

const pkgName = (dir) => `@nightshift/${dir.split("/").pop()}`;

const SUMMARY = {
  "packages/contracts": "Versioned domain schemas and types. Imports nothing but zod.",
  "packages/core": "Pure domain rules and persistence port interfaces. No I/O.",
  "packages/persistence": "Persistence adapters. ./memory is test-only; ./aws is DynamoDB and S3.",
  "packages/harness": "Harness adapter contract. Contains no provider code.",
  "packages/harness-claude": "Claude Code harness adapter.",
  "packages/harness-codex": "Codex harness adapter.",
  "packages/harness-agentcore": "AgentCore harness adapter.",
  "packages/execution": "Scheduling, worktrees, and integration. No harness-specific import.",
  "packages/routing": "Model and harness selection.",
  "packages/verification": "Deterministic verification.",
  "apps/api": "Control-plane HTTP runtime.",
  "apps/cli": "CLI: nightshift run, nightshift run --remote. A thin client (A-16).",
  "apps/mcp": "Nightshift MCP server.",
  "infra/cdk": "AWS CDK v2 app. The sole IaC system (A-09).",
  test: "Cross-package fixtures, conformance suites, and architecture tests.",
};

const write = (rel, content, { overwrite = true } = {}) => {
  const path = join(root, rel);
  if (!overwrite && existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return true;
};

const relPath = (from, to) => {
  const depth = from.split("/").length;
  return `${"../".repeat(depth)}${to}`;
};

for (const [dir, spec] of Object.entries(PACKAGES)) {
  const name = pkgName(dir);
  const isCdk = dir === "infra/cdk";
  const isTest = dir === "test";

  const dependencies = {};
  for (const ref of spec.refs) dependencies[pkgName(ref)] = "*";
  for (const e of spec.ext) dependencies[e] = EXTERNAL[e];

  const pkg = {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    description: SUMMARY[dir],
    ...(isCdk || isTest
      ? {}
      : {
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          },
        }),
    ...(dir === "packages/persistence"
      ? {
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./memory": {
              types: "./dist/memory/index.d.ts",
              default: "./dist/memory/index.js",
            },
            "./aws": { types: "./dist/aws/index.d.ts", default: "./dist/aws/index.js" },
          },
        }
      : {}),
    ...(isCdk ? { scripts: { synth: "cdk synth --no-lookups" } } : {}),
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  };

  write(`${dir}/package.json`, JSON.stringify(pkg, null, 2));

  const tsconfig = {
    extends: relPath(dir, "tsconfig.base.json"),
    compilerOptions: { rootDir: "src", outDir: "dist" },
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.test.ts", "dist"],
    ...(spec.refs.length > 0
      ? { references: spec.refs.map((r) => ({ path: relPath(dir, r) })) }
      : {}),
  };
  write(`${dir}/tsconfig.json`, JSON.stringify(tsconfig, null, 2));

  const entry = isCdk ? "src/lib/index.ts" : "src/index.ts";
  write(`${dir}/${entry}`, `// ${SUMMARY[dir]}\nexport {};\n`, { overwrite: false });
}

// apps/studio is reserved and deliberately has no build (architecture A-15).
write(
  "apps/studio/package.json",
  JSON.stringify(
    {
      name: "@nightshift/studio",
      version: "0.0.0",
      private: true,
      description:
        "Reserved. Not built in v1 (A-15). The v1 data surface is in scope; the UI is not.",
    },
    null,
    2,
  ),
);
write(
  "apps/studio/README.md",
  "# @nightshift/studio\n\nReserved. Not built in v1 (architecture A-15). The Studio is a client of the v1 APIs, not a backend; only its data surface is in v1 scope.\n",
);

// Root solution tsconfig: a pure references list, no files of its own.
write(
  "tsconfig.json",
  JSON.stringify(
    {
      files: [],
      references: Object.keys(PACKAGES).map((d) => ({ path: `./${d}` })),
    },
    null,
    2,
  ),
);

console.log(`scaffolded ${Object.keys(PACKAGES).length} packages + apps/studio`);
