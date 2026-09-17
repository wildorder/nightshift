import { readFile } from "node:fs/promises";
import { ID_PREFIXES } from "@nightshift/contracts";
import { credentialsPath } from "@nightshift/persistence/http";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, USAGE, VERSION } from "./cli.js";
import type { TestEnvironment } from "./testing/harness.js";
import {
  createFakeControlPlane,
  createFakeFetch,
  createTestEnvironment,
  signIn,
  TEST_API,
  TEST_AUTH_DOMAIN,
  TEST_EMAIL,
  TEST_SUBJECT,
} from "./testing/harness.js";

const live: TestEnvironment[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
});

const plane = () =>
  createFakeControlPlane({
    apiEndpoint: TEST_API,
    authDomain: TEST_AUTH_DOMAIN,
    claims: { sub: TEST_SUBJECT, email: TEST_EMAIL },
  });

describe("the command line", () => {
  it("prints usage and succeeds for --help", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, ["--help"])).toBe(0);
    expect(created.out.join("\n")).toBe(USAGE);
  });

  it("prints usage and fails when given nothing, because nothing was asked", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, [])).toBe(1);
  });

  it("prints the version", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, ["--version"])).toBe(0);
    expect(created.out).toEqual([VERSION]);
  });

  it("exits 2 for a usage failure and 1 for everything else", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, ["fly"])).toBe(2);
    expect(created.err.join("\n")).toContain("unknown command `fly`");
    // Not signed in is a real failure, not a typo.
    expect(await runCli(created.environment, ["whoami"])).toBe(1);
  });

  it("refuses an unknown flag rather than ignoring it", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, ["logout", "--force"])).toBe(2);
    expect(created.err.join("\n")).toContain("--force");
  });

  it("never prints a stack trace", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    await runCli(created.environment, ["whoami"]);

    // A stack frame, not the word: the advice legitimately says "no profile at
    // <path>", and a test that banned the substring would ban the sentence.
    expect(created.err.join("\n")).not.toMatch(/\n\s+at /);
    expect(created.err.join("\n")).not.toContain(".ts:");
  });
});

describe("nightshift id", () => {
  it("mints an identifier for every prefix the contracts define", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    for (const prefix of ID_PREFIXES) {
      expect(await runCli(created.environment, ["id", prefix])).toBe(0);
    }

    expect(created.out).toHaveLength(ID_PREFIXES.length);
    for (const [index, prefix] of ID_PREFIXES.entries()) {
      expect(created.out[index]).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
    }
  });

  it("names the known prefixes when given one that is not", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, ["id", "user"])).toBe(2);
    expect(created.err.join("\n")).toContain("prog");
  });

  it("needs a prefix", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, ["id"])).toBe(2);
  });
});

describe("nightshift project", () => {
  it("creates a project and prints its id", async () => {
    const created = await createTestEnvironment({ fetch: plane().fetch });
    live.push(created);
    await signIn(created.environment);

    expect(await runCli(created.environment, ["project", "create", "--name", "slice-demo"])).toBe(
      0,
    );
    expect(created.out[0]).toMatch(/^proj_/);
  });

  it("needs --name", async () => {
    const created = await createTestEnvironment({ fetch: plane().fetch });
    live.push(created);
    await signIn(created.environment);

    expect(await runCli(created.environment, ["project", "create"])).toBe(2);
    expect(created.err.join("\n")).toContain("--name is required");
  });

  it("refuses a subcommand it does not have", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, ["project", "delete"])).toBe(2);
    expect(created.err.join("\n")).toContain("project delete");
  });
});

describe("nightshift run --remote", () => {
  it("is accepted by the parser and refused by the command", async () => {
    const created = await createTestEnvironment({ fetch: plane().fetch });
    live.push(created);
    await signIn(created.environment);

    expect(await runCli(created.environment, ["run", "contract.json", "--remote"])).toBe(2);
    expect(created.err.join("\n")).toContain("remote execution arrives in P9");
  });

  it("needs a contract path", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    expect(await runCli(created.environment, ["run"])).toBe(2);
  });
});

describe("nightshift whoami and logout through the dispatcher", () => {
  it("reports the session", async () => {
    const created = await createTestEnvironment({ fetch: plane().fetch });
    live.push(created);
    await signIn(created.environment);

    expect(await runCli(created.environment, ["whoami"])).toBe(0);
    expect(created.out.join("\n")).toContain(TEST_SUBJECT);
  });

  it("honours --no-revoke, which parseArgs derives from the boolean option", async () => {
    const fake = createFakeFetch(() => ({ status: 200, body: "" }));
    const created = await createTestEnvironment({ fetch: fake.fetch });
    live.push(created);
    await signIn(created.environment);

    expect(await runCli(created.environment, ["logout", "--no-revoke"])).toBe(0);

    expect(fake.requests).toHaveLength(0);
    await expect(readFile(credentialsPath(created.environment.paths), "utf8")).rejects.toThrow();
  });
});
