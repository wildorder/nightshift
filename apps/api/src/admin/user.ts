/**
 * The operator bootstrap (T2 deliverable 6, D-P3-16).
 *
 *   AWS_PROFILE=nightshift npm run admin:user -- --email you@example.com
 *   AWS_PROFILE=nightshift npm run admin:user -- --email you@example.com --org org_…
 *
 * Creates, or adopts, the Cognito user a human signs in as, and writes the
 * `User` and `Membership` rows the API's org resolution needs. Opt-in, from a
 * developer machine, never in CI.
 *
 * ## Why this exists, and what it refuses to depend on
 *
 * The interactive login (T7) can only sign in a user the operator created: v1
 * has no self sign-up. On 2026-09-15 that user was created by hand, and the
 * invitation appeared never to arrive — the cause turned out to be a recipient
 * domain whose DNS had stopped resolving, but proving that took an afternoon
 * because the pool logged nothing.
 *
 * So **nothing here depends on the invitation email**. The user is created with
 * `MessageAction: SUPPRESS` and given a permanent password immediately, landing
 * it in `CONFIRMED` with no forced change and no email in the loop at all. The
 * pool's default mailer is best-effort, capped at fifty messages a day, and keeps
 * its own suppression list; it is not a channel a bootstrap can rely on.
 *
 * ## Idempotence
 *
 * Re-running against an existing user changes nothing: the user is adopted, and
 * existing rows are reported rather than rewritten. A user already in one
 * organisation is not quietly added to a second, because the API cannot pick
 * between two memberships (`acting-org.ts`) — that needs `--org` naming the one
 * it already holds, or it is refused.
 */
import { parseArgs } from "node:util";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { type OrgId, OrgIdSchema, type UserId, UserIdSchema } from "@nightshift/contracts";
import { createUlidIdGenerator } from "@nightshift/core";
import { createAwsClients, createAwsStores } from "@nightshift/persistence/aws";
import { loadStackEnvironment, REGION } from "../aws/stack-outputs.js";

const say = (line: string): void => {
  process.stdout.write(`[admin:user] ${line}\n`);
};

/** Control characters the hidden prompt has to act on rather than collect. */
const ENTER = ["\r", "\n"];
const CANCEL = [String.fromCharCode(3), String.fromCharCode(4)];
const BACKSPACE = [String.fromCharCode(127), "\b"];

export interface AdminUserOptions {
  readonly email: string;
  readonly org?: OrgId;
  readonly stage?: string;
}

/**
 * Reads one line with terminal echo off.
 *
 * A password is never a flag and never read from a pipe, so it cannot end up in
 * a shell history, a CI log or a process listing. It is held in memory for the
 * one `AdminSetUserPassword` call and never printed.
 */
const promptHidden = async (question: string): Promise<string> => {
  const input = process.stdin;
  const output = process.stdout;
  if (input.isTTY !== true) {
    throw new Error(
      "a password must be typed at a terminal; this script never takes one as a flag " +
        "and never reads one from a pipe",
    );
  }
  output.write(question);
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  try {
    let value = "";
    for (;;) {
      const chunk: Buffer = await new Promise((resolve) => input.once("data", resolve));
      const text = chunk.toString("utf8");
      if (ENTER.includes(text)) break;
      // Abort rather than treat a partial value as a deliberate password.
      if (CANCEL.includes(text)) throw new Error("cancelled");
      if (BACKSPACE.includes(text)) {
        value = value.slice(0, -1);
        continue;
      }
      value += text;
    }
    return value;
  } finally {
    input.setRawMode(wasRaw);
    output.write("\n");
  }
};

/** A second reading, so a typo does not become the operator's only password. */
const promptPasswordTwice = async (): Promise<string> => {
  const first = await promptHidden("Choose a permanent password for this user: ");
  if (first.length < 8) throw new Error("Cognito requires at least eight characters");
  const second = await promptHidden("Type it again: ");
  if (first !== second) throw new Error("the two passwords did not match");
  return first;
};

const findByEmail = async (
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
): Promise<UserType | undefined> => {
  // An exact email filter, not a prefix: the pool's sign-in alias is email, so
  // at most one user can hold it. Limit 2 so a pool that somehow holds two is
  // reported rather than silently resolved to the first.
  const listed = await cognito.send(
    new ListUsersCommand({ UserPoolId: userPoolId, Filter: `email = "${email}"`, Limit: 2 }),
  );
  const users = listed.Users ?? [];
  if (users.length > 1) {
    throw new Error(
      `the pool holds ${users.length} users with the email ${email}; resolve that by hand first`,
    );
  }
  return users[0];
};

const subjectOf = (user: UserType): UserId => {
  const sub = user.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
  if (sub === undefined) throw new Error(`user ${user.Username ?? "?"} has no sub attribute`);
  return UserIdSchema.parse(sub);
};

export const runAdminUser = async (options: AdminUserOptions): Promise<void> => {
  const environment = await loadStackEnvironment(options.stage ?? process.env.NIGHTSHIFT_STAGE);
  say(`stage ${environment.stage}; caller ${environment.callerArn}`);
  say(`pool ${environment.userPoolId}; table ${environment.tableName}`);

  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const stores = createAwsStores({
    tableName: environment.tableName,
    table: createAwsClients({ region: REGION }).table,
  });

  // --- The Cognito user -------------------------------------------------------
  const existing = await findByEmail(cognito, environment.userPoolId, options.email);
  let user: UserType;
  if (existing === undefined) {
    say(`no user holds ${options.email}; creating one with the invitation suppressed`);
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: environment.userPoolId,
        Username: options.email,
        UserAttributes: [
          { Name: "email", Value: options.email },
          // Marked verified because the operator created this account
          // deliberately; there is no email round trip to confirm it with, and
          // depending on one is what D-P3-16 exists to stop.
          { Name: "email_verified", Value: "true" },
        ],
        MessageAction: "SUPPRESS",
      }),
    );
    if (created.User === undefined) throw new Error("AdminCreateUser returned no user");
    user = created.User;

    const password = await promptPasswordTwice();
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: environment.userPoolId,
        Username: options.email,
        Password: password,
        // Permanent, so the user lands in CONFIRMED with no forced change.
        Permanent: true,
      }),
    );
    say("password set; the user is CONFIRMED");
  } else {
    user = existing;
    say(`adopting the existing user ${user.Username ?? "?"} (${user.UserStatus ?? "?"})`);
  }

  const userId = subjectOf(user);
  say(`subject ${userId}`);
  say(`sign in at: ${environment.hostedSignInUrl}`);

  // --- The control-plane rows -------------------------------------------------
  const now = new Date().toISOString();
  const storedUser = await stores.users.get(userId);
  if (storedUser === undefined) {
    await stores.users.put({
      schemaVersion: 1,
      userId,
      kind: "human",
      email: options.email,
      createdAt: now,
    });
    say("wrote the User row");
  } else {
    say(`the User row already exists (created ${storedUser.createdAt}); left as it is`);
  }

  await ensureMembership(stores, userId, now, options.org);
};

/**
 * Writes the membership, or reports the one that already exists.
 *
 * Refusing a second membership is not fussiness: the API resolves the acting org
 * from a single membership when no `custom:active_org` claim is present
 * (`acting-org.ts`), so a user in two organisations cannot act at all until one
 * is selected. Adding one silently would break the operator's next command.
 */
const ensureMembership = async (
  stores: ReturnType<typeof createAwsStores>,
  userId: UserId,
  now: string,
  requested: OrgId | undefined,
): Promise<void> => {
  const heldOrgs = (await stores.memberships.listByUser(userId)).map(
    (membership) => membership.orgId,
  );

  if (requested !== undefined) {
    if (heldOrgs.includes(requested)) {
      say(`the Membership in ${requested} already exists; left as it is`);
      return;
    }
    if (heldOrgs.length > 0) {
      throw new Error(
        `this user already belongs to ${heldOrgs.join(", ")}. Adding ${requested} would leave ` +
          "it in several organisations, and the control plane cannot pick one without an " +
          "explicit custom:active_org claim. Remove the other membership first if that is " +
          "what you mean.",
      );
    }
    await stores.memberships.put({ schemaVersion: 1, userId, orgId: requested, createdAt: now });
    say(`wrote the Membership in ${requested}`);
    return;
  }

  if (heldOrgs.length > 1) {
    throw new Error(
      `this user belongs to ${heldOrgs.join(", ")}. The control plane cannot pick one; ` +
        "name the intended org with --org.",
    );
  }
  const onlyOrg = heldOrgs[0];
  if (onlyOrg !== undefined) {
    say(`the Membership in ${onlyOrg} already exists; left as it is`);
    return;
  }

  const orgId = createUlidIdGenerator().next("org");
  await stores.memberships.put({ schemaVersion: 1, userId, orgId, createdAt: now });
  say(`minted a new organisation and wrote the Membership: ${orgId}`);
  say(`record this org id; every project this user creates belongs to it: ${orgId}`);
};

export const main = async (argv: readonly string[]): Promise<void> => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      email: { type: "string" },
      org: { type: "string" },
      stage: { type: "string" },
    },
    strict: true,
  });
  if (values.email === undefined || values.email === "") {
    throw new Error("usage: npm run admin:user -- --email <email> [--org org_…] [--stage dev]");
  }
  await runAdminUser({
    email: values.email,
    ...(values.org === undefined ? {} : { org: OrgIdSchema.parse(values.org) }),
    ...(values.stage === undefined ? {} : { stage: values.stage }),
  });
};

/** Run when invoked directly, not when imported by a test. */
if (process.argv[1]?.endsWith("user.js") === true) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[admin:user] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
