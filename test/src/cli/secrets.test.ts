/**
 * `nightshift secret` (A-62), through the real CLI against the real handler: a
 * project's secrets go in from a prompt, are listed by name and last four, and
 * come out again, and no value is ever printed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, runCli } from "@nightshift/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, signIn } from "./operator.js";

let op: Operator;
let repo: string;
let projectId: string;

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(op.environment, [...argv, "--repo", repo]);
};

beforeEach(async () => {
  op = await signIn({ pastes: ["ghp_pasted_secret_value_1234"] });
  ({ projectId } = await createProject(op.environment, { name: "secrets" }));
  repo = await mkdtemp(join(tmpdir(), "nightshift-secrets-"));
  await writeFile(
    join(repo, "nightshift.config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      projectId,
      contextDocs: [],
      verification: [{ id: "test", command: "npm test" }],
      modelPolicy: { allowedProviders: ["anthropic"], allowedModels: [], forbiddenModels: [] },
      delegationLimits: { maxDepth: 2, maxConcurrency: 2 },
      costPolicy: {},
      secrets: ["NPM_TOKEN"],
    })}\n`,
  );
});

afterEach(async () => {
  await op.cleanup();
  await rm(repo, { recursive: true, force: true });
});

describe("nightshift secret (A-62)", () => {
  it("says a declared secret is missing, takes it from the prompt, lists it, and removes it", async () => {
    expect(await cli("secret", "list")).toBe(1);
    expect(op.out.join("\n")).toContain("NPM_TOKEN: NOT SET (declared)");

    expect(await cli("secret", "set", "NPM_TOKEN")).toBe(0);
    expect(op.out.join("\n")).toContain(`NPM_TOKEN is set for ${projectId}, ending …1234`);
    expect([...op.out, ...op.err].join("\n")).not.toContain("pasted_secret");

    expect(await cli("secret", "list")).toBe(0);
    expect(op.out.join("\n")).toContain("NPM_TOKEN: set, ending …1234");
    expect([...op.out, ...op.err].join("\n")).not.toContain("pasted_secret");

    expect(await cli("secret", "rm", "NPM_TOKEN")).toBe(0);
    expect(await cli("secret", "list")).toBe(1);
  });

  it("refuses a name a secret cannot have", async () => {
    expect(await cli("secret", "set", "PATH")).toBe(2);
    expect(op.err.join("\n")).toContain("cannot be a secret's name");
  });
});
