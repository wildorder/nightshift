#!/usr/bin/env node
/**
 * The Nightshift MCP server binary.
 *
 * One executable, two roles, selected by `NIGHTSHIFT_ROLE` (D-P3-01). It speaks
 * stdio and opens no socket: the operating-system process boundary is its
 * authentication, and whoever can spawn it is the operator.
 *
 * Runs from `dist`, so a harness launches it with `node <path>` and no
 * TypeScript loader is involved.
 *
 * Nothing goes to stdout but the protocol. A stdio server that logged to stdout
 * would corrupt its own framing, which is why every diagnostic here is stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { adoptProjectEnv } from "../project-env.js";
import { createNightshiftServer } from "../server.js";

const say = (line: string): void => {
  process.stderr.write(`[nightshift-mcp] ${line}\n`);
};

const main = async (): Promise<void> => {
  // On a machine, the project environment the runner wrote (P16 S-01).
  const adopted = await adoptProjectEnv(process.env);
  if (adopted > 0) say(`project environment: ${adopted} variable(s)`);
  const server = await createNightshiftServer({ env: process.env });
  say(`role ${server.role}; control plane ${server.endpoint}`);

  let stopping: Promise<void> | undefined;
  const stop = (reason: string): void => {
    // Assigned so a second signal joins the first shutdown rather than starting
    // another. `stop` itself is idempotent; this keeps the process from
    // exiting twice.
    stopping ??= server
      .stop(reason)
      .catch((error: unknown) => {
        say(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .then(() => {
        process.exit(0);
      });
    void stopping;
  };

  // The three ways a stdio server is told to go. stdin closing is the only
  // notice a harness that simply exits gives us.
  process.stdin.on("close", () => {
    stop("the harness closed stdin");
  });
  process.on("SIGTERM", () => {
    stop("SIGTERM");
  });
  process.on("SIGINT", () => {
    stop("SIGINT");
  });

  await server.connect(new StdioServerTransport());
};

main().catch((error: unknown) => {
  say(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
