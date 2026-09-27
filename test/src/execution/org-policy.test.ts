/**
 * The org's policy is configuration, not code (P8, D-P8-02, D-P8-03,
 * SC-P8-14): one fixture, started once under the seeded default and once after
 * the org's configuration changes, takes two different paths. The configuration
 * goes through the production handler, `startRun` records the effective policy
 * on the run, and the app's own `routeJob` and `core`'s examination requirement read
 * it back, as a real run does.
 */
import {
  DEFAULT_EXAMINATION_POLICY,
  DEFAULT_ROUTING_POLICY,
  type JobContract,
  JobContractSchema,
  type OrgId,
} from "@nightshift/contracts";
import { examinationRequirementFor, nowIso } from "@nightshift/core";
import { startRun } from "@nightshift/execution";
import { routeJob } from "@nightshift/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorlds, createBaseWorld } from "./world.js";

afterEach(cleanupWorlds);

const BOTH_PROVIDERS = {
  modelPolicy: {
    allowedProviders: ["anthropic", "openai"],
    allowedModels: [],
    forbiddenModels: [],
  },
};

describe("the same fixture under two org configurations (SC-P8-14)", () => {
  it("routes and examines the same job differently, with no code change", async () => {
    const world = await createBaseWorld({ program: BOTH_PROVIDERS });
    const { stores, clock, ids, program, repo } = world;
    const project = await stores.projects.get(program.projectId);
    const orgId = project?.orgId as OrgId;

    const job: JobContract = JobContractSchema.parse({
      schemaVersion: 1,
      projectId: program.projectId,
      programId: program.programId,
      runId: ids.next("run"),
      jobContractId: ids.next("job"),
      objective: "Add the helper",
      scope: { includes: ["src/**"] },
      acceptance: ["node --test passes"],
      dependencies: [],
      risk: "low",
      ambiguity: "low",
      testability: "strong",
      kind: "implement",
      createdAt: nowIso(clock),
    });

    const started = async () => {
      const { run } = await startRun(
        { stores, clock, ids, git: world.git },
        { program, repoPath: repo },
      );
      return {
        route: routeJob(run, program, job),
        examined: run.policy && examinationRequirementFor(run.policy.examinationPolicy, job.risk),
        version: run.policy?.orgConfigVersion,
      };
    };

    // Nobody has written the org's configuration: the seeded default.
    const before = await started();
    expect(before).toMatchObject({
      version: 0,
      route: { ruleId: "R-bounded", ladder: "claude", rung: { tier: "cheap" } },
      examined: { required: false },
    });

    // The owner edits the configuration: bounded work starts on Codex's
    // workhorse rung, and low-risk work is examined and blocks.
    await stores.orgConfigs.put({
      schemaVersion: 1,
      orgId,
      version: 1,
      updatedAt: nowIso(clock),
      routingPolicy: {
        ...DEFAULT_ROUTING_POLICY,
        rules: [{ id: "R-codex", when: {}, start: { ladder: "codex", tier: "standard" } }],
      },
      examinationPolicy: {
        ...DEFAULT_EXAMINATION_POLICY,
        low: { ...DEFAULT_EXAMINATION_POLICY.high },
      },
    });

    const after = await started();
    expect(after).toMatchObject({
      version: 1,
      route: {
        ruleId: "R-codex",
        ladder: "codex",
        rung: { tier: "standard" },
        target: { model: "gpt-6-sol" },
      },
      examined: { required: true, blockOnMaterialFindings: true },
    });
  });
});
