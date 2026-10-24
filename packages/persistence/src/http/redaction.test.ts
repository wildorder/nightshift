import { afterEach, describe, expect, it } from "vitest";
import { createHttpArtifactBodyStore, type UploadFetch } from "./artifact-bodies.js";
import { forgetRedactions, redactFromNowOn } from "./redaction.js";
import { createFetchTransport, type FetchLike } from "./transport.js";

afterEach(forgetRedactions);

const tokens = { idToken: async () => "the-id-token" };
const SCOPE = {
  projectId: "proj_01J0000000000000000000000A",
  programId: "prog_01J0000000000000000000000A",
  runId: "run_01J0000000000000000000000A",
} as never;

describe("what this process sends, once it holds a project's secrets (A-62)", () => {
  it("redacts every registered value from a request body, and nothing before it is registered", async () => {
    const bodies: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      if (init.body !== undefined) bodies.push(init.body);
      return { status: 200, text: async () => "{}" };
    };
    const transport = createFetchTransport({ endpoint: "https://plane.test", tokens, fetch });
    const event = { payload: { summary: "npm ci with ghp_very_secret_5678 failed" } };
    await transport({ method: "POST", path: "/events", body: event });
    redactFromNowOn({ NPM_TOKEN: "ghp_very_secret_5678" });
    await transport({ method: "POST", path: "/events", body: event });
    expect(bodies[0]).toContain("ghp_very_secret_5678");
    expect(bodies[1]).not.toContain("ghp_very_secret_5678");
    expect(JSON.parse(bodies[1] as string)).toEqual({
      payload: { summary: "npm ci with «NPM_TOKEN» failed" },
    });
  });

  it("redacts a text upload before it is measured, and leaves a binary one as it is", async () => {
    redactFromNowOn({ NPM_TOKEN: "ghp_very_secret_5678" });
    const uploaded: { type: string; bytes: Uint8Array; length: string }[] = [];
    const transport = createFetchTransport({
      endpoint: "https://plane.test",
      tokens,
      fetch: async (url) => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            artifactId: url.includes("0B")
              ? "art_01J0000000000000000000000B"
              : "art_01J0000000000000000000000A",
            uri: "s3://bucket/key",
            uploadUrl: "https://s3.test/put",
            key: "key",
            contentType: "text/plain",
            expiresAt: "2026-10-23T00:00:00.000Z",
          }),
      }),
    });
    const upload: UploadFetch = async (_url, init) => {
      uploaded.push({
        type: init.headers["content-type"] ?? "",
        bytes: init.body,
        length: init.headers["content-length"] ?? "",
      });
      return { status: 200, text: async () => "" };
    };
    const bodies = createHttpArtifactBodyStore({ transport, fetch: upload });
    const log = "token=ghp_very_secret_5678\n";
    const text = await bodies.put(
      SCOPE,
      "art_01J0000000000000000000000A" as never,
      log,
      "text/plain",
    );
    const binary = new TextEncoder().encode(log);
    await bodies.put(
      SCOPE,
      "art_01J0000000000000000000000B" as never,
      binary,
      "application/octet-stream",
    );
    const sent = new TextDecoder().decode(uploaded[0]?.bytes);
    expect(sent).toBe("token=«NPM_TOKEN»\n");
    expect(uploaded[0]?.length).toBe(String(uploaded[0]?.bytes.length));
    expect(text.sizeBytes).toBe(uploaded[0]?.bytes.length);
    expect(uploaded[1]?.bytes).toEqual(binary);
  });
});
