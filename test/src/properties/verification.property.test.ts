/**
 * SC-P1-13 — completed does not imply verified.
 * SC-P1-14 — verified requires verification evidence.
 * SC-P1-15 — legality depends only on (status, event).
 */
import type { ExecutionNode } from "@nightshift/contracts";
import {
  createCountingIdGenerator,
  createFixtures,
  EXECUTION_NODE_STATUSES,
  FIXTURE_COMMIT,
  FIXTURE_TIMESTAMP,
  IllegalTransitionError,
  isValidEvidence,
  makeFailedVerification,
  makeNode,
  makeRootNode,
  makeVerification,
  markVerified,
  nextStatus,
  TRANSITION_EVENTS,
  transition,
  VerificationEvidenceError,
} from "@nightshift/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { executionNodeStatus, transitionEvent, transitionSequence } from "../arbitraries.js";

const OTHER_COMMIT = "2222222222222222222222222222222222222222";

describe("SC-P1-13: completed does not imply verified", () => {
  it("never reaches sealed or integrated without passing through verified", () => {
    fc.assert(
      fc.property(transitionSequence(24), (events) => {
        const fixtures = createFixtures(createCountingIdGenerator());
        let node: ExecutionNode = makeRootNode(fixtures, { status: "validated" });
        let sawVerified = false;

        for (const event of events) {
          try {
            node = transition(node, event, FIXTURE_TIMESTAMP);
          } catch (error) {
            // Illegal events are simply ignored; the walk continues from where it was.
            expect(error).toBeInstanceOf(IllegalTransitionError);
            continue;
          }
          if (node.status === "verified") sawVerified = true;
        }

        if (node.status === "sealed" || node.status === "integrated") {
          expect(
            sawVerified,
            `reached ${node.status} without ever being verified via [${events.join(", ")}]`,
          ).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("generates sequences that do reach integrated, so the property is not vacuous", () => {
    // The happy path, spelled out: if this ever stops reaching integrated, the
    // property above would pass for the wrong reason.
    const fixtures = createFixtures(createCountingIdGenerator());
    let node: ExecutionNode = makeRootNode(fixtures, { status: "validated" });
    for (const event of [
      "enqueue",
      "start",
      "report_implemented",
      "begin_verification",
      "verification_passed",
      "seal",
      "integrate",
    ] as const) {
      node = transition(node, event, FIXTURE_TIMESTAMP);
    }
    expect(node.status).toBe("integrated");
  });

  it("cannot leave a terminal status by any event", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("integrated", "cancelled" as const),
        transitionEvent(),
        (status, event) => {
          const fixtures = createFixtures(createCountingIdGenerator());
          const node = makeRootNode(fixtures, { status });
          expect(() => transition(node, event, FIXTURE_TIMESTAMP)).toThrow(IllegalTransitionError);
        },
      ),
    );
  });
});

describe("SC-P1-15: legality depends only on status and event", () => {
  it("ignores every other field of the node", () => {
    fc.assert(
      fc.property(
        executionNodeStatus(),
        transitionEvent(),
        fc.constantFrom("program", "sub-program", "job" as const),
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        (status, event, kind, depth, withCommit) => {
          const fixtures = createFixtures(createCountingIdGenerator());
          const node = makeRootNode(fixtures, {
            status,
            kind,
            depth,
            commitSha: withCommit ? FIXTURE_COMMIT : null,
          });

          const expected = nextStatus(status, event);
          if (expected === undefined) {
            expect(() => transition(node, event, FIXTURE_TIMESTAMP)).toThrow(
              IllegalTransitionError,
            );
          } else {
            expect(transition(node, event, FIXTURE_TIMESTAMP).status).toBe(expected);
          }
        },
      ),
    );
  });

  it("covers the whole table between the status and event generators", () => {
    // Both generators must be exhaustive for the property above to mean anything.
    // 15 since P5: `succeeded`, which no event reaches (D-P5-06). The events are
    // the 15 P1 shipped with.
    expect(EXECUTION_NODE_STATUSES.length).toBe(15);
    expect(TRANSITION_EVENTS.length).toBe(15);
  });
});

describe("SC-P1-14: verified requires verification evidence", () => {
  /** A node in `verifying` with a commit and a job contract — where evidence applies. */
  const verifyingNode = () => {
    const fixtures = createFixtures(createCountingIdGenerator());
    const root = makeRootNode(fixtures);
    const jobContractId = fixtures.ids.next("job");
    const node = makeNode(fixtures, root.executionNodeId, {
      kind: "job",
      status: "verifying",
      jobContractId,
      commitSha: FIXTURE_COMMIT,
    });
    return { fixtures, node, jobContractId };
  };

  it("accepts evidence that matches the node in every particular", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const { fixtures, node, jobContractId } = verifyingNode();
        const verification = makeVerification(fixtures, node, { jobContractId });
        expect(isValidEvidence(node, verification)).toBe(true);
        expect(markVerified(node, verification, FIXTURE_TIMESTAMP).status).toBe("verified");
      }),
      { numRuns: 1 },
    );
  });

  it("refuses evidence mismatched in any single particular", () => {
    type Mutation = "outcome" | "node" | "job" | "commit" | "project";
    fc.assert(
      fc.property(
        fc.constantFrom<Mutation>("outcome", "node", "job", "commit", "project"),
        (mutation) => {
          const { fixtures, node, jobContractId } = verifyingNode();

          const verification = (() => {
            switch (mutation) {
              case "outcome":
                return makeFailedVerification(fixtures, node, { jobContractId });
              case "node":
                return makeVerification(fixtures, node, {
                  jobContractId,
                  executionNodeId: fixtures.ids.next("node"),
                });
              case "job":
                return makeVerification(fixtures, node, {
                  jobContractId: fixtures.ids.next("job"),
                });
              case "commit":
                return makeVerification(fixtures, node, {
                  jobContractId,
                  commitSha: OTHER_COMMIT,
                });
              case "project":
                return makeVerification(fixtures, node, {
                  jobContractId,
                  projectId: `proj_${"Z".repeat(26)}`,
                });
            }
          })();

          expect(isValidEvidence(node, verification), `mutation ${mutation} was accepted`).toBe(
            false,
          );
          expect(() => markVerified(node, verification, FIXTURE_TIMESTAMP)).toThrow(
            VerificationEvidenceError,
          );
        },
      ),
    );
  });

  it("refuses to verify from any status other than verifying, even with good evidence", () => {
    fc.assert(
      fc.property(executionNodeStatus(), (status) => {
        fc.pre(status !== "verifying");
        const fixtures = createFixtures(createCountingIdGenerator());
        const root = makeRootNode(fixtures);
        const jobContractId = fixtures.ids.next("job");
        const node = makeNode(fixtures, root.executionNodeId, {
          kind: "job",
          status,
          jobContractId,
          commitSha: FIXTURE_COMMIT,
        });
        const verification = makeVerification(fixtures, node, { jobContractId });

        expect(isValidEvidence(node, verification)).toBe(true);
        expect(() => markVerified(node, verification, FIXTURE_TIMESTAMP)).toThrow(
          IllegalTransitionError,
        );
      }),
    );
  });
});
