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
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { handleRequest } from "../handler.js";
import { type ApiDeps, errorBody } from "../http.js";

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

type BodyParse = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

const parseJsonBody = (event: APIGatewayProxyEventV2WithJWTAuthorizer): BodyParse => {
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
  async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const parsed = parseJsonBody(event);
    if (!parsed.ok) {
      return json(400, errorBody("invalid_json", "request body is not valid JSON"));
    }
    const response = await handleRequest(getDeps(), {
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: event.queryStringParameters ?? {},
      body: parsed.body,
      claims: event.requestContext.authorizer.jwt.claims,
    });
    return json(response.status, response.body);
  };
