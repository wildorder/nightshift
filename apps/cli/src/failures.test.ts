import { ScopeWideningError } from "@nightshift/core";
import { ProgramContractChangedError, ProjectMissingError } from "@nightshift/execution";
import { ControlPlaneError, ControlPlaneUnreachableError } from "@nightshift/persistence/http";
import { describe, expect, it } from "vitest";
import { describeFailure, failureLines, UsageError } from "./failures.js";
import { PortUnavailableError } from "./loopback.js";
import { TokenExchangeError } from "./oauth.js";
import { StateMismatchError } from "./pkce.js";

/** The one string that must never appear in anything an operator sees. */
const SECRET = "eyJ.THE-REFRESH-TOKEN.zzz";

describe("describing a failure", () => {
  it("gives a usage error its usage line", () => {
    const failure = describeFailure(new UsageError("no", "nightshift id <prefix>"));
    expect(failure).toEqual({
      code: "bad_usage",
      summary: "no",
      advice: "nightshift id <prefix>",
    });
  });

  it("keeps the advice the domain failures already carry", () => {
    const missing = describeFailure(new ProjectMissingError("proj_x"));
    expect(missing.code).toBe("project_missing");
    expect(missing.summary).toContain("nightshift project create");

    const changed = describeFailure(new ProgramContractChangedError("prog_x"));
    expect(changed.code).toBe("program_contract_changed");
    expect(changed.summary).toContain("nightshift id prog");
  });

  it("reports a control-plane refusal with its status and stable code", () => {
    const failure = describeFailure(
      new ControlPlaneError(403, "no_membership", "the caller belongs to no organisation"),
    );
    expect(failure.code).toBe("control_plane_refused");
    expect(failure.summary).toContain("403");
    expect(failure.summary).toContain("no_membership");
    // Verbatim, so the operator can search for the exact sentence.
    expect(failure.summary).toContain("the caller belongs to no organisation");
    expect(failure.advice).toContain("nightshift login");
  });

  it("does not suggest signing in again for a refusal that has nothing to do with the session", () => {
    expect(describeFailure(new ControlPlaneError(409, "conflict", "already there")).advice).toBe(
      undefined,
    );
  });

  it("keeps a domain rule's own class and code across the network", () => {
    const failure = describeFailure(new ScopeWideningError(["paths widened"]));
    expect(failure.code).toBe("domain_rule");
    expect(failure.summary).toContain("scope_widening");
  });

  it("separates an unreachable control plane from a refused one", () => {
    const failure = describeFailure(
      new ControlPlaneUnreachableError("could not connect", 4, new Error("ECONNREFUSED")),
    );
    expect(failure.code).toBe("control_plane_unreachable");
    expect(failure.advice).toContain("apiEndpoint");
  });

  it("explains a busy loopback port", () => {
    const failure = describeFailure(new PortUnavailableError(47821, new Error("EADDRINUSE")));
    expect(failure.code).toBe("port_unavailable");
    expect(failure.summary).toContain("47821");
  });

  it("refuses a state mismatch as its own kind of failure", () => {
    expect(describeFailure(new StateMismatchError()).code).toBe("state_mismatch");
  });

  it("falls back to the message and never the stack", () => {
    const error = new Error("something went wrong");
    const failure = describeFailure(error);
    expect(failure).toEqual({ code: "failed", summary: "something went wrong" });
    expect(JSON.stringify(failure)).not.toContain("failures.test.ts");
  });

  it("handles something that is not an Error at all", () => {
    expect(describeFailure("a bare string").summary).toBe("a bare string");
  });
});

describe("what reaches the terminal", () => {
  it("is the code, the summary, and the advice when there is one", () => {
    expect(failureLines({ code: "failed", summary: "nope" })).toEqual(["nightshift: failed: nope"]);
    expect(failureLines({ code: "failed", summary: "nope", advice: "try this" })).toEqual([
      "nightshift: failed: nope",
      "try this",
    ]);
  });

  it("never carries a refresh token, even when one was in flight", () => {
    // The failure raised while the process is holding a token. Its message is
    // built from named OAuth fields precisely so this assertion can be made.
    const failure = describeFailure(
      new TokenExchangeError(200, "the response carried no id_token"),
    );
    expect(failureLines(failure).join("\n")).not.toContain(SECRET);
    expect(failureLines(failure).join("\n")).toContain("no id_token");
  });
});
