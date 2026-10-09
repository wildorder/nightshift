import {
  type ArtifactId,
  type CommitSha,
  DispatchInputSchema,
  ReferenceAuditSchema,
} from "@nightshift/contracts";
import { describe, expect, it } from "vitest";
import type { AuditedGate, GateAudit } from "./gate-audit.js";
import { referenceAuditOf, referenceGatesOf } from "./reference-audit.js";

const BASE = "b".repeat(40) as CommitSha;
const ART = "art_01M4AAAAAAAAAAAAAAAAAAAAAA" as ArtifactId;

const gate = (id: string, kind: AuditedGate["kind"], verdict: AuditedGate["verdict"]) =>
  ({ id, command: "true", kind, verdict, waitingOn: [] }) as AuditedGate;

const audit: Pick<GateAudit, "base" | "gates"> = {
  base: BASE,
  gates: [
    gate("setup:install", "setup", "passed"),
    gate("build", "check", "passed"),
    gate("test", "check", "failed"),
    gate("e2e", "check", "waiting"),
    gate("deploy-check", "check", "deferred"),
  ],
};

describe("the reference audit a dispatch carries (P16 D-06)", () => {
  it("keeps every gate's verdict, and the output artifact of each gate that ran, passed ones included", () => {
    const outputs = new Map([
      ["setup:install", ART],
      ["test", ART],
      ["build", ART],
      ["deploy-check", ART],
      // A gate that did not run has no output; one handed over anyway is not carried.
      ["e2e", ART],
    ]);
    const gates = referenceGatesOf(audit, outputs);
    expect(gates).toEqual([
      { id: "setup:install", kind: "setup", verdict: "passed", outputArtifactId: ART },
      { id: "build", kind: "check", verdict: "passed", outputArtifactId: ART },
      { id: "test", kind: "check", verdict: "failed", outputArtifactId: ART },
      { id: "e2e", kind: "check", verdict: "waiting" },
      { id: "deploy-check", kind: "check", verdict: "deferred", outputArtifactId: ART },
    ]);
    expect(
      ReferenceAuditSchema.safeParse({ base: BASE, auditedAt: "2026-10-09T12:00:00.000Z", gates })
        .success,
    ).toBe(true);
  });

  it("still refuses an output artifact on a gate that did not run, and accepts an older reference", () => {
    const at = "2026-10-09T12:00:00.000Z";
    expect(
      ReferenceAuditSchema.safeParse({
        base: BASE,
        auditedAt: at,
        gates: [{ id: "e2e", kind: "check", verdict: "waiting", outputArtifactId: ART }],
      }).success,
    ).toBe(false);
    // Before P16 D-07 only a failed gate carried one: that reference still parses.
    expect(
      ReferenceAuditSchema.safeParse({
        base: BASE,
        auditedAt: at,
        gates: [
          { id: "build", kind: "check", verdict: "passed" },
          { id: "test", kind: "check", verdict: "failed", outputArtifactId: ART },
        ],
      }).success,
    ).toBe(true);
  });

  it("is what the dispatch input accepts, at the base dispatched", () => {
    const reference = referenceAuditOf({
      audit,
      node: "22.22.0",
      auditedAt: "2026-10-09T12:00:00.000Z",
      outputs: new Map([["test", ART]]),
    });
    expect(reference.node).toBe("22.22.0");
    const input = {
      repositoryUrl: "https://github.com/acme/keki.git",
      branch: "nightshift/run",
      baseSha: BASE,
      planHash: "sha256:plan",
      reference,
    };
    expect(DispatchInputSchema.parse(input).reference).toEqual(reference);
  });

  it("leaves node out when the laptop had none", () => {
    const reference = referenceAuditOf({ audit, auditedAt: "2026-10-09T12:00:00.000Z" });
    expect("node" in reference).toBe(false);
    expect(reference.gates.every((entry) => entry.outputArtifactId === undefined)).toBe(true);
  });
});
