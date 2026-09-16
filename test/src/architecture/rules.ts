/**
 * Architecture rules for Nightshift v1 (T3; SC-P1-19 … SC-P1-21, contract §7).
 *
 * Every rule is a pure function over an in-memory snapshot of the repository:
 * source files as `{ path, text }`, package manifests as `{ dir, json }`, and
 * tsconfigs as `{ dir, json }`. That shape is what makes the negative-fixture
 * tests possible — a rule can be handed a synthetic violating tree and must
 * report it. A rule that silently passes forever is the failure this guards
 * against, so `negative-fixtures.test.ts` is as load-bearing as the real-repo
 * suite in `architecture.test.ts`.
 *
 * Node builtins and vitest only (decision D-P1-09): no dependency-cruiser, no
 * madge, no TypeScript parser.
 *
 * IMPORTANT for anyone editing the fixtures: this module and its tests are
 * themselves part of the scanned tree, and specifier extraction is a regex over
 * raw text. Never write a forbidden specifier immediately after the words
 * from / import / require inside a quoted string, or the rules will flag their
 * own test file. The fixture helper in the test file exists for that reason.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface PackageManifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

export interface Manifest {
  /** Repo-relative package directory, e.g. `packages/core`. `""` for the root. */
  readonly dir: string;
  readonly path: string;
  readonly json: PackageManifest;
}

export interface TsconfigJson {
  readonly references?: readonly { readonly path?: string }[];
}

export interface Tsconfig {
  readonly dir: string;
  readonly path: string;
  /** `undefined` when the file could not be parsed — itself a violation. */
  readonly json: TsconfigJson | undefined;
}

export interface Repo {
  readonly sources: readonly SourceFile[];
  readonly manifests: readonly Manifest[];
  readonly tsconfigs: readonly Tsconfig[];
}

export interface Violation {
  readonly path: string;
  readonly detail: string;
}

export interface ArchitectureRule {
  readonly id: string;
  readonly name: string;
  readonly check: (repo: Repo) => Violation[];
}

/** Build a snapshot for a fixture test; unspecified sections are empty. */
export const makeRepo = (parts: Partial<Repo>): Repo => ({
  sources: parts.sources ?? [],
  manifests: parts.manifests ?? [],
  tsconfigs: parts.tsconfigs ?? [],
});

/** `path — detail`, the form both test layers assert on. */
export const formatViolations = (violations: readonly Violation[]): string[] =>
  violations.map((v) => `${v.path} — ${v.detail}`);

// ---------------------------------------------------------------------------
// The layer table (docs/architecture.md §1)
// ---------------------------------------------------------------------------

/**
 * Permitted TypeScript project-reference targets per package directory.
 *
 * Declared once here and nowhere else in the tests. It mirrors the intent of
 * the `PACKAGES` map in `scripts/scaffold-packages.mjs` but is deliberately an
 * independent copy: a scaffold that drifts from the layer diagram must fail
 * this rule rather than redefine it.
 *
 * The edges are listed explicitly instead of derived from a layer index,
 * because "anything below me" is too permissive — `apps/cli` is a thin client
 * (A-16) and the harness implementations are reachable only from the adapter
 * layer.
 */
export const PERMITTED_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  "packages/contracts": [],
  "packages/core": ["packages/contracts"],
  "packages/persistence": ["packages/contracts", "packages/core"],
  "packages/harness": ["packages/contracts", "packages/core"],
  "packages/harness-claude": ["packages/contracts", "packages/core", "packages/harness"],
  "packages/harness-codex": ["packages/contracts", "packages/core", "packages/harness"],
  "packages/harness-agentcore": ["packages/contracts", "packages/core", "packages/harness"],
  // P3 (D-P3-12): the runner drives the verification package directly.
  "packages/execution": [
    "packages/contracts",
    "packages/core",
    "packages/harness",
    "packages/verification",
  ],
  "packages/routing": ["packages/contracts", "packages/core"],
  "packages/verification": ["packages/contracts", "packages/core"],
  "apps/api": ["packages/contracts", "packages/core", "packages/persistence"],
  // P3 (D-P3-12): the CLI is still a thin client, but it mints identifiers and
  // speaks to the control plane through the http adapter. It also references
  // `execution` for exactly one function — `startRun`, the half of starting a
  // run that `nightshift run` and the MCP `run.start` share (D-P3-17, A-32).
  // T7 sanctions this: "the layer table gains `execution` for `apps/cli` only if
  // that function lives there", and it does, because creating the initial
  // checkpoint is a git operation and the CLI holds no domain logic of its own.
  "apps/cli": ["packages/contracts", "packages/core", "packages/persistence", "packages/execution"],
  // P3 (D-P3-12): `apps/mcp` is a composition root and names the Claude adapter
  // in exactly one module, which AR-2 permits by path.
  "apps/mcp": [
    "packages/contracts",
    "packages/core",
    "packages/persistence",
    "packages/execution",
    "packages/routing",
    "packages/verification",
    "packages/harness",
    "packages/harness-claude",
  ],
  "infra/cdk": [],
  // P3 (D-P3-12): the slice suite drives the real server, the real execution
  // layer and the real local control plane, so `test` references what it drives.
  test: [
    "packages/contracts",
    "packages/core",
    "packages/persistence",
    "packages/harness",
    "packages/execution",
    "packages/verification",
    "apps/api",
    // P3 (T7 deliverable 8): the CLI's commands are held to the **real**
    // handler here. `apps/cli` may not reference `apps/api`, so its own tests
    // drive an injected transport and say what that leaves unproven; `test`
    // references both, so this is where a route the CLI spells differently
    // from the API becomes a 404.
    "apps/cli",
    "apps/mcp",
  ],
};

/** `packages/core` -> `@nightshift/core`. */
export const packageNameOf = (dir: string): string => {
  const last = dir.split("/").pop();
  return `@nightshift/${last === undefined || last === "" ? dir : last}`;
};

/** Which workspace package a repo-relative path belongs to, if any. */
export const packageDirOf = (path: string): string | undefined => {
  const parts = path.split("/");
  const top = parts[0];
  if (top === "test") return "test";
  if (top === "packages" || top === "apps" || top === "infra") {
    const second = parts[1];
    return second === undefined || parts.length < 3 ? undefined : `${top}/${second}`;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Specifier extraction
// ---------------------------------------------------------------------------

export interface ImportRef {
  readonly specifier: string;
  readonly line: number;
}

/**
 * Matches the quoted specifier of a static import or re-export, a dynamic
 * import, and a CommonJS require. Deliberately a regex, not a parser (D-P1-09).
 *
 * Known limitations, chosen so the rules over-report rather than under-report:
 * a specifier that appears inside a comment or a string literal after one of
 * those keywords is treated as a real import, and a dynamic import built from a
 * template literal or a variable is invisible. Over-reporting is loud and gets
 * fixed; under-reporting is a rule that quietly stops enforcing.
 */
const SPECIFIER_RE = /\b(?:from|import|require)\s*\(?\s*["']([^"'\r\n]+)["']/g;

export const extractImports = (text: string): ImportRef[] => {
  const refs: ImportRef[] = [];
  SPECIFIER_RE.lastIndex = 0;
  for (let m = SPECIFIER_RE.exec(text); m !== null; m = SPECIFIER_RE.exec(text)) {
    const specifier = m[1];
    if (specifier === undefined) continue;
    refs.push({ specifier, line: text.slice(0, m.index).split("\n").length });
  }
  return refs;
};

/** Every source file that belongs to one of the given package directories. */
const sourcesIn = (repo: Repo, dirs: readonly string[]): readonly SourceFile[] =>
  repo.sources.filter((f) => dirs.some((d) => f.path.startsWith(`${d}/`)));

const isSubpathOf = (specifier: string, pkg: string): boolean =>
  specifier === pkg || specifier.startsWith(`${pkg}/`);

// ---------------------------------------------------------------------------
// Forbidden-specifier predicates
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const PURE_DIRS = ["packages/contracts", "packages/core"];

/** Externals `contracts` and `core` may declare (contract §7, D-P1-05). */
const PURE_ALLOWED_EXTERNALS = new Set(["zod", "ulid"]);

/** Rule AR-1: what may never be imported by `contracts` or `core`. */
const purityViolation = (specifier: string): string | undefined => {
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) return "a Node builtin";
  if (specifier.startsWith("@aws-sdk/")) return "the AWS SDK";
  if (isSubpathOf(specifier, "aws-cdk-lib")) return "the CDK library";
  if (specifier.startsWith("@modelcontextprotocol/")) return "the MCP SDK";
  if (specifier.startsWith("@nightshift/harness")) return "a harness package";
  if (specifier.startsWith("@nightshift/persistence")) return "the persistence layer";
  return undefined;
};

const HARNESS_IMPLEMENTATIONS = [
  "@nightshift/harness-claude",
  "@nightshift/harness-codex",
  "@nightshift/harness-agentcore",
];

/** Rule AR-2: harness implementations and provider SDKs. */
const adapterLeakViolation = (specifier: string): string | undefined => {
  const harness = HARNESS_IMPLEMENTATIONS.find((h) => isSubpathOf(specifier, h));
  if (harness !== undefined) return `harness implementation \`${harness}\``;
  if (specifier.startsWith("@anthropic-ai/")) return "provider SDK `@anthropic-ai/*`";
  if (isSubpathOf(specifier, "openai")) return "provider SDK `openai`";
  if (/^@aws-sdk\/client-bedrock/.test(specifier)) return "provider SDK `@aws-sdk/client-bedrock*`";
  return undefined;
};

/**
 * Composition roots (D-P3-12, A-31).
 *
 * P1's rule forbade a harness implementation anywhere above the adapter layer,
 * which included every app — and therefore left nothing in the repository able
 * to instantiate an adapter at all. A rule that forbids the program from working
 * is a rule with a gap, not a strict rule.
 *
 * The amendment is the narrowest thing that closes it: **one named file per
 * app**, listed here by exact path. Everything else in that app is still
 * refused, and the ban stays absolute on `execution`, `routing`, `verification`,
 * `core` and `contracts` — the packages where a harness-specific import would
 * actually do damage, and the ones SC-P1-20 was really about.
 *
 * A path here is a decision, not a convenience. Adding a second file to this
 * list would be reintroducing the problem one file at a time.
 */
const COMPOSITION_ROOTS: readonly string[] = ["apps/mcp/src/compose.ts"];

/**
 * What only a composition root may import, inside the app that owns one.
 *
 * `@nightshift/persistence/http` is here for the same reason a harness is: the
 * MCP server must not learn which adapter backs its stores, or the slice suite's
 * ability to run the real binary against a local control plane would be a
 * fiction. Other apps may import it freely — `apps/cli` is a thin client of the
 * same API — so this is scoped to the app that has a composition root.
 */
const PERSISTENCE_HTTP = "@nightshift/persistence/http";

const isCompositionRoot = (path: string): boolean => COMPOSITION_ROOTS.includes(path);

/** The app a composition root belongs to, e.g. `apps/mcp`. */
const APPS_WITH_COMPOSITION_ROOTS: readonly string[] = COMPOSITION_ROOTS.map(
  (path) => packageDirOf(path) ?? "",
);

/**
 * Rule AR-2 applies above the adapter layer: the named packages plus every
 * app. `apps/*` is matched by prefix so a new app is covered the day it is
 * created. `packages/harness-*`, `packages/persistence` and `infra/cdk` sit at
 * or below the adapter layer and are deliberately absent.
 */
const ABOVE_ADAPTER_PACKAGES = new Set([
  "packages/contracts",
  "packages/core",
  "packages/execution",
  "packages/routing",
  "packages/verification",
]);

const isAboveAdapterLayer = (dir: string): boolean =>
  ABOVE_ADAPTER_PACKAGES.has(dir) || dir.startsWith("apps/");

/**
 * Adapter directories that must never touch the AWS SDK.
 *
 * `memory` is test-only and must run offline (D-P1-08). `http` is the adapter the
 * local machinery uses, and the whole point of it is that an orchestrator on a
 * laptop needs no AWS credentials (A-28, D-P3-02) — an AWS import here would be
 * that guarantee quietly lapsing.
 */
const AWS_FREE_ADAPTER_PREFIXES: readonly [string, string][] = [
  [
    "packages/persistence/src/memory/",
    "the memory adapter is test-only and must run offline (D-P1-08)",
  ],
  [
    "packages/persistence/src/http/",
    "the http adapter reaches the control plane over HTTPS and must hold no AWS credentials (A-28)",
  ],
];

const PERSISTENCE_AWS = "@nightshift/persistence/aws";

/** Only the top of the stack and the IaC app may reach the AWS adapters. */
const mayImportPersistenceAws = (dir: string): boolean =>
  dir.startsWith("apps/") || dir === "infra/cdk";

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Flatten every dependency map into `[field, name, range]` triples. */
const allDependencies = (json: PackageManifest): [string, string, string][] => {
  const out: [string, string, string][] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const map = json[field];
    if (map === undefined) continue;
    for (const [name, range] of Object.entries(map)) out.push([field, name, range]);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Rule bodies
// ---------------------------------------------------------------------------

/** Resolve a tsconfig `references[].path` to a repo-relative directory. */
const normalizeReference = (fromDir: string, refPath: string): string => {
  const segments = fromDir === "" ? [] : fromDir.split("/");
  const cleaned = refPath.replace(/\\/g, "/").replace(/\/?tsconfig\.json$/i, "");
  for (const part of cleaned.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
};

const pureImportViolations = (repo: Repo): Violation[] => {
  const violations: Violation[] = [];
  for (const file of sourcesIn(repo, PURE_DIRS)) {
    for (const ref of extractImports(file.text)) {
      const why = purityViolation(ref.specifier);
      if (why === undefined) continue;
      violations.push({
        path: file.path,
        detail: `line ${ref.line} imports \`${ref.specifier}\` (${why}); contracts and core stay offline and dependency-free`,
      });
    }
  }
  return violations;
};

const pureManifestViolations = (repo: Repo): Violation[] => {
  const violations: Violation[] = [];
  for (const manifest of repo.manifests) {
    if (!PURE_DIRS.includes(manifest.dir)) continue;
    const allowedWorkspace = new Set((PERMITTED_REFERENCES[manifest.dir] ?? []).map(packageNameOf));
    const allowedList = [...PURE_ALLOWED_EXTERNALS, ...allowedWorkspace].join(", ");
    for (const [field, name, range] of allDependencies(manifest.json)) {
      const allowed = name.startsWith("@nightshift/")
        ? allowedWorkspace.has(name)
        : PURE_ALLOWED_EXTERNALS.has(name);
      if (allowed) continue;
      violations.push({
        path: manifest.path,
        detail: `${field} contains \`${name}@${range}\`; ${manifest.dir} may only depend on ${allowedList}`,
      });
    }
  }
  return violations;
};

const referenceViolations = (tsconfig: Tsconfig): Violation[] => {
  if (tsconfig.json === undefined) {
    return [{ path: tsconfig.path, detail: "could not be parsed as JSON" }];
  }
  const permitted = PERMITTED_REFERENCES[tsconfig.dir];
  if (permitted === undefined) {
    return [
      {
        path: tsconfig.path,
        detail: `\`${tsconfig.dir}\` is not in the layer table; add it to PERMITTED_REFERENCES with its permitted targets`,
      },
    ];
  }
  const violations: Violation[] = [];
  for (const ref of tsconfig.json.references ?? []) {
    if (ref.path === undefined) {
      violations.push({ path: tsconfig.path, detail: "a reference has no `path`" });
      continue;
    }
    const target = normalizeReference(tsconfig.dir, ref.path);
    if (permitted.includes(target)) continue;
    violations.push({
      path: tsconfig.path,
      detail: `references \`${target}\`, which is not a permitted target for \`${tsconfig.dir}\` (permitted: ${permitted.join(", ") || "none"})`,
    });
  }
  return violations;
};

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

export const ARCHITECTURE_RULES: readonly ArchitectureRule[] = [
  {
    id: "AR-1",
    name: "contracts and core are pure: no AWS, CDK, MCP, harness, persistence, or Node-builtin import (SC-P1-19)",
    check: (repo) => [...pureImportViolations(repo), ...pureManifestViolations(repo)],
  },
  {
    id: "AR-2",
    name: "no harness implementation or provider SDK above the adapter layer, except in a named composition root (SC-P1-20, D-P3-12)",
    check: (repo) => {
      const violations: Violation[] = [];
      for (const file of repo.sources) {
        const dir = packageDirOf(file.path);
        if (dir === undefined || !isAboveAdapterLayer(dir)) continue;
        const root = isCompositionRoot(file.path);

        for (const ref of extractImports(file.text)) {
          // A composition root may name an adapter. That is the whole of the
          // exception, and it is granted by exact path.
          const why = adapterLeakViolation(ref.specifier);
          if (why !== undefined && !root) {
            violations.push({
              path: file.path,
              detail: `line ${ref.line} imports ${why}; ${dir} sits above the adapter layer, so provider-specific code must stay inside a harness-* package or its app's composition root (${COMPOSITION_ROOTS.join(", ")})`,
            });
          }
          // And inside an app that *has* a composition root, the http
          // persistence adapter is that root's business too.
          if (
            isSubpathOf(ref.specifier, PERSISTENCE_HTTP) &&
            !root &&
            APPS_WITH_COMPOSITION_ROOTS.includes(dir)
          ) {
            violations.push({
              path: file.path,
              detail: `line ${ref.line} imports \`${ref.specifier}\`; ${dir} has a composition root, and wiring an adapter is its job alone`,
            });
          }
        }
      }
      return violations;
    },
  },
  {
    id: "AR-3",
    name: "the memory and http adapters have no AWS SDK import (SC-P1-21, A-28)",
    check: (repo) => {
      const violations: Violation[] = [];
      for (const file of repo.sources) {
        const match = AWS_FREE_ADAPTER_PREFIXES.find(([prefix]) => file.path.startsWith(prefix));
        if (match === undefined) continue;
        for (const ref of extractImports(file.text)) {
          if (!ref.specifier.startsWith("@aws-sdk/")) continue;
          violations.push({
            path: file.path,
            detail: `line ${ref.line} imports \`${ref.specifier}\`; ${match[1]}`,
          });
        }
      }
      return violations;
    },
  },
  {
    id: "AR-4",
    name: "only apps/* and infra/cdk import @nightshift/persistence/aws (D-P1-08)",
    check: (repo) => {
      const violations: Violation[] = [];
      for (const file of repo.sources) {
        const dir = packageDirOf(file.path);
        if (dir !== undefined && mayImportPersistenceAws(dir)) continue;
        for (const ref of extractImports(file.text)) {
          if (!isSubpathOf(ref.specifier, PERSISTENCE_AWS)) continue;
          violations.push({
            path: file.path,
            detail: `line ${ref.line} imports \`${ref.specifier}\`; nothing above persistence may reach the AWS adapters directly`,
          });
        }
      }
      return violations;
    },
  },
  {
    id: "AR-5",
    name: "tsconfig project references follow the layer diagram (docs/architecture.md §1)",
    check: (repo) => repo.tsconfigs.flatMap(referenceViolations),
  },
  {
    id: "AR-6",
    name: "every external dependency is pinned exactly (contract §7)",
    check: (repo) => {
      const violations: Violation[] = [];
      for (const manifest of repo.manifests) {
        for (const [field, name, range] of allDependencies(manifest.json)) {
          if (name.startsWith("@nightshift/")) {
            if (range === "*") continue;
            violations.push({
              path: manifest.path,
              detail: `${field}.${name} is \`${range}\`; workspace-internal dependencies use \`*\``,
            });
            continue;
          }
          if (EXACT_VERSION_RE.test(range)) continue;
          violations.push({
            path: manifest.path,
            detail: `${field}.${name} is \`${range}\`; every external dependency must be pinned exactly (no ^, no ~, no range)`,
          });
        }
      }
      return violations;
    },
  },
];

// ---------------------------------------------------------------------------
// Loading the real repository
// ---------------------------------------------------------------------------

const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/;

const git = (args: readonly string[], cwd: string): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Alternation order matters: a string literal is matched first, so a `//` or
 * `/*` sequence inside a string (a `$schema` URL, say) is never mistaken for a
 * comment.
 */
const JSONC_STRING_OR_COMMENT = /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** Strip `//` and block comments that sit outside string literals. */
const stripJsonComments = (text: string): string =>
  text.replace(JSONC_STRING_OR_COMMENT, (match) => (match.startsWith('"') ? match : ""));

/**
 * Minimal JSONC reader. tsconfig files may carry comments and trailing commas;
 * handling them here avoids a parser dependency (D-P1-09).
 */
export const parseJsonc = (text: string): unknown =>
  JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1"));

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const baseNameOf = (path: string): string => path.split("/").pop() ?? path;

const isSourcePath = (path: string): boolean => SOURCE_RE.test(path) && !path.endsWith(".d.ts");

/**
 * The root solution tsconfig references every project by design, so only
 * per-package configs express a layering claim. `tsconfig.base.json` and
 * `tsconfig.typecheck.json` have other basenames and are skipped already.
 */
const isPackageTsconfig = (path: string): boolean =>
  baseNameOf(path) === "tsconfig.json" && path !== "tsconfig.json";

const toManifest = (path: string, text: string | undefined): Manifest[] => {
  if (text === undefined) return [];
  let json: Record<string, unknown> | undefined;
  try {
    json = asObject(parseJsonc(text));
  } catch {
    return [];
  }
  if (json === undefined) return [];
  const dir = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
  return [{ dir, path, json: json as unknown as PackageManifest }];
};

const toTsconfig = (path: string, text: string | undefined): Tsconfig[] => {
  if (text === undefined) return [];
  const dir = path.slice(0, -"/tsconfig.json".length);
  try {
    return [{ dir, path, json: (asObject(parseJsonc(text)) ?? {}) as unknown as TsconfigJson }];
  } catch {
    return [{ dir, path, json: undefined }];
  }
};

let cached: Repo | undefined;

/**
 * Snapshot the tracked tree. The file list comes from `git ls-files` — tracked
 * files only, never a directory walk — and no git ref other than HEAD is read
 * (greenfield boundary, A-01). Cached per module instance so repeated rule
 * evaluation costs one git call.
 */
export const loadRepo = (): Repo => {
  if (cached !== undefined) return cached;
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const paths = git(["ls-files", "-z"], root)
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"));

  const read = (path: string): string | undefined => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      // Tracked but absent from the working copy (a staged deletion).
      return undefined;
    }
  };

  cached = {
    sources: paths.filter(isSourcePath).flatMap((p) => {
      const text = read(p);
      return text === undefined ? [] : [{ path: p, text }];
    }),
    manifests: paths
      .filter((p) => baseNameOf(p) === "package.json")
      .flatMap((p) => toManifest(p, read(p))),
    tsconfigs: paths.filter(isPackageTsconfig).flatMap((p) => toTsconfig(p, read(p))),
  };
  return cached;
};
