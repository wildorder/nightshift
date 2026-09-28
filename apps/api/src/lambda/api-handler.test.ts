import {
  createFixedClock,
  createFixtures,
  makeMembership,
  makeProject,
  nextUserId,
} from "@nightshift/core";
import { createInMemoryStores } from "@nightshift/persistence/memory";
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { RequestPrincipal } from "../auth/principal.js";
import { createApiLambdaHandler } from "./api-handler.js";
import type { AuthorizerContext } from "./authorizer.js";

type ApiEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

/**
 * An event as the gateway builds it after Nightshift's authorizer ran: the
 * principal is a JSON string in the Lambda authorizer's context, exactly as
 * `authorizer.ts` writes it.
 */
const eventFor = (
  method: string,
  rawPath: string,
  principal: RequestPrincipal | string | undefined,
  body?: string,
  isBase64Encoded = false,
): ApiEvent =>
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
      authorizer:
        principal === undefined
          ? {}
          : {
              lambda: {
                principal: typeof principal === "string" ? principal : JSON.stringify(principal),
              },
            },
    },
  }) as unknown as ApiEvent;

const userPrincipal = (userId: string): RequestPrincipal =>
  ({ kind: "user", userId }) as RequestPrincipal;

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
      eventFor("PUT", `/projects/${f.scope.projectId}`, userPrincipal(sub), encoded, true),
    );
    expect(put.statusCode).toBe(201);
    expect(put.headers?.["content-type"]).toBe("application/json");

    const list = await handler(eventFor("GET", "/projects", userPrincipal(sub)));
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body ?? "").items).toHaveLength(1);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const handler = createApiLambdaHandler(() => ({
      stores: createInMemoryStores(),
      clock: createFixedClock(0),
    }));
    const response = await handler(
      eventFor("PUT", "/projects/x", userPrincipal("someone"), "{nope"),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body ?? "").error.code).toBe("invalid_json");
  });

  /**
   * The handler verifies nothing (SC-P4-10), so a request that reaches it
   * without a principal is a failure upstream, not something to interpret.
   * Refusing beats guessing.
   */
  it("answers 401 when the authorizer context carries no usable principal", async () => {
    const handler = createApiLambdaHandler(() => ({
      stores: createInMemoryStores(),
      clock: createFixedClock(0),
    }));
    for (const context of [undefined, "not json", JSON.stringify({ kind: "service" })]) {
      const response = await handler(eventFor("GET", "/projects", context));
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body ?? "").error.code).toBe("unauthenticated");
    }
  });

  /**
   * P11 (D-P11-03): the preflight route carries no authorizer, so an `OPTIONS`
   * arrives with no principal. It is answered empty and nothing is read; every
   * other method without a principal is still the 401 above.
   */
  it("answers an OPTIONS preflight 204 with no body, principal or none", async () => {
    let asked = 0;
    const handler = createApiLambdaHandler(() => {
      asked += 1;
      return { stores: createInMemoryStores(), clock: createFixedClock(0) };
    });
    for (const principal of [undefined, userPrincipal("someone")]) {
      const response = await handler(eventFor("OPTIONS", "/projects", principal));
      expect(response.statusCode).toBe(204);
      expect(response.body).toBeUndefined();
    }
    expect(asked).toBe(0);
    expect((await handler(eventFor("HEAD", "/projects", undefined))).statusCode).toBe(401);
  });
});
