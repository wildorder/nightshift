/**
 * `nightshift line status`: the report over a line view, and the refusal for a
 * project with no line configured.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LineView, NIGHTSHIFT_CONFIG_FILE } from "@nightshift/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestEnvironment, type TestEnvironment } from "../testing/harness.js";
import { describeLine, lineStatus, NO_LINE_CONFIGURED } from "./line.js";

const live: TestEnvironment[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
});

const PROJECT = "proj_00000000000000000000000001";
const ALPHA = "prog_00000000000000000000000001";
const BETA = "prog_00000000000000000000000002";
const sha = (c: string): string => c.repeat(40);
const AT = "2026-10-27T10:00:00.000Z";

const range = (program: string, upTo: string, from?: string) => ({
  program,
  ...(from === undefined ? {} : { from }),
  upTo,
});

const verification = (outcome = "passed") => ({
  verificationId: "ver_00000000000000000000000001",
  phase: "line",
  commitSha: sha("c"),
  baseSha: sha("b"),
  commands: [],
  outcome,
  startedAt: AT,
  endedAt: AT,
});

const view = (record: object = {}, rest: object = {}): LineView =>
  ({
    record: {
      schemaVersion: 1,
      projectId: PROJECT,
      branch: "nightshift/develop",
      repositoryUrl: "https://example.test/r.git",
      version: 1,
      queue: [],
      held: [],
      compositions: [],
      parked: [],
      updatedAt: AT,
      ...record,
    },
    programs: [
      { program: ALPHA, branch: "nightshift/alpha" },
      { program: BETA, branch: "nightshift/beta" },
    ],
    ...rest,
  }) as unknown as LineView;

const text = (lines: string[]): string => lines.join("\n");

describe("describeLine", () => {
  it("describes an empty line", () => {
    const out = text(describeLine(view({ head: sha("a") })));
    expect(out).toContain("line nightshift/develop  head aaaaaaa");
    expect(out).toContain("last push: none");
    expect(out).toContain("line owner: none started");
    expect(out).toContain("queue: empty");
    expect(out).toContain("compositions: none");
    expect(out).not.toContain("parked");
  });

  it("lists the queue with branch names and short shas", () => {
    const out = text(
      describeLine(
        view({
          queue: [
            { program: ALPHA, upTo: sha("d"), enqueuedAt: AT },
            { program: BETA, upTo: sha("e"), enqueuedAt: AT },
          ],
        }),
      ),
    );
    expect(out).toContain("queue: 2");
    expect(out).toContain(`nightshift/alpha up to ddddddd, enqueued ${AT}`);
    expect(out).toContain("nightshift/beta up to eeeeeee");
  });

  it("shows a composition with its resolver decision, ranges and push", () => {
    const out = text(
      describeLine(
        view(
          {
            compositions: [
              {
                compositionId: "comp-1",
                commit: sha("f"),
                parent: sha("a"),
                ranges: [range(ALPHA, sha("d")), range(BETA, sha("e"), sha("1"))],
                verification: verification(),
                resolver: { decision: "resolved", attempts: 2, detail: "kept both imports" },
                composedAt: AT,
                pushed: { at: AT },
              },
            ],
          },
          {
            runId: "run_01J0000000000000000000000A",
            dispatchStatus: "running",
            generation: 3,
            meteredUsd: 1.5,
          },
        ),
      ),
    );
    expect(out).toContain(
      "fffffff  nightshift/alpha base..ddddddd, nightshift/beta 1111111..eeeeeee",
    );
    expect(out).toContain("verification passed (ver_00000000000000000000000001)");
    expect(out).toContain("resolver resolved, 2 attempts: kept both imports");
    expect(out).toContain(`pushed ${AT}`);
    expect(out).toContain("line owner: running, generation 3, metered $1.50");
  });

  it("shows a parked composition with its ranges and reason", () => {
    const out = text(
      describeLine(
        view({
          parked: [
            {
              compositionId: "comp-2",
              ranges: [range(BETA, sha("e"), sha("1"))],
              reason: "verification failed after the resolver gave up",
              resolver: { decision: "gave_up", attempts: 3 },
              parkedAt: AT,
            },
          ],
        }),
      ),
    );
    expect(out).toContain("parked: 1");
    expect(out).toContain("nightshift/beta 1111111..eeeeeee");
    expect(out).toContain("reason: verification failed after the resolver gave up");
    expect(out).toContain("resolver gave_up, 3 attempts");
  });

  it("shows the cap reached and why the line is waiting", () => {
    const out = text(
      describeLine(
        view(
          { waiting: { reason: "monthly_cap", detail: "the $50.00 cap is reached", since: AT } },
          {
            usage: {
              month: "2026-10",
              meteredUsd: 50,
              capUsd: 50,
              reachedAt: AT,
            },
          },
        ),
      ),
    );
    expect(out).toContain("self-started spend 2026-10: $50.00 of $50.00 cap");
    expect(out).toContain(`(reached ${AT})`);
    expect(out).toContain("waiting (monthly_cap): the $50.00 cap is reached");
  });

  it("shows a push conflict with its detail", () => {
    const out = text(
      describeLine(
        view({
          head: sha("a"),
          push: {
            head: sha("f"),
            expectedPredecessor: sha("a"),
            bundleKey: "k",
            generation: 1,
            status: "conflict",
            requestedAt: AT,
            detail: "the line moved to 9999999",
          },
        }),
      ),
    );
    expect(out).toContain("last push: conflict fffffff (from aaaaaaa): the line moved to 9999999");
  });
});

describe("nightshift line status", () => {
  it("says the project has no line and exits 1", async () => {
    const created = await createTestEnvironment();
    live.push(created);
    await writeFile(
      join(created.environment.cwd, NIGHTSHIFT_CONFIG_FILE),
      JSON.stringify({
        schemaVersion: 1,
        projectId: PROJECT,
        contextDocs: [],
        verification: [{ id: "test", command: "npm test" }],
        modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
        delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
        costPolicy: {},
      }),
    );
    expect(await lineStatus(created.environment, {})).toBe(1);
    expect(created.out.join("\n")).toBe(NO_LINE_CONFIGURED);
    expect(NO_LINE_CONFIGURED).toContain("`line`");
  });
});
