/**
 * Turning a failure into something the operator can act on.
 *
 * `apps/mcp/src/results.ts` does this for a model; this does it for a human, and
 * for the same reason. A stack trace tells an operator nothing they can act on
 * and fills their terminal with this repository's file paths. What they need is
 * the fact — `no_membership`, `the project does not exist`, `port 47821 is
 * taken` — and the next command to type.
 *
 * So every failure the CLI can produce arrives here and leaves as a short,
 * stable `code`, one sentence, and an optional line of advice. The typed
 * failures the layers below raise already carry their own advice
 * (`ProjectMissingError` names `nightshift project create`;
 * `PortUnavailableError` explains why the port is not negotiable), and this
 * preserves those messages verbatim rather than paraphrasing them.
 *
 * **Nothing here ever formats a token.** The refresh token is never an argument
 * to any of these functions, and the one failure that happens while holding one
 * (`TokenExchangeError`) is constructed from named OAuth fields in `oauth.ts`
 * for exactly that reason.
 */
import { isDomainError } from "@nightshift/core";
import {
  PlanChangedError,
  PlanNotRatifiedError,
  ProgramContractChangedError,
  ProjectMissingError,
} from "@nightshift/execution";
import {
  ControlPlaneError,
  ControlPlaneUnreachableError,
  NotLoggedInError,
} from "@nightshift/persistence/http";
import { ZodError } from "zod";
import {
  AuthorizationRefusedError,
  CallbackTimeoutError,
  PortUnavailableError,
} from "./loopback.js";
import { TokenExchangeError } from "./oauth.js";
import { StateMismatchError } from "./pkce.js";

/** The stable vocabulary. An operator sees these; a script may branch on them. */
export type FailureCode =
  | "not_logged_in"
  | "invalid_contract"
  | "project_missing"
  | "program_contract_changed"
  | "plan_not_ratified"
  | "plan_changed"
  | "control_plane_refused"
  | "control_plane_unreachable"
  | "domain_rule"
  | "port_unavailable"
  | "state_mismatch"
  | "authorization_refused"
  | "callback_timeout"
  | "token_exchange_failed"
  | "bad_usage"
  | "failed";

export interface Failure {
  readonly code: FailureCode;
  readonly summary: string;
  /** The next thing to type, when there is one. */
  readonly advice?: string;
}

/** A misuse of the command line: an unknown command, a missing flag, a bad value. */
export class UsageError extends Error {
  override readonly name = "UsageError";

  constructor(
    message: string,
    readonly usage?: string,
  ) {
    super(message);
  }
}

/** A zod failure as one line per issue, which is what makes a bad contract fixable. */
const describeIssues = (error: ZodError): string =>
  error.issues
    .map(
      (issue) => `  ${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("\n");

/**
 * The typed failures, as a table.
 *
 * A table rather than a chain of `if`s because the list is long and every entry
 * says the same thing: this class, that code, and whatever advice is not already
 * in the message. Order matters only where one class extends another, which none
 * of these do; `ZodError` sits near the top because a contract that fails
 * validation is the one an operator meets most often.
 */
type Constructor<E> = abstract new (...args: never[]) => E;

interface Entry<E> {
  readonly error: Constructor<E>;
  readonly describe: (error: E) => Failure;
}

/** Keeps each entry's `describe` typed against its own class. */
const entry = <E>(error: Constructor<E>, describe: (error: E) => Failure): Entry<unknown> =>
  ({ error, describe }) as Entry<unknown>;

/** The message alone, for a class whose message already carries its own advice. */
const asIs =
  (code: FailureCode) =>
  (error: Error): Failure => ({ code, summary: error.message });

const TABLE: readonly Entry<unknown>[] = [
  entry(UsageError, (error) => ({
    code: "bad_usage",
    summary: error.message,
    ...(error.usage === undefined ? {} : { advice: error.usage }),
  })),
  // The message already names `nightshift login`; repeating it as advice would
  // print the same sentence twice. Same for the four below it.
  entry(NotLoggedInError, asIs("not_logged_in")),
  entry(ZodError, (error) => ({
    code: "invalid_contract",
    summary: `the Program Contract is not valid:\n${describeIssues(error)}`,
    advice: "Fix the contract and try again. Nothing was written.",
  })),
  entry(ProjectMissingError, asIs("project_missing")),
  entry(ProgramContractChangedError, asIs("program_contract_changed")),
  entry(PlanNotRatifiedError, asIs("plan_not_ratified")),
  entry(PlanChangedError, asIs("plan_changed")),
  entry(PortUnavailableError, asIs("port_unavailable")),
  entry(StateMismatchError, asIs("state_mismatch")),
  entry(AuthorizationRefusedError, asIs("authorization_refused")),
  entry(CallbackTimeoutError, asIs("callback_timeout")),
  entry(TokenExchangeError, (error) => ({
    code: "token_exchange_failed",
    summary: error.message,
    advice: "The authorization code is single-use and is now spent. Run `nightshift login` again.",
  })),
  entry(ControlPlaneUnreachableError, (error) => ({
    code: "control_plane_unreachable",
    summary: error.message,
    advice:
      "Check the network and that `apiEndpoint` in your profile is right; `nightshift whoami` " +
      "is the cheapest way to retry.",
  })),
  entry(ControlPlaneError, (error) => ({
    code: "control_plane_refused",
    summary: `the control plane answered ${error.status} (${error.code}): ${error.message}`,
    ...(error.status === 401 || error.status === 403
      ? { advice: "If this is unexpected, your session may have expired: run `nightshift login`." }
      : {}),
  })),
];

export const describeFailure = (error: unknown): Failure => {
  for (const candidate of TABLE) {
    if (error instanceof candidate.error) return candidate.describe(error);
  }
  if (isDomainError(error)) {
    // A rule the control plane enforced, reconstructed by the http adapter as
    // the same class the domain would have raised locally.
    return { code: "domain_rule", summary: `${error.code}: ${error.message}` };
  }
  // Nothing recognised: the message, and deliberately not the stack.
  return { code: "failed", summary: error instanceof Error ? error.message : String(error) };
};

/** The lines `bin/nightshift.ts` writes to stderr for a failure. */
export const failureLines = (failure: Failure): readonly string[] => [
  `nightshift: ${failure.code}: ${failure.summary}`,
  ...(failure.advice === undefined ? [] : [failure.advice]),
];
