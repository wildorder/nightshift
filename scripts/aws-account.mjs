/**
 * The guard every AWS-touching script runs first (A-17, contract §10).
 *
 * There is exactly one account Nightshift v1 may touch, and deploying or smoking
 * the wrong one is the mistake worth engineering against. So a script refuses to
 * start unless `AWS_PROFILE` is set and resolves to that account and region. The
 * check shells out to the AWS CLI rather than importing the SDK, so a root script
 * depends on nothing a workspace package has not declared.
 *
 * Credentials are never read, printed or passed on: the CLI resolves them from the
 * profile, and only the account id and ARN come back.
 */
import { execFileSync } from "node:child_process";

export const EXPECTED_ACCOUNT = "755348349819";
export const EXPECTED_REGION = "us-west-2";

/** Windows resolves `aws.cmd` and `npx.cmd` only through a shell. */
export const SHELL = process.platform === "win32";

const fail = (message) => {
  console.error(`\nRefusing to continue: ${message}\n`);
  process.exit(1);
};

const cli = (args) =>
  execFileSync("aws", args, {
    encoding: "utf8",
    shell: SHELL,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export const assertNightshiftAccount = () => {
  const profile = process.env.AWS_PROFILE;
  if (profile === undefined || profile === "") {
    fail("AWS_PROFILE is not set. Run as: AWS_PROFILE=nightshift npm run <script>");
  }

  let identity;
  try {
    identity = JSON.parse(cli(["sts", "get-caller-identity", "--output", "json"]));
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    fail(
      `could not resolve credentials for profile "${profile}". ${detail}\n` +
        `If the SSO session has expired: aws sso login --profile ${profile}`,
    );
  }

  if (identity.Account !== EXPECTED_ACCOUNT) {
    fail(
      `profile "${profile}" resolves to account ${identity.Account}, not ${EXPECTED_ACCOUNT}. ` +
        "Nightshift v1 deploys to exactly one account (A-17).",
    );
  }

  let region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region === undefined || region === "") {
    try {
      region = cli(["configure", "get", "region"]);
    } catch {
      region = "";
    }
  }
  if (region !== EXPECTED_REGION) {
    fail(
      `profile "${profile}" targets region "${region || "(none)"}", not ${EXPECTED_REGION}. ` +
        `Set AWS_REGION=${EXPECTED_REGION} or configure the profile's region.`,
    );
  }

  return { profile, account: identity.Account, arn: identity.Arn, region };
};
