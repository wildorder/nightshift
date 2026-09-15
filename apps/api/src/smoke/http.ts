/**
 * A minimal client for the deployed API, over Node's `fetch`. It returns status
 * and parsed body rather than throwing on non-2xx, because half the smoke suite's
 * assertions are about refusals.
 */

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

export interface SmokeApiClient {
  get(path: string): Promise<ApiResult>;
  put(path: string, body: unknown): Promise<ApiResult>;
  post(path: string, body: unknown): Promise<ApiResult>;
  /** A request with an explicit `Authorization` header, or none at all when `undefined`. */
  withAuthorization(
    authorization: string | undefined,
    method: string,
    path: string,
  ): Promise<ApiResult>;
}

const send = async (
  endpoint: string,
  authorization: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> => {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (text === "") parsed = undefined;
  else {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: keep the text, which is what a gateway refusal may be.
    }
  }
  return { status: response.status, body: parsed };
};

export const smokeApiClient = (endpoint: string, token: string): SmokeApiClient => {
  const bearer = `Bearer ${token}`;
  return {
    get: (path) => send(endpoint, bearer, "GET", path),
    put: (path, body) => send(endpoint, bearer, "PUT", path, body),
    post: (path, body) => send(endpoint, bearer, "POST", path, body),
    withAuthorization: (authorization, method, path) => send(endpoint, authorization, method, path),
  };
};
