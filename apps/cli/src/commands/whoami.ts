/**
 * `nightshift whoami` — who Cognito says you are, and who the control plane
 * says you are acting as.
 *
 * Those are two different questions and the command answers both, because the
 * gap between them is the one an operator actually gets stuck in. A valid token
 * whose subject belongs to no organisation authenticates perfectly and can
 * create nothing; a subject in two organisations with no `custom:active_org` is
 * refused with `org_selection_required`. Neither is visible in the token.
 *
 * So the org half is answered by **asking the control plane** — `GET /projects`
 * is the cheapest route that resolves an acting org — and its refusal is printed
 * **verbatim**. `no_membership` and `org_selection_required` are the interesting
 * answers here, and paraphrasing them would hide the exact string the operator
 * needs to search for or quote in a support request.
 *
 * The token is minted fresh (`openFreshSession`). Reporting a subject from a
 * cached token would report what this machine last believed rather than what
 * Cognito will say now, and would not prove the stored refresh token still
 * works — which is half of what is being asked.
 */
import { ProjectSchema } from "@nightshift/contracts";
import {
  credentialsPath,
  isTokenProfile,
  profilePath,
  routes,
  tokenClaims,
} from "@nightshift/persistence/http";
import type { CliEnvironment } from "../environment.js";
import { openFreshSession } from "../session.js";

export interface WhoamiOrg {
  readonly ok: boolean;
  /** The typed refusal code (`no_membership`, `org_selection_required`, …) when refused. */
  readonly code?: string;
  readonly message?: string;
  /** The acting org, when the control plane resolved one and owns at least one project. */
  readonly orgId?: string;
  readonly projectCount?: number;
}

export interface WhoamiResult {
  readonly subject: string | undefined;
  readonly email: string | undefined;
  readonly activeOrgClaim?: string;
  readonly org: WhoamiOrg;
}

/** The claim the API reads to pick an org for a caller who belongs to several. */
export const ACTIVE_ORG_CLAIM = "custom:active_org";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const readRefusal = (body: unknown): { code: string; message: string } => {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return {
    code: asString(error?.code) ?? "unknown_error",
    message: asString(error?.message) ?? "the control plane refused the request",
  };
};

export const whoami = async (environment: CliEnvironment): Promise<WhoamiResult> => {
  const session = await openFreshSession(environment);
  const claims = tokenClaims(session.idToken);
  // A local instance's bearer is a secret, not a JWT: its operator is the one
  // it seeded (D-P12-03).
  const local = isTokenProfile(session.profile);
  const subject = local ? "local-operator" : asString(claims.sub);
  const email = local ? "local-operator (a local instance; no sign-in)" : asString(claims.email);
  const activeOrgClaim = asString(claims[ACTIVE_ORG_CLAIM]);

  environment.out(`subject ${subject ?? "(the ID token carries no sub claim)"}`);
  environment.out(`email   ${email ?? "(the ID token carries no email claim)"}`);
  environment.out(`profile ${profilePath(environment.paths)}`);
  environment.out(`session ${credentialsPath(environment.paths)}`);
  environment.out(`control plane ${session.profile.apiEndpoint} (stage ${session.profile.stage})`);
  if (activeOrgClaim !== undefined) {
    environment.out(`${ACTIVE_ORG_CLAIM} ${activeOrgClaim}`);
  }

  // The raw transport rather than `stores.projects.listByOrg`: a refusal here is
  // the answer, not an error, and it must reach the operator unparaphrased.
  const response = await session.transport({ method: "GET", path: routes.projects() });
  if (response.status !== 200) {
    const refusal = readRefusal(response.body);
    environment.out(
      `org     refused by the control plane (${response.status} ${refusal.code}): ${refusal.message}`,
    );
    return {
      subject,
      email,
      ...(activeOrgClaim === undefined ? {} : { activeOrgClaim }),
      org: { ok: false, code: refusal.code, message: refusal.message },
    };
  }

  const items = ((response.body as { items?: unknown[] } | null)?.items ?? []).map((item) =>
    ProjectSchema.parse(item),
  );
  // `GET /projects` lists the acting org and only the acting org, so the org of
  // any project it returned *is* the acting org. With no projects yet, the
  // resolution still succeeded — which is what the operator is asking — and the
  // identifier simply has nothing to come from.
  const orgId = items[0]?.orgId;
  environment.out(
    orgId === undefined
      ? `org     resolved (the control plane accepted the token); no projects yet, so it has no id to show`
      : `org     ${orgId} — ${items.length} project${items.length === 1 ? "" : "s"}`,
  );
  return {
    subject,
    email,
    ...(activeOrgClaim === undefined ? {} : { activeOrgClaim }),
    org: { ok: true, ...(orgId === undefined ? {} : { orgId }), projectCount: items.length },
  };
};
