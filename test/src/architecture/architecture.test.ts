/**
 * Layer 1 of the architecture suite: every rule applied to the real tracked
 * tree. Expect zero violations.
 *
 * Layer 2 lives in `negative-fixtures.test.ts` and proves each rule still
 * detects a violation. Both layers are required: this file alone would pass
 * forever if a rule stopped looking at anything.
 */
import { describe, expect, it } from "vitest";
import { ARCHITECTURE_RULES, formatViolations, loadRepo } from "./rules.js";

const repo = loadRepo();

describe("architecture rules hold on the tracked tree", () => {
  it("snapshots a non-empty repository", () => {
    // Guards the loader itself: a broken `git ls-files` would otherwise make
    // every rule below pass against an empty file list.
    expect(repo.sources.length).toBeGreaterThan(5);
    expect(repo.manifests.length).toBeGreaterThan(5);
    expect(repo.tsconfigs.length).toBeGreaterThan(5);
  });

  for (const rule of ARCHITECTURE_RULES) {
    it(`${rule.id}: ${rule.name}`, () => {
      expect(formatViolations(rule.check(repo))).toEqual([]);
    });
  }
});
