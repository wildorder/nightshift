/**
 * The thin Lambda wrapper: API Gateway HTTP API (payload v2) in, `handleRequest`
 * in the middle, JSON out. The only file that knows the Lambda event shape.
 *
 * Dependencies arrive through `getDeps`, so the entry point that wires the AWS
 * stores can build them once at cold start and this module stays adapter-free.
 *
 * `rawPath` is used as the route path, which assumes the `$default` stage; a
 * named stage would prefix it.
 */

import { PrincipalSchema } from "@nightshift/contracts";
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { RequestPrincipal } from "../auth/principal.js";
import { UserTokenLikeSchema } from "../auth/principal.js";
import { handleRequest } from "../handler.js";
import { type ApiDeps, errorBody } from "../http.js";
import type { AuthorizerContext } from "./authorizer.js";

type ApiEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

/**
 * The principal the authorizer put in the request context (D-P4-01).
 *
 * Parsed rather than cast: the context crosses a process boundary as JSON, and
 * the handler's whole design rests on this value being one of exactly two
 * shapes. An unparseable context is a 401 — something upstream is wrong, and
 * guessing would be the one thing worse than refusing.
 */
export const principalFrom = (event: ApiEvent): RequestPrincipal | undefined => {
  const raw = event.requestContext.authorizer?.lambda?.principal;
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const execution = PrincipalSchema.safeParse(parsed);
  if (execution.success && execution.data.kind === "execution") return execution.data;
  const user = UserTokenLikeSchema.safeParse(parsed);
  if (!user.success) return undefined;
  // Rebuilt rather than spread: `exactOptionalPropertyTypes` distinguishes an
  // absent `activeOrg` from one that is present and `undefined`, and the token
  // shape means the first.
  const { userId, activeOrg } = user.data;
  return activeOrg === undefined ? { kind: "user", userId } : { kind: "user", userId, activeOrg };
};

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

type BodyParse = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

const parseJsonBody = (event: ApiEvent): BodyParse => {
  if (event.body === undefined || event.body === "") return { ok: true, body: undefined };
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

export const createApiLambdaHandler =
  (getDeps: () => ApiDeps) =>
  async (event: ApiEvent): Promise<APIGatewayProxyStructuredResultV2> => {
    const principal = principalFrom(event);
    if (principal === undefined) {
      return json(401, errorBody("unauthenticated", "the request carries no usable principal"));
    }
    const parsed = parseJsonBody(event);
    if (!parsed.ok) {
      return json(400, errorBody("invalid_json", "request body is not valid JSON"));
    }
    const response = await handleRequest(getDeps(), {
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: event.queryStringParameters ?? {},
      body: parsed.body,
      principal,
    });
    return json(response.status, response.body);
  };
