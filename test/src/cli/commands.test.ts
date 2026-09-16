/**
 * The CLI against the real control plane (T7 deliverable 8).
 *
 * T7 asks for "each command's output against the local control plane", and
 * `apps/cli`'s own tests cannot do it: the layer table gives the CLI
 * `contracts`, `core`, `persistence` and `execution`, and `apps/api` is
 * deliberately not among them. So those tests drive an injected transport, and
 * say in `apps/cli/src/testing/harness.ts` exactly what that leaves unproven —
 * that the routes the CLI builds are the routes the API serves, and that a
 * domain rule fires.
 *
 * This file is where that is proven, because `test` already references both.
 * The production handler is on loopback over in-memory stores, and the CLI
 * reaches it through its **own** `openSession` — the real `profile.json`, the
 * real `credentials.json`, the real token provider, the real http adapter. A
 * route the CLI spells differently from the API is a 404 here, and a body the
 * API refuses is a refusal here.
 *
 * ## The one thing still stood in for
 *
 * Cognito's token endpoint. `openSession` mints an ID token from the stored
 * refresh token, and there is no offline Cognito; so the injected `fetch`
 * answers `https://<authDomain>/oauth2/token` with an unsigned JWT and passes
 * every other request to the real one. That is the same seam the local plane
 * already has — it ignores the `Authorization` header because API Gateway's
 * authorizer is what validates it (A-19) — and the smoke suite is where a real
 * token meets a real authorizer.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalControlPlane, startLocalControlPlane } from "@nightshift/api/testing";
import type { CliEnvironment } from "@nightshift/cli";
import { createProject, mintId, run, whoami } from "@nightshift/cli";
import type { OrgId } from "@nightshift/contracts";
import {
  createSteppingClock,
  createUlidIdGenerator,
  type IdGenerator,
  makeMembership,
  nowIso,
} from "@nightshift/core";
import { nodeGitRunner } from "@nightshift/execution";
import type { FetchLike } from "@nightshift/persistence/http";
import {
  createFetchTransport,
  createHttpStores,
  routes,
  send,
  staticTokenProvider,
  writeCredentials,
  writeProfile,
} from "@nightshift/persistence/http";
import { createInMemoryStores, type InMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MaterialisedRepo, materialiseFixtureRepo } from "../slice/fixture-repo.js";

const SUBJECT = "11111111-2222-3333-4444-555555555555";
const AUTH_DOMAIN = "nightshift-test.auth.us-west-2.amazoncognito.com";
const CLIENT_ID = "test-interactive-client";
const START_MS = Date.parse("2026-09-15T12:00:00.000Z");

/** A JWT with no signature: the CLI reads claims, the gateway verifies them. */
const idTokenFor = (claims: Record<string, unknown>): string => {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({
    exp: Math.floor(START_MS / 1000) + 3600,
    ...claims,
  })}.`;
};

interface Operator {
  readonly environment: CliEnvironment;
  readonly out: string[];
  readonly err: string[];
  readonly orgId: OrgId;
  readonly ids: IdGenerator;
  /** How many times the CLI went to the token endpoint. */
  tokenMints(): number;
  cleanup(): Promise<void>;
}

let plane: LocalControlPlane | undefined;
let operator: Operator | undefined;
let fixture: MaterialisedRepo | undefined;

/**
 * A signed-in operator: a real config directory holding a real profile and real
 * credentials, pointed at a real control plane.
 */
const signIn = async (): Promise<Operator> => {
  const ids = createUlidIdGenerator();
  const clock = createSteppingClock(START_MS, 1_000);
  const backing: InMemoryStores = createInMemoryStores({ deferSequencing: true });
  const orgId = ids.next("org") as OrgId;
  await backing.memberships.put(makeMembership(SUBJECT as never, orgId));

  plane = await startLocalControlPlane({
    stores: backing,
    claims: { sub: SUBJECT, "custom:active_org": orgId },
    clock,
  });

  const root = await mkdtemp(join(tmpdir(), "nightshift-cli-suite-"));
  const paths = {
    env: { NIGHTSHIFT_CONFIG_DIR: join(root, "config"), NIGHTSHIFT_STATE_DIR: join(root, "state") },
    platform: process.platform,
    home: root,
  };
  await writeProfile(
    { apiEndpoint: plane.url, authDomain: AUTH_DOMAIN, clientId: CLIENT_ID, stage: "test" },
    paths,
  );
  await writeCredentials(
    {
      refreshToken: "a-refresh-token-that-must-never-be-printed",
      subject: SUBJECT,
      clientId: CLIENT_ID,
      obtainedAt: nowIso(clock),
    },
    paths,
  );

  let mints = 0;
  const real = globalThis.fetch as unknown as FetchLike;
  const fetch: FetchLike = async (url, init) => {
    if (!url.startsWith(`https://${AUTH_DOMAIN}/`)) return real(url, init);
    // Cognito's token endpoint, and only it.
    mints += 1;
    const body = JSON.stringify({
      id_token: idTokenFor({ sub: SUBJECT, email: "operator@example.test" }),
      access_token: "unused",
      expires_in: 3600,
      token_type: "Bearer",
    });
    return { status: 200, text: async () => body };
  };

  const out: string[] = [];
  const err: string[] = [];
  const environment: CliEnvironment = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    cwd: root,
    paths,
    fetch,
    openBrowser: async () => false,
    clock,
    ids,
    git: nodeGitRunner,
    startLoopback: async () => {
      throw new Error("no command in this suite opens a loopback listener");
    },
  };

  return {
    environment,
    out,
    err,
    orgId,
    ids,
    tokenMints: () => mints,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};

beforeEach(async () => {
  operator = await signIn();
});

afterEach(async () => {
  await operator?.cleanup();
  await fixture?.remove();
  await plane?.close();
  operator = undefined;
  fixture = undefined;
  plane = undefined;
});

/** Narrows the module-level handles, so a test reads without `?.` everywhere. */
const here = (): { operator: Operator; plane: LocalControlPlane } => {
  if (operator === undefined || plane === undefined) throw new Error("no operator");
  return { operator, plane };
};

describe("nightshift whoami, against the real handler", () => {
  it("mints a token, resolves the acting org, and reports no projects yet", async () => {
    const { operator: op } = here();
    const result = await whoami(op.environment);

    expect(result.subject).toBe(SUBJECT);
    expect(result.email).toBe("operator@example.test");
    expect(result.org.ok).toBe(true);
    expect(result.org.projectCount).toBe(0);
    // Resolution succeeded and there is simply nothing to name it with.
    expect(result.org.orgId).toBeUndefined();
    expect(op.out.join("\n")).toContain("no projects yet");
    // Freshly minted, not read from a cache: that is half of what is asked.
    expect(op.tokenMints()).toBe(1);
  });

  it("names the org once the control plane owns a project of it", async () => {
    const { operator: op } = here();
    await createProject(op.environment, { name: "slice-demo" });
    op.out.length = 0;

    const result = await whoami(op.environment);
    expect(result.org.orgId).toBe(op.orgId);
    expect(result.org.projectCount).toBe(1);
  });

  it("prints a typed refusal verbatim when the token belongs to no organisation", async () => {
    // A second plane, whose subject has no membership at all. This is the state
    // an operator gets stuck in, and the exact refusal code is what they search
    // for — so the assertion is on the string, not on a paraphrase.
    await plane?.close();
    const stranger = "99999999-8888-7777-6666-555555555555";
    plane = await startLocalControlPlane({
      stores: createInMemoryStores({ deferSequencing: true }),
      claims: { sub: stranger },
    });
    const { operator: op } = here();
    await writeProfile(
      { apiEndpoint: plane.url, authDomain: AUTH_DOMAIN, clientId: CLIENT_ID, stage: "test" },
      op.environment.paths,
    );

    const result = await whoami(op.environment);
    expect(result.org.ok).toBe(false);
    expect(result.org.code).toBe("no_membership");
    expect(op.out.join("\n")).toContain("no_membership");
    expect(op.out.join("\n")).toContain(String(result.org.message));
  });

  it("never puts the refresh token in anything it prints", async () => {
    const { operator: op } = here();
    await whoami(op.environment);
    const printed = [...op.out, ...op.err].join("\n");
    expect(printed).not.toContain("a-refresh-token-that-must-never-be-printed");
  });
});

describe("nightshift project create, against the real handler", () => {
  it("sends no organisation and prints the one the control plane assigned (D-P2-13)", async () => {
    const { operator: op, plane: live } = here();
    const created = await createProject(op.environment, {
      name: "slice-demo",
      description: "the exit gate's project",
    });

    expect(created.projectId.startsWith("proj_")).toBe(true);
    // The org came back from the token's membership, not from the CLI.
    expect(created.orgId).toBe(op.orgId);
    expect(op.out[0]).toBe(created.projectId);

    // And it is really there: read back over a transport of this suite's own,
    // so the assertion does not depend on the CLI's own reply.
    const transport = createFetchTransport({
      endpoint: live.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    });
    const stored = await send(transport, {
      method: "GET",
      path: routes.project(created.projectId as never),
    });
    expect((stored as { name: string }).name).toBe("slice-demo");
    expect((stored as { orgId: string }).orgId).toBe(op.orgId);
  });

  it("refuses a name the contract's schema rejects, at the control plane", async () => {
    const { operator: op } = here();
    await expect(createProject(op.environment, { name: "" })).rejects.toThrow();
  });
});

describe("nightshift run, against the real handler", () => {
  it("writes the program, a pending run, its root node and the initial checkpoint", async () => {
    const { operator: op, plane: live } = here();
    const created = await createProject(op.environment, { name: "slice-demo" });
    fixture = await materialiseFixtureRepo({ projectId: created.projectId as never });
    op.out.length = 0;

    const result = await run(op.environment, {
      contract: join(fixture.repo, "nightshift.program.json"),
      repo: fixture.repo,
      remote: false,
    });

    expect(result.runId.startsWith("run_")).toBe(true);
    expect(result.projectId).toBe(created.projectId);
    expect(result.baseCommit).toBe(fixture.baseCommit);
    // The last line is an instruction to a person: nothing was spawned.
    expect(op.out.at(-1)).toContain("Open your orchestrator in");

    // Everything it claims to have written, read back from the control plane.
    const transport = createFetchTransport({
      endpoint: live.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    });
    const stores = createHttpStores({ transport, actingOrg: op.orgId });
    const scope = {
      projectId: result.projectId as never,
      programId: result.programId as never,
      runId: result.runId as never,
    };
    const stored = await stores.runs.get(
      { projectId: scope.projectId, programId: scope.programId },
      scope.runId,
    );
    expect(stored?.status).toBe("pending");
    const node = await stores.executionNodes.get(scope, result.rootNodeId as never);
    // The root of the tree: `parentNodeId` is nullable in the contract, so a
    // root is an explicit `null` rather than an absent field.
    expect(node?.parentNodeId).toBeNull();
    // `startRun` opens the root at `validated`: the contract it holds has been
    // parsed and stored, which is what that state means.
    expect(node?.status).toBe("validated");
    const checkpoints = await stores.checkpoints.listByRun(scope, {});
    expect(checkpoints.items).toHaveLength(1);
    expect(checkpoints.items[0]?.commitSha).toBe(fixture.baseCommit);
    expect(checkpoints.items[0]?.executionNodeId).toBe(result.rootNodeId);
  });

  it("refuses --remote before it writes anything", async () => {
    const { operator: op, plane: live } = here();
    const created = await createProject(op.environment, { name: "slice-demo" });
    fixture = await materialiseFixtureRepo({ projectId: created.projectId as never });

    await expect(
      run(op.environment, {
        contract: join(fixture.repo, "nightshift.program.json"),
        repo: fixture.repo,
        remote: true,
      }),
    ).rejects.toThrow(/P8/);

    // Nothing reached the control plane: no program, so no run to find.
    const transport = createFetchTransport({
      endpoint: live.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    });
    const stores = createHttpStores({ transport, actingOrg: op.orgId });
    const programs = await stores.programContracts.listByProject(created.projectId as never, {});
    expect(programs.items).toHaveLength(0);
  });

  it("is refused by the control plane when the contract names a project that does not exist", async () => {
    const { operator: op } = here();
    fixture = await materialiseFixtureRepo({ projectId: op.ids.next("proj") as never });
    // Referential integrity is the API's rule, not the CLI's, and this is the
    // test that the CLI does not quietly work around it.
    await expect(
      run(op.environment, {
        contract: join(fixture.repo, "nightshift.program.json"),
        repo: fixture.repo,
        remote: false,
      }),
    ).rejects.toThrow();
  });
});

describe("nightshift id", () => {
  it("mints an identifier for a known prefix and refuses an unknown one", () => {
    const { operator: op } = here();
    expect(mintId(op.environment, "prog").startsWith("prog_")).toBe(true);
    expect(() => mintId(op.environment, "nonsense")).toThrow();
  });
});
