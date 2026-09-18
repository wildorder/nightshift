/**
 * `ExecutionTokenMinter` over the control-plane API (P4, T4).
 *
 * One route, one response, nothing stored. The orchestrator's session calls it
 * with the operator's own identity, because minting is a user operation
 * (D-P4-03) — and the token that comes back is handed straight to the worker's
 * environment and never written anywhere.
 */
import { MintExecutionTokenResponseSchema } from "@nightshift/contracts";
import type { ExecutionTokenMinter } from "@nightshift/core";
import { routes } from "./routes.js";
import { send, type Transport } from "./transport.js";

export interface HttpExecutionTokenMinterOptions {
  readonly transport: Transport;
}

export const createHttpExecutionTokenMinter = (
  options: HttpExecutionTokenMinterOptions,
): ExecutionTokenMinter => ({
  async mint(scope, agentId) {
    const body = MintExecutionTokenResponseSchema.parse(
      await send(options.transport, {
        method: "POST",
        path: routes.agentToken(scope, agentId),
      }),
    );
    return { token: body.token, expiresAt: body.expiresAt };
  },
});
