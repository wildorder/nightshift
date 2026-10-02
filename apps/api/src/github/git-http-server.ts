/**
 * A smart-HTTP git server over `git http-backend`, for the publisher's tests:
 * a local bare repository standing in for GitHub, speaking the real protocol
 * from the real `git`, so what passes here is what GitHub will accept. Never
 * part of the deployed code.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface GitHttpServer {
  /** `http://127.0.0.1:<port>`; a repository is `${url}/<name>.git`. */
  readonly url: string;
  /** The requests seen, for a test that asks what was pushed. */
  readonly requests: { readonly method: string; readonly path: string }[];
  close(): Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

/** Runs `git http-backend` as a CGI for one request, under `root`. */
const handle = async (
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  // A client gone before the answer is written must not fail the suite either.
  response.on("error", () => undefined);
  request.socket.on("error", () => undefined);
  const url = new URL(request.url ?? "/", "http://localhost");
  const body = await readBody(request);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    REQUEST_METHOD: request.method ?? "GET",
    CONTENT_TYPE: request.headers["content-type"] ?? "",
    CONTENT_LENGTH: String(body.length),
    REMOTE_USER: "x-access-token",
    REMOTE_ADDR: "127.0.0.1",
    GATEWAY_INTERFACE: "CGI/1.1",
    SERVER_PROTOCOL: "HTTP/1.1",
  };
  const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  // The backend may exit before it has read the body (a push it refuses),
  // and the write into its closed stdin then raises EPIPE: an uncaught error
  // in the suite unless someone listens. Seen on the runner, blamed on the
  // publisher's tests, three runs in four.
  child.stdin.on("error", () => undefined);
  child.stdin.end(body);
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  if (code !== 0) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(`git http-backend exited ${code}: ${Buffer.concat(errors).toString("utf8")}`);
    return;
  }
  // CGI output: headers, a blank line, the body.
  const out = Buffer.concat(chunks);
  const separator = out.indexOf("\r\n\r\n") !== -1 ? "\r\n\r\n" : "\n\n";
  const split = out.indexOf(separator);
  const headerText = out.subarray(0, split).toString("utf8");
  const payload = out.subarray(split + separator.length);
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers[name] = value;
  }
  response.writeHead(status, headers);
  response.end(payload);
};

/** Serves every bare repository directly under `root` (`<root>/<name>.git`). */
export const startGitHttpServer = async (root: string): Promise<GitHttpServer> => {
  const requests: { method: string; path: string }[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    handle(root, request, response).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
