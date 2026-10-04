/**
 * A worker's token, kept fresh for a long job (P10, T4; D-P4-03, D-P10-20).
 *
 * An execution token lives at most eight hours. A job can outlive that: a
 * five-hour run with retries, a worker waiting on a slow suite. So on a
 * machine the token is not handed to the worker's process in its environment,
 * where it would be fixed for the process's life, but written to a file the
 * worker's MCP server reads on every request, and the engine rewrites the file
 * with a new token before the old one expires, exactly as the runner keeps its
 * own engine token (D-P10-20). The file is the worker's: in a directory the
 * engine makes and hands over, readable by nobody else.
 *
 * Nothing here knows how a token is minted (the port does) or where files go
 * on a machine (the composition does); this is the schedule.
 */
import type { AgentId } from "@nightshift/contracts";
import type { ExecutionTokenMinter, MintedExecutionToken, RunScope } from "@nightshift/core";

/** Where a worker's token file lives and how it is handed over: the composition's. */
export interface WorkerTokenFiles {
  /** Writes the token for `agentId` and returns the file's path; the file is the worker's. */
  place(scope: RunScope, agentId: AgentId, token: string): Promise<string>;
  /** Removes the file once the agent is done. Never throws. */
  remove(scope: RunScope, agentId: AgentId): Promise<void>;
}

export interface TokenRenewal {
  /** Stops renewing. The last token written stays until `remove`. */
  stop(): void;
}

export interface TokenRenewalInput {
  readonly scope: RunScope;
  readonly agentId: AgentId;
  readonly minted: MintedExecutionToken;
  readonly tokens: ExecutionTokenMinter;
  readonly files: WorkerTokenFiles;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** Injected so the schedule is testable; the default is `setTimeout`. */
  readonly schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

/** Renew when this share of the token's life has passed: half, so one failed renewal leaves time for another. */
export const RENEWAL_SHARE = 0.5;
/** Never wait longer than this between renewals, however long a token lives. */
export const MAX_RENEWAL_INTERVAL_MS = 4 * 60 * 60_000;
/** A token that is already this close to expiry is renewed at once. */
const MIN_RENEWAL_INTERVAL_MS = 1_000;

/** How long to wait before renewing a token that expires at `expiresAt`. */
export const renewalDelayMs = (expiresAt: string, nowMs: number): number => {
  const remaining = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(remaining)) return MAX_RENEWAL_INTERVAL_MS;
  return Math.max(
    MIN_RENEWAL_INTERVAL_MS,
    Math.min(remaining * RENEWAL_SHARE, MAX_RENEWAL_INTERVAL_MS),
  );
};

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};

/**
 * Keeps renewing a worker's token until stopped: at each due time a new token is
 * minted and written over the old one, and the next due time follows from the
 * new token's expiry. A failed renewal is logged and tried again after a
 * minute; the old token is still good until its own expiry.
 */
export const startTokenRenewal = (input: TokenRenewalInput): TokenRenewal => {
  const schedule = input.schedule ?? defaultSchedule;
  let stopped = false;
  let pending: { cancel(): void } | undefined;
  const RETRY_MS = 60_000;

  const arm = (delayMs: number): void => {
    if (stopped) return;
    pending = schedule(() => {
      void renew();
    }, delayMs);
  };
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const minted = await input.tokens.mint(input.scope, input.agentId);
      await input.files.place(input.scope, input.agentId, minted.token);
      input.log(`renewed the token of ${input.agentId}; it now expires at ${minted.expiresAt}`);
      arm(renewalDelayMs(minted.expiresAt, input.now()));
    } catch (error) {
      input.log(
        `could not renew the token of ${input.agentId}: ${error instanceof Error ? error.message : String(error)}; trying again in a minute`,
      );
      arm(RETRY_MS);
    }
  };

  arm(renewalDelayMs(input.minted.expiresAt, input.now()));
  return {
    stop: () => {
      stopped = true;
      pending?.cancel();
    },
  };
};
