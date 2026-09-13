import { describe, expect, it } from "vitest";
import { IllegalTransitionError, VerificationEvidenceError } from "../errors.js";
import {
  createFixturePair,
  FIXTURE_COMMIT,
  FIXTURE_TIMESTAMP,
  makeFailedVerification,
  makeNode,
  makeRootNode,
  makeVerification,
} from "../testing/factories.js";
import { transition } from "./transitions.js";
import {
  explainEvidenceMismatch,
  isValidEvidence,
  isVerificationStale,
  markImplemented,
  markVerificationFailed,
  markVerified,
} from "./verification.js";

const [f, other] = createFixturePair();
const root = makeRootNode(f);
const jobContractId = f.ids.next("job");

/** A node sitting in `verifying` with a commit, which is where verification applies. */
const verifyingNode = () =>
  makeNode(f, root.executionNodeId, {
    kind: "job",
    status: "verifying",
    jobContractId,
    commitSha: FIXTURE_COMMIT,
  });

describe("markVerified", () => {
  it("moves a verifying node to verified on passing evidence", () => {
    const node = verifyingNode();
    const verification = makeVerification(f, node, { jobContractId });
    const result = markVerified(node, verification, FIXTURE_TIMESTAMP);
    expect(result.status).toBe("verified");
    expect(isValidEvidence(node, verification)).toBe(true);
  });

  // SC-P1-14 — evidence must match the work in every particular.
  it("refuses a failed verification", () => {
    const node = verifyingNode();
    const failed = makeFailedVerification(f, node, { jobContractId });
    expect(() => markVerified(node, failed, FIXTURE_TIMESTAMP)).toThrow(VerificationEvidenceError);
    expect(explainEvidenceMismatch(node, failed).join(" ")).toContain('outcome is "failed"');
  });

  it("refuses evidence for a different node", () => {
    const node = verifyingNode();
    const elsewhere = verifyingNode();
    const verification = makeVerification(f, elsewhere, { jobContractId });
    expect(() => markVerified(node, verification, FIXTURE_TIMESTAMP)).toThrow(
      VerificationEvidenceError,
    );
  });

  it("refuses evidence for a different job contract", () => {
    const node = verifyingNode();
    const verification = makeVerification(f, node, { jobContractId: f.ids.next("job") });
    expect(explainEvidenceMismatch(node, verification).join(" ")).toContain("targets job");
    expect(() => markVerified(node, verification, FIXTURE_TIMESTAMP)).toThrow(
      VerificationEvidenceError,
    );
  });

  it("refuses evidence for a different commit", () => {
    const node = verifyingNode();
    const verification = makeVerification(f, node, {
      jobContractId,
      commitSha: "2222222222222222222222222222222222222222",
    });
    expect(explainEvidenceMismatch(node, verification).join(" ")).toContain("covers commit");
    expect(() => markVerified(node, verification, FIXTURE_TIMESTAMP)).toThrow(
      VerificationEvidenceError,
    );
  });

  it("refuses evidence from another ownership chain", () => {
    const node = verifyingNode();
    const foreign = makeVerification(other, node, {
      executionNodeId: node.executionNodeId,
      jobContractId: other.ids.next("job"),
      commitSha: FIXTURE_COMMIT,
    });
    expect(explainEvidenceMismatch(node, foreign).join(" ")).toContain("ownership chain");
    expect(() => markVerified(node, foreign, FIXTURE_TIMESTAMP)).toThrow(VerificationEvidenceError);
  });

  it("refuses a node with no commit", () => {
    const node = makeNode(f, root.executionNodeId, {
      status: "verifying",
      jobContractId,
      commitSha: null,
    });
    const verification = makeVerification(f, node, { jobContractId });
    expect(explainEvidenceMismatch(node, verification).join(" ")).toContain("no commit");
  });

  it("refuses a node with no job contract", () => {
    const node = makeNode(f, root.executionNodeId, {
      status: "verifying",
      jobContractId: null,
      commitSha: FIXTURE_COMMIT,
    });
    const verification = makeVerification(f, node);
    expect(explainEvidenceMismatch(node, verification).join(" ")).toContain("no job contract");
  });

  // A-05: being in the right state is not enough, and neither is having evidence alone.
  it("refuses to verify a node that is not in verifying", () => {
    const node = makeNode(f, root.executionNodeId, {
      status: "implemented",
      jobContractId,
      commitSha: FIXTURE_COMMIT,
    });
    const verification = makeVerification(f, node, { jobContractId });
    expect(isValidEvidence(node, verification)).toBe(true);
    expect(() => markVerified(node, verification, FIXTURE_TIMESTAMP)).toThrow(
      IllegalTransitionError,
    );
  });

  it("reports every mismatch at once", () => {
    const node = verifyingNode();
    const bad = makeFailedVerification(f, node, {
      executionNodeId: verifyingNode().executionNodeId,
      jobContractId: f.ids.next("job"),
      commitSha: "3333333333333333333333333333333333333333",
    });
    expect(explainEvidenceMismatch(node, bad).length).toBeGreaterThanOrEqual(4);
  });
});

describe("markVerificationFailed", () => {
  it("records a failure without verifying", () => {
    const node = verifyingNode();
    const failed = makeFailedVerification(f, node, { jobContractId });
    const result = markVerificationFailed(node, failed, FIXTURE_TIMESTAMP);
    expect(result.status).toBe("verification_failed");
  });

  it("refuses to record a failure from a passing verification", () => {
    const node = verifyingNode();
    const passing = makeVerification(f, node, { jobContractId });
    expect(() => markVerificationFailed(node, passing, FIXTURE_TIMESTAMP)).toThrow(
      VerificationEvidenceError,
    );
  });
});

describe("markImplemented", () => {
  it("is the furthest a worker can move a node, and records its commit", () => {
    const running = makeNode(f, root.executionNodeId, { status: "running", jobContractId });
    const result = markImplemented(running, FIXTURE_COMMIT, FIXTURE_TIMESTAMP);
    expect(result.status).toBe("implemented");
    expect(result.commitSha).toBe(FIXTURE_COMMIT);
  });

  it("cannot be used to skip verification", () => {
    const running = makeNode(f, root.executionNodeId, { status: "running", jobContractId });
    const implemented = markImplemented(running, FIXTURE_COMMIT, FIXTURE_TIMESTAMP);
    expect(() => transition(implemented, "seal", FIXTURE_TIMESTAMP)).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("isVerificationStale", () => {
  it("is false when node, verification and head agree", () => {
    const node = verifyingNode();
    const verification = makeVerification(f, node, { jobContractId });
    expect(isVerificationStale(node, verification, FIXTURE_COMMIT)).toBe(false);
  });

  it("is true once the branch has moved on", () => {
    const node = verifyingNode();
    const verification = makeVerification(f, node, { jobContractId });
    const newHead = "4444444444444444444444444444444444444444";
    expect(isVerificationStale(node, verification, newHead)).toBe(true);
  });
});
