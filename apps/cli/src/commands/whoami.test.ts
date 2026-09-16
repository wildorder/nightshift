import { afterEach, describe, expect, it } from "vitest";
import type { TestEnvironment } from "../testing/harness.js";
import {
  createFakeControlPlane,
  createTestEnvironment,
  DEFAULT_TEST_ORG,
  signIn,
  TEST_API,
  TEST_AUTH_DOMAIN,
  TEST_EMAIL,
  TEST_REFRESH_TOKEN,
  TEST_SUBJECT,
} from "../testing/harness.js";
import { whoami } from "./whoami.js";

const live: TestEnvironment[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
});

const project = {
  schemaVersion: 1,
  projectId: "proj_00000000000000000000000001",
  orgId: DEFAULT_TEST_ORG,
  name: "slice-demo",
  createdAt: "2026-09-15T12:00:00.000Z",
};

const prepare = async (
  options: Partial<Parameters<typeof createFakeControlPlane>[0]> = {},
): Promise<{ created: TestEnvironment; plane: ReturnType<typeof createFakeControlPlane> }> => {
  const plane = createFakeControlPlane({
    apiEndpoint: TEST_API,
    authDomain: TEST_AUTH_DOMAIN,
    claims: { sub: TEST_SUBJECT, email: TEST_EMAIL },
    ...options,
  });
  const created = await createTestEnvironment({ fetch: plane.fetch });
  live.push(created);
  await signIn(created.environment);
  return { created, plane };
};

describe("nightshift whoami", () => {
  it("reports the subject and email from a freshly minted ID token", async () => {
    const { created, plane } = await prepare();

    const result = await whoami(created.environment);

    expect(result.subject).toBe(TEST_SUBJECT);
    expect(result.email).toBe(TEST_EMAIL);
    // Fresh: the refresh grant ran, rather than a cached token being read.
    const exchange = plane.find("/oauth2/token");
    expect(plane.form(exchange as never).grant_type).toBe("refresh_token");
    expect(created.out.join("\n")).toContain(TEST_SUBJECT);
    expect(created.out.join("\n")).toContain(TEST_EMAIL);
  });

  it("sends the ID token as a bearer credential and never the refresh token", async () => {
    const { created, plane } = await prepare();

    await whoami(created.environment);

    const listing = plane.requests.find((request) => request.url.endsWith("/projects"));
    expect(listing?.headers.authorization).toMatch(/^Bearer ey/);
    // The refresh token goes to the token endpoint and nowhere else: never to
    // the control plane, and never to the terminal.
    const toControlPlane = plane.requests.filter((request) => request.url.startsWith(TEST_API));
    expect(JSON.stringify(toControlPlane)).not.toContain(TEST_REFRESH_TOKEN);
    expect(created.out.join("\n")).not.toContain(TEST_REFRESH_TOKEN);
  });

  it("asks the control plane for the org, and reports the one it resolved", async () => {
    const { created, plane } = await prepare({
      projects: { status: 200, body: JSON.stringify({ items: [project] }) },
    });

    const result = await whoami(created.environment);

    expect(plane.call("GET", "/projects")).toBeDefined();
    expect(result.org).toEqual({ ok: true, orgId: DEFAULT_TEST_ORG, projectCount: 1 });
    expect(created.out.join("\n")).toContain(DEFAULT_TEST_ORG);
  });

  it("says the resolution succeeded when the org simply owns no projects yet", async () => {
    const { created } = await prepare();

    const result = await whoami(created.environment);

    expect(result.org).toEqual({ ok: true, projectCount: 0 });
    expect(created.out.join("\n")).toContain("no projects yet");
  });

  it.each([
    ["no_membership", "the caller belongs to no organisation"],
    [
      "org_selection_required",
      "the caller belongs to several organisations; select one with custom:active_org",
    ],
  ])("prints the typed refusal %s verbatim", async (code, message) => {
    const { created } = await prepare({
      projects: { status: 403, body: JSON.stringify({ error: { code, message } }) },
    });

    const result = await whoami(created.environment);

    expect(result.org).toEqual({ ok: false, code, message });
    const printed = created.out.join("\n");
    expect(printed).toContain(code);
    // Verbatim: the control plane's own sentence, not a paraphrase of it.
    expect(printed).toContain(message);
  });

  it("reports the active-org claim when the token carries one", async () => {
    const { created } = await prepare({
      claims: {
        sub: TEST_SUBJECT,
        email: TEST_EMAIL,
        "custom:active_org": DEFAULT_TEST_ORG,
      },
    });

    const result = await whoami(created.environment);

    expect(result.activeOrgClaim).toBe(DEFAULT_TEST_ORG);
    expect(created.out.join("\n")).toContain(`custom:active_org ${DEFAULT_TEST_ORG}`);
  });

  it("refuses to guess when there is no session", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    await expect(whoami(created.environment)).rejects.toThrow(/not signed in/);
  });
});
