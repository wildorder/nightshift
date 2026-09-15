import {
  createFixedClock,
  createFixtures,
  makeMembership,
  makeProject,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createApiLambdaHandler } from "./api-handler.js";

const eventFor = (
  method: string,
  rawPath: string,
  claims: Record<string, string>,
  body?: string,
  isBase64Encoded = false,
): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers: {},
    isBase64Encoded,
    ...(body === undefined ? {} : { body }),
    requestContext: {
      http: { method, path: rawPath },
      authorizer: { jwt: { claims, scopes: [] } },
    },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe("createApiLambdaHandler", () => {
  it("maps an API Gateway v2 event to the handler and back to JSON", async () => {
    const stores = createInMemoryStores();
    const f = createFixtures();
    const sub = nextUserId(f);
    await stores.memberships.put(makeMembership(sub, f.ids.next("org")));
    const handler = createApiLambdaHandler(() => ({ stores, clock: createFixedClock(0) }));

    const { orgId: _orgId, ...body } = makeProject(f);
    const encoded = Buffer.from(JSON.stringify(body)).toString("base64");
    const put = await handler(
      eventFor("PUT", `/projects/${f.scope.projectId}`, { sub }, encoded, true),
    );
    expect(put.statusCode).toBe(201);
    expect(put.headers?.["content-type"]).toBe("application/json");

    const list = await handler(eventFor("GET", "/projects", { sub }));
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body ?? "").items).toHaveLength(1);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const handler = createApiLambdaHandler(() => ({
      stores: createInMemoryStores(),
      clock: createFixedClock(0),
    }));
    const response = await handler(eventFor("PUT", "/projects/x", { sub: "someone" }, "{nope"));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body ?? "").error.code).toBe("invalid_json");
  });
});
