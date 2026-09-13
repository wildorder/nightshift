#!/usr/bin/env node
/**
 * Greenfield sterility check (T3, SC-P1-01 … SC-P1-04, decision D-P1-09).
 *
 * Enforces that nothing from a prior Nightshift generation survives on this
 * branch. Five rules, defined by `tasks/p1-foundation/T3-sterility-and-
 * architecture.md`:
 *
 *   1. No v0 artifacts: `nightshift.config.json`, `docs/as-built.md`, or a v0
 *      manifest (JSON/YAML with a top-level `workstreams` key) under
 *      `docs/programs/` or `tasks/`.
 *   2. No `package.json` depends on `@wildorder/nightshift` or on any package
 *      whose name contains `program-pipeline`.
 *   3. No tracked file contains a v0 marker string.
 *   4. `AGENTS.md` carries the greenfield sentence verbatim.
 *   5. No tracked file lives under `dist/`, `build-logs/`, `unused/`, or
 *      `worktrees/`.
 *
 * Design notes:
 *
 * - The file list comes from `git ls-files` (tracked files only). The working
 *   directory is never walked, so untracked scratch files cannot fail the build
 *   and, conversely, a deleted-but-still-tracked file is still checked.
 * - No git history and no ref other than HEAD is read. `git rev-parse
 *   --show-toplevel` and `git ls-files` are the only git invocations.
 * - Node builtins only (D-P1-09). Runs identically on Windows and Linux; git
 *   emits forward slashes on both.
 * - Every rule carries a built-in negative fixture and a clean fixture, and
 *   both are asserted on every run. A rule that has silently stopped detecting
 *   anything fails the check instead of passing forever.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The sentence rule 4 requires, verbatim. */
const GREENFIELD_SENTENCE =
  "Do not inspect legacy branches, tags, commits, or prior Nightshift source " +
  "unless explicitly instructed by a human.";

/** Marker strings whose presence anywhere proves v0 lineage (rule 3). */
const V0_MARKERS = ["program-pipeline", "nightshift:sha256=", "deciderAgent", "reviewerAgent"];

/**
 * Rule 3 skips these paths: this script and its test define the markers, and
 * the T3 task spec quotes them. The exclusion is mandated by the spec.
 */
const MARKER_EXEMPT = new Set(["scripts/check-sterility.mjs", "scripts/check-sterility.test.mjs"]);
const MARKER_EXEMPT_PREFIXES = ["tasks/"];

/** Directory names that must never contain a tracked file (rule 5). */
const FORBIDDEN_DIRS = new Set(["dist", "build-logs", "unused", "worktrees"]);

/** Files whose mere presence is a v0 artifact (rule 1). */
const FORBIDDEN_BASENAMES = new Set(["nightshift.config.json"]);
const FORBIDDEN_PATHS = new Set(["docs/as-built.md"]);

/** Where a v0 program manifest would live (rule 1). */
const MANIFEST_DIRS = ["docs/programs/", "tasks/"];

/** Collapse all whitespace so a sentence wrapped across lines still matches. */
const squash = (text) => text.replace(/\s+/g, " ").trim();

const isMarkerExempt = (path) =>
  MARKER_EXEMPT.has(path) || MARKER_EXEMPT_PREFIXES.some((p) => path.startsWith(p));

/**
 * A v0 manifest is a JSON or YAML file under docs/programs/ or tasks/ that
 * either names itself a manifest/workstream file or carries a top-level
 * `workstreams` key. v1 program plans and task specs are Markdown, so any
 * structured file in those directories is already suspect.
 */
const looksLikeManifestName = (path) =>
  /(^|[-_.])(workstreams?|program-pipeline|manifest)([-_.]|$)/i.test(basename(path));

const hasWorkstreamsKey = (path, text) => {
  if (/\.json$/i.test(path)) {
    try {
      const parsed = JSON.parse(text);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        Object.hasOwn(parsed, "workstreams")
      );
    } catch {
      // Unparseable JSON cannot be proven to be a manifest; rule 3 still sees it.
      return false;
    }
  }
  return /^workstreams\s*:/m.test(text);
};

/** Every dependency map a package.json can carry. */
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const dependencyNames = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { names: [], ownName: undefined, parsed: undefined };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { names: [], ownName: undefined, parsed: undefined };
  }
  const names = [];
  for (const field of DEP_FIELDS) {
    const map = parsed[field];
    if (typeof map === "object" && map !== null) names.push(...Object.keys(map));
  }
  const ownName = typeof parsed.name === "string" ? parsed.name : undefined;
  return { names, ownName, parsed };
};

/**
 * The rules. Each `detect` is a pure function of an in-memory file list
 * (`{ path, text }[]`) and returns every offender, never just the first.
 */
const RULES = [
  {
    id: 1,
    // SC-P1-01 (no legacy source) and SC-P1-02 (no v0 program/task artifacts).
    criteria: ["SC-P1-01", "SC-P1-02"],
    name: "no v0 artifacts or manifests",
    detect(files) {
      const offenders = [];
      for (const { path, text } of files) {
        if (FORBIDDEN_PATHS.has(path)) {
          offenders.push({ path, detail: "v0 as-built document" });
          continue;
        }
        if (FORBIDDEN_BASENAMES.has(basename(path))) {
          offenders.push({ path, detail: "v0 configuration schema" });
          continue;
        }
        if (!MANIFEST_DIRS.some((dir) => path.startsWith(dir))) continue;
        if (!/\.(json|ya?ml)$/i.test(path)) continue;
        if (looksLikeManifestName(path)) {
          offenders.push({ path, detail: "filename marks a v0 program manifest" });
          continue;
        }
        if (hasWorkstreamsKey(path, text)) {
          offenders.push({ path, detail: "top-level `workstreams` key marks a v0 manifest" });
        }
      }
      return offenders;
    },
    fixtures: {
      violating: [
        { path: "nightshift.config.json", text: "{}\n" },
        { path: "docs/as-built.md", text: "# As built\n" },
        { path: "docs/programs/legacy.yaml", text: "workstreams:\n  - id: ws1\n" },
      ],
      expected: 3,
    },
  },
  {
    id: 2,
    // SC-P1-03: a dependency on the v0 package is a v0 configuration schema.
    criteria: ["SC-P1-03"],
    name: "no package.json depends on v0 packages",
    detect(files) {
      const offenders = [];
      for (const { path, text } of files) {
        if (basename(path) !== "package.json") continue;
        const { names, ownName } = dependencyNames(text);
        if (ownName?.includes("program-pipeline") === true) {
          offenders.push({ path, detail: `package name \`${ownName}\` is a v0 package` });
        }
        for (const dep of names) {
          if (dep === "@wildorder/nightshift" || dep.includes("program-pipeline")) {
            offenders.push({ path, detail: `depends on \`${dep}\`` });
          }
        }
      }
      return offenders;
    },
    fixtures: {
      violating: [
        {
          path: "packages/legacy/package.json",
          text: JSON.stringify({
            name: "@nightshift/legacy",
            dependencies: { "@wildorder/nightshift": "0.18.0" },
          }),
        },
      ],
      expected: 1,
    },
  },
  {
    id: 3,
    // SC-P1-01 and SC-P1-03: v0 config keys and pipeline markers.
    criteria: ["SC-P1-01", "SC-P1-03"],
    name: "no v0 marker strings",
    detect(files) {
      const offenders = [];
      for (const { path, text } of files) {
        if (isMarkerExempt(path) || text === "") continue;
        for (const marker of V0_MARKERS) {
          if (text.includes(marker)) {
            offenders.push({ path, detail: `contains v0 marker \`${marker}\`` });
          }
        }
      }
      return offenders;
    },
    fixtures: {
      violating: [
        { path: "packages/core/src/legacy.ts", text: 'export const agent = "deciderAgent";\n' },
      ],
      expected: 1,
    },
  },
  {
    id: 4,
    // SC-P1-04.
    criteria: ["SC-P1-04"],
    name: "AGENTS.md forbids autonomous legacy inspection",
    detect(files) {
      const agents = files.find((f) => f.path === "AGENTS.md");
      if (agents === undefined) {
        return [{ path: "AGENTS.md", detail: "file is missing from the tracked tree" }];
      }
      if (!squash(agents.text).includes(GREENFIELD_SENTENCE)) {
        return [
          {
            path: "AGENTS.md",
            detail: `missing the required sentence: "${GREENFIELD_SENTENCE}"`,
          },
        ];
      }
      return [];
    },
    fixtures: {
      violating: [{ path: "AGENTS.md", text: "# Agent Directives\n\nRead the docs.\n" }],
      expected: 1,
    },
  },
  {
    id: 5,
    // SC-P1-01: tracked build output is v0 source by another name.
    criteria: ["SC-P1-01"],
    name: "no tracked build output or scratch directories",
    detect(files) {
      const offenders = [];
      for (const { path } of files) {
        const segment = path.split("/").find((s) => FORBIDDEN_DIRS.has(s));
        if (segment !== undefined) {
          offenders.push({ path, detail: `tracked under \`${segment}/\`` });
        }
      }
      return offenders;
    },
    fixtures: {
      violating: [
        { path: "packages/core/dist/index.js", text: "export {};\n" },
        { path: "worktrees/job-1/README.md", text: "scratch\n" },
      ],
      expected: 2,
    },
  },
];

/**
 * A minimal tree that must satisfy every rule. Asserted on each run so a rule
 * that has started firing unconditionally is caught too.
 */
const CLEAN_FIXTURE = [
  {
    path: "AGENTS.md",
    text: `**This is a greenfield implementation. ${GREENFIELD_SENTENCE.replace(
      "prior Nightshift source",
      "prior Nightshift\nsource",
    )}**\n`,
  },
  { path: "package.json", text: JSON.stringify({ name: "nightshift", private: true }) },
  { path: "packages/core/src/index.ts", text: "export {};\n" },
  { path: "docs/programs/p1-foundation.md", text: "# Program P1\n" },
];

/** Verify every rule still detects its own violation and still accepts a clean tree. */
const selfCheck = () => {
  const results = [];
  for (const rule of RULES) {
    const detected = rule.detect(rule.fixtures.violating).length;
    const falsePositives = rule.detect(CLEAN_FIXTURE);
    const problems = [];
    if (detected < rule.fixtures.expected) {
      problems.push(
        `negative fixture: expected >= ${rule.fixtures.expected} offenders, got ${detected}`,
      );
    }
    if (falsePositives.length > 0) {
      problems.push(
        `clean fixture: unexpected offenders ${falsePositives.map((o) => o.path).join(", ")}`,
      );
    }
    results.push({ rule: rule.id, name: rule.name, ok: problems.length === 0, problems });
  }
  return results;
};

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Largest file we will read into memory for content rules. */
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

/**
 * Load the tracked tree. Content comes from the working copy of each tracked
 * path, which is what a developer and CI both see; the *list* is git's, so
 * untracked files are invisible to the check. Binary and oversized files get
 * an empty text so the content rules skip them; the path rules still apply.
 */
const loadTrackedFiles = (root) => {
  const list = git(["ls-files", "-z"], root).split("\0").filter(Boolean);
  const files = [];
  for (const path of list) {
    let text = "";
    try {
      const buffer = readFileSync(join(root, path));
      if (buffer.length <= MAX_CONTENT_BYTES && !buffer.includes(0)) {
        text = buffer.toString("utf8");
      }
    } catch {
      // Tracked but absent from the working copy (staged deletion): path rules
      // still apply, content rules cannot.
    }
    files.push({ path: path.replace(/\\/g, "/"), text });
  }
  return files;
};

const main = () => {
  const json = process.argv.includes("--json");
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const files = loadTrackedFiles(root);

  const self = selfCheck();
  const selfOk = self.every((r) => r.ok);

  const ruleResults = RULES.map((rule) => ({
    rule: rule.id,
    criteria: rule.criteria,
    name: rule.name,
    offenders: rule.detect(files),
  }));
  const offenderCount = ruleResults.reduce((n, r) => n + r.offenders.length, 0);
  const failedRules = ruleResults.filter((r) => r.offenders.length > 0);
  const ok = selfOk && offenderCount === 0;

  if (json) {
    console.log(
      JSON.stringify(
        {
          check: "sterility",
          ok,
          root,
          trackedFiles: files.length,
          rulesChecked: RULES.length,
          offenderCount,
          selfCheck: self,
          rules: ruleResults,
        },
        null,
        2,
      ),
    );
    process.exit(ok ? 0 : 1);
  }

  console.log(`nightshift sterility check — ${files.length} tracked files in ${root}`);
  for (const r of self) {
    if (!r.ok) {
      console.error(`  rule ${r.rule} self-check FAILED: ${r.problems.join("; ")}`);
    }
  }
  for (const r of ruleResults) {
    if (r.offenders.length === 0) {
      console.log(`  rule ${r.rule} — ${r.name}: ok`);
      continue;
    }
    console.log(`  rule ${r.rule} — ${r.name}: ${r.offenders.length} offender(s)`);
    for (const o of r.offenders) console.log(`      ${o.path}: ${o.detail}`);
  }

  if (ok) {
    console.log(`PASS: 0 offenders across ${RULES.length} rules (${files.length} tracked files).`);
    process.exit(0);
  }
  const selfNote = selfOk ? "" : ` and ${self.filter((r) => !r.ok).length} rule self-check(s)`;
  console.log(
    `FAIL: ${offenderCount} offender(s) across ${failedRules.length} rule(s)${selfNote}. ` +
      "Remove the offending files or content; do not weaken the rule.",
  );
  process.exit(1);
};

main();
