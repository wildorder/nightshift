import { ProjectIdSchema } from "@nightshift/contracts";
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
  TEST_SUBJECT,
} from "../testing/harness.js";
import { createProject } from "./project-create.js";

const live: TestEnvironment[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((created) => created.cleanup()));
});

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

describe("nightshift project create", () => {
  it("mints a proj_ id, PUTs it, and prints the id", async () => {
    const { created, plane } = await prepare();

    const result = await createProject(created.environment, { name: "slice-demo" });

    expect(() => ProjectIdSchema.parse(result.projectId)).not.toThrow();
    const call = plane.call("PUT", `/projects/${result.projectId}`);
    expect(call).toBeDefined();
    // The id is the client's, so the route addresses the record it is creating.
    expect(created.out[0]).toBe(result.projectId);
  });

  it("never sends an organisation; the control plane assigns it from the token", async () => {
    const { created, plane } = await prepare();

    const result = await createProject(created.environment, { name: "slice-demo" });

    const call = plane.call("PUT", `/projects/${result.projectId}`);
    expect(call?.body).toEqual({
      schemaVersion: 1,
      projectId: result.projectId,
      name: "slice-demo",
      createdAt: "2026-09-15T12:00:00.000Z",
    });
    expect(Object.keys(call?.body as object)).not.toContain("orgId");
    // And the org the operator is told about is the one the control plane chose.
    expect(result.orgId).toBe(DEFAULT_TEST_ORG);
    expect(created.out.join("\n")).toContain(DEFAULT_TEST_ORG);
  });

  it("carries an optional description and omits the key when there is none", async () => {
    const { created, plane } = await prepare();

    const result = await createProject(created.environment, {
      name: "slice-demo",
      description: "the first vertical slice",
    });

    expect(plane.call("PUT", `/projects/${result.projectId}`)?.body).toMatchObject({
      description: "the first vertical slice",
    });
  });

  it("tells the operator what to do with the id it just printed", async () => {
    const { created } = await prepare();

    await createProject(created.environment, { name: "slice-demo" });

    expect(created.out.join("\n")).toContain("Put proj_");
    expect(created.out.join("\n")).toContain("projectId");
  });

  it("surfaces a typed refusal from the control plane rather than a stack trace", async () => {
    const { created } = await prepare({
      overrides: [
        {
          path: "/projects/",
          response: {
            status: 403,
            body: JSON.stringify({
              error: { code: "no_membership", message: "the caller belongs to no organisation" },
            }),
          },
        },
      ],
    });

    await expect(createProject(created.environment, { name: "slice-demo" })).rejects.toThrow(
      /belongs to no organisation/,
    );
  });

  it("refuses without a session", async () => {
    const created = await createTestEnvironment();
    live.push(created);

    await expect(createProject(created.environment, { name: "x" })).rejects.toThrow(
      /not signed in/,
    );
  });
});
