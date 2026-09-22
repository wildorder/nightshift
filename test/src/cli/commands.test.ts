import { join } from "node:path";
import { type LocalControlPlane, startLocalControlPlane } from "@nightshift/api/testing";
import { createProject, mintId, run, whoami } from "@nightshift/cli";
import {
  createFetchTransport,
  createHttpStores,
  routes,
  send,
  staticTokenProvider,
  writeProfile,
} from "@nightshift/persistence/http";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MaterialisedRepo, materialiseFixtureRepo } from "../slice/fixture-repo.js";
import { AUTH_DOMAIN, CLIENT_ID, type Operator, SUBJECT, signIn } from "./operator.js";

let plane: LocalControlPlane | undefined;
let operator: Operator | undefined;
let fixture: MaterialisedRepo | undefined;

beforeEach(async () => {
  operator = await signIn();
  plane = operator.plane;
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
      principal: { kind: "user", userId: stranger as never },
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
    ).rejects.toThrow(/P10/);

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
