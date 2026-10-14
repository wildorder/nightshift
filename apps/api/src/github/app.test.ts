import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubAppClient } from "./app.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** GitHub's token endpoint, answering 422 for a permission the installation has not granted. */
const tokenEndpoint = (granted: readonly string[]) => {
  const asked: Record<string, string>[] = [];
  const fetchStub = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { permissions: Record<string, string> };
    asked.push(body.permissions);
    const missing = Object.keys(body.permissions).filter((name) => !granted.includes(name));
    return missing.length > 0
      ? new Response(
          JSON.stringify({
            message: "The permissions requested are not granted to this installation.",
          }),
          { status: 422 },
        )
      : new Response(JSON.stringify({ token: "ghs_x", expires_at: "2026-10-14T06:00:00Z" }), {
          status: 201,
        });
  }) as typeof fetch;
  const client = createGitHubAppClient({
    secret: async () => ({ appId: "1", privateKey }),
    fetch: fetchStub,
  });
  return { client, asked };
};

describe("the publisher's write token (2026-10-14)", () => {
  it("asks for workflows with contents, so a push that changes a workflow file is allowed", async () => {
    const { client, asked } = tokenEndpoint(["contents", "workflows", "metadata"]);
    await expect(client.writeToken(7, "wildorder/foodfly")).resolves.toMatchObject({
      token: "ghs_x",
    });
    expect(asked).toEqual([{ contents: "write", workflows: "write", metadata: "read" }]);
  });

  it("falls back to contents alone while the installation has not accepted workflows", async () => {
    const { client, asked } = tokenEndpoint(["contents", "metadata"]);
    await expect(client.writeToken(7, "wildorder/foodfly")).resolves.toMatchObject({
      token: "ghs_x",
    });
    expect(asked).toEqual([
      { contents: "write", workflows: "write", metadata: "read" },
      { contents: "write", metadata: "read" },
    ]);
  });

  it("never asks a reading token for workflows", async () => {
    const { client, asked } = tokenEndpoint(["contents", "metadata"]);
    await client.readToken(7, ["wildorder/foodfly"]);
    expect(asked).toEqual([{ contents: "read", metadata: "read" }]);
  });
});
