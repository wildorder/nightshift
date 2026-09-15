/**
 * A deliberately small router: literal segments and `{name}` parameters, nothing
 * else. The route table is the API surface, so it should read at a glance.
 */
import type { ApiDeps, ApiRequest, ApiResponse } from "./http.js";
import type { PathParams } from "./params.js";

export type HttpMethod = "GET" | "PUT" | "POST";

export interface RouteContext {
  readonly deps: ApiDeps;
  readonly request: ApiRequest;
  readonly params: PathParams;
}

export type Handler = (context: RouteContext) => Promise<ApiResponse>;

export interface Route {
  readonly method: HttpMethod;
  /** e.g. `/projects/{projectId}/programs/{programId}` */
  readonly path: string;
  readonly handler: Handler;
}

export type RouteMatch =
  | { readonly kind: "matched"; readonly route: Route; readonly params: PathParams }
  | { readonly kind: "method_not_allowed"; readonly allowed: readonly HttpMethod[] }
  | { readonly kind: "not_found" };

const splitPath = (path: string): readonly string[] | undefined => {
  try {
    return path
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    // A malformed percent-escape cannot name any route.
    return undefined;
  }
};

const matchSegments = (
  pattern: readonly string[],
  actual: readonly string[],
): PathParams | undefined => {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const value = actual[index];
    if (value === undefined) return undefined;
    if (part.startsWith("{") && part.endsWith("}")) {
      params[part.slice(1, -1)] = value;
    } else if (part !== value) {
      return undefined;
    }
  }
  return params;
};

export const matchRoute = (routes: readonly Route[], method: string, path: string): RouteMatch => {
  const actual = splitPath(path);
  if (actual === undefined) return { kind: "not_found" };

  const allowed: HttpMethod[] = [];
  for (const route of routes) {
    const params = matchSegments(splitPath(route.path) ?? [], actual);
    if (params === undefined) continue;
    if (route.method === method) return { kind: "matched", route, params };
    allowed.push(route.method);
  }
  return allowed.length > 0 ? { kind: "method_not_allowed", allowed } : { kind: "not_found" };
};
