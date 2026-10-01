/**
 * `nightshift org github` and `nightshift org providers` (P10, D-P10-02,
 * D-P10-23), through the real CLI against the real handler: the customer's
 * only door for an installation and a provider key.
 */
import { runCli } from "@nightshift/cli";
import type { GitHubAppClient } from "@nightshift/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Operator, signIn } from "./operator.js";

const github: GitHubAppClient = {
  app: async () => ({
    slug: "nightshift-publisher",
    installUrl: "https://github.com/apps/nightshift-publisher/installations/new",
  }),
  installation: async (id) =>
    id === 166952409
      ? { account: "wildorder", repositories: ["wildorder/nightshift", "wildorder/fixture"] }
      : undefined,
};

let op: Operator;

afterEach(async () => {
  await op.cleanup();
});

const cli = async (...argv: string[]): Promise<number> => {
  op.out.length = 0;
  op.err.length = 0;
  return runCli(op.environment, argv);
};

describe("nightshift org github", () => {
  beforeEach(async () => {
    op = await signIn({ github });
  });

  it("prints where to install, records the installation GitHub confirms, and shows it", async () => {
    expect(await cli("org", "github", "status", "--org", op.orgId)).toBe(1);
    expect(op.out.join("\n")).toContain("No GitHub installation is recorded");

    expect(await cli("org", "github", "install", "--org", op.orgId)).toBe(0);
    expect(op.out.join("\n")).toContain(
      "https://github.com/apps/nightshift-publisher/installations/new",
    );

    expect(await cli("org", "github", "install", "--installation", "42", "--org", op.orgId)).toBe(
      1,
    );
    expect(op.err.join("\n")).toContain("installation 42");

    expect(
      await cli("org", "github", "install", "--installation", "166952409", "--org", op.orgId),
    ).toBe(0);
    expect(op.out.join("\n")).toContain("wildorder/fixture");

    expect(await cli("org", "github", "status", "--org", op.orgId)).toBe(0);
    expect(op.out.join("\n")).toContain("Installation 166952409 on wildorder");
  });
});

describe("nightshift org providers", () => {
  beforeEach(async () => {
    op = await signIn({ pastes: ["sk-ant-pasted-secret-key-1234", "sk-proj-another-secret-5678"] });
  });

  it("takes a key from the prompt, never prints it, and reports presence and last four", async () => {
    expect(await cli("org", "providers", "status", "--org", op.orgId)).toBe(1);
    expect(op.out.join("\n")).toContain("anthropic: not set");

    expect(await cli("org", "providers", "set", "anthropic", "--org", op.orgId)).toBe(0);
    expect(op.out.join("\n")).toContain("ending …1234");
    expect([...op.out, ...op.err].join("\n")).not.toContain("pasted-secret");

    expect(await cli("org", "providers", "set", "openai", "--org", op.orgId)).toBe(0);
    expect(await cli("org", "providers", "status", "--org", op.orgId)).toBe(0);
    expect(op.out.join("\n")).toContain("anthropic: set, ending …1234");
    expect(op.out.join("\n")).toContain("openai: set, ending …5678");
    expect([...op.out, ...op.err].join("\n")).not.toContain("another-secret");
  });

  it("refuses a provider it does not know, and a key given as an argument", async () => {
    expect(await cli("org", "providers", "set", "google", "--org", op.orgId)).toBe(2);
    expect(await cli("org", "providers", "set", "anthropic", "sk-literal", "--org", op.orgId)).toBe(
      0,
    );
    // The extra positional is ignored, never used as the key: the key came from the prompt.
    expect(op.out.join("\n")).toContain("ending …1234");
  });
});
