import type { GateFinding, PlannedDecision, Strand } from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import { createFixtures, makeGateHealth, makeProgramContract } from "../testing/index.js";
import { GATE_LOCKFILES, gateFingerprint, gateFingerprintAt } from "./gate-fingerprint.js";
import { GATE_HEALTH_STRAND, gateHealthReasons } from "./gate-health.js";

const f = createFixtures();
const FINGERPRINT = "0".repeat(64);

const strand = (id: string, dependsOn: string[] = []): Strand => ({
  id,
  name: `Strand ${id}`,
  scope: { summary: id, includes: [`src/${id}/**`], excludes: [] },
  acceptance: ["green"],
  successCriteria: [],
  dependsOn,
  prerequisites: [],
});

const decision = (id: string, answer?: string): PlannedDecision => ({
  id,
  question: `${id}?`,
  options: ["fix it", "leave it"],
  ...(answer === undefined ? {} : { answer }),
  touches: "all",
});

const finding = (id: string, decisionId: string): GateFinding => ({
  id,
  rule: 3,
  found: "two gates share dist/",
  decisionId,
  paths: ["package.json"],
});

const repairing = (...findings: GateFinding[]) =>
  makeGateHealth(f, { verdict: "repairing", findings, fingerprint: FINGERPRINT });

const kinds = (reasons: readonly { readonly kind: string }[]): string[] =>
  reasons.map((reason) => reason.kind);

describe("gateHealthReasons (D-P15-08)", () => {
  const contract = makeProgramContract(f, { strands: [strand("S-01"), strand("S-02")] });

  it("asks for an audit when the project has no record, naming the command", () => {
    const reasons = gateHealthReasons(contract, undefined, FINGERPRINT, "p1-demo");
    expect(kinds(reasons)).toEqual(["gate_health_unrecorded"]);
    expect(reasons[0]?.message).toContain("`nightshift gates p1-demo --record`");
  });

  it("is ready on a healthy record whose fingerprint matches", () => {
    expect(gateHealthReasons(contract, makeGateHealth(f), FINGERPRINT)).toEqual([]);
  });

  it("is stale when the fingerprint no longer matches, healthy or repairing, naming the audited commit", () => {
    const healthy = makeGateHealth(f);
    for (const record of [healthy, repairing(finding("F-01", "D-01"))]) {
      const reasons = gateHealthReasons(contract, record, "1".repeat(64), "p1-demo");
      expect(kinds(reasons)).toEqual(["gate_health_stale"]);
      expect(reasons[0]?.message).toContain(record.commit.slice(0, 8));
      expect(reasons[0]?.message).toContain("nightshift gates p1-demo --record");
    }
  });

  it("is ready on a matching repairing record whose findings are answered, with S-00 first", () => {
    const planned = makeProgramContract(f, {
      decisions: [decision("D-01", "fix it"), decision("D-02", "leave it")],
      strands: [
        strand(GATE_HEALTH_STRAND),
        strand("S-01", [GATE_HEALTH_STRAND]),
        strand("S-02", ["S-01", GATE_HEALTH_STRAND]),
      ],
    });
    const record = repairing(finding("F-01", "D-01"), finding("F-02", "D-02"));
    expect(gateHealthReasons(planned, record, FINGERPRINT)).toEqual([]);
  });

  it("says every gap of a repairing record at once", () => {
    const planned = makeProgramContract(f, {
      decisions: [decision("D-01")],
      strands: [strand("S-01"), strand("S-02", ["S-01"])],
    });
    const record = repairing(finding("F-01", "D-01"), finding("F-02", "D-09"));
    const reasons = gateHealthReasons(planned, record, FINGERPRINT);
    expect(kinds(reasons)).toEqual([
      "gate_finding_unanswered",
      "gate_finding_unanswered",
      "gate_health_strand_missing",
      "gate_health_strand_not_first",
      "gate_health_strand_not_first",
    ]);
    expect(reasons[0]?.message).toContain("D-01, which has no answer");
    expect(reasons[1]?.message).toContain("D-09, which is not a decision of this contract");
    expect(reasons[3]?.message).toContain("S-01 does not depend on S-00");
  });

  it("asks only for the strand that does not wait on S-00", () => {
    const planned = makeProgramContract(f, {
      decisions: [decision("D-01", "fix it")],
      strands: [strand(GATE_HEALTH_STRAND), strand("S-01", [GATE_HEALTH_STRAND]), strand("S-02")],
    });
    const reasons = gateHealthReasons(planned, repairing(finding("F-01", "D-01")), FINGERPRINT);
    expect(reasons).toEqual([
      expect.objectContaining({ kind: "gate_health_strand_not_first", strandId: "S-02" }),
    ]);
  });
});

describe("gateFingerprintAt", () => {
  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
  const steps = { setup: [], verification: [{ id: "test", command: "npm test" }] };

  it("reads each machinery path, absent ones as absent, and every lockfile present", async () => {
    const tree: Record<string, string> = {
      "package.json": "{}",
      "package-lock.json": "lock",
      "uv.lock": "uv",
    };
    const asked: string[] = [];
    const read = async (path: string) => {
      asked.push(path);
      return tree[path] === undefined ? undefined : utf8(tree[path]);
    };
    const at = await gateFingerprintAt(
      { ...steps, machinery: ["package.json", "scripts/gone.mjs"] },
      read,
      hex,
    );
    expect(asked).toEqual(["package.json", "scripts/gone.mjs", ...GATE_LOCKFILES]);
    expect(at).toBe(
      gateFingerprint(
        {
          ...steps,
          files: [
            { path: "package.json", bytes: utf8("{}") },
            { path: "scripts/gone.mjs", bytes: undefined },
            { path: "package-lock.json", bytes: utf8("lock") },
            { path: "uv.lock", bytes: utf8("uv") },
          ],
        },
        hex,
      ),
    );
  });

  it("reads a lockfile named as machinery once", async () => {
    const asked: string[] = [];
    await gateFingerprintAt(
      { ...steps, machinery: ["package-lock.json"] },
      async (path) => {
        asked.push(path);
        return undefined;
      },
      hex,
    );
    expect(asked.filter((path) => path === "package-lock.json")).toHaveLength(1);
  });
});
