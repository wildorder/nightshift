/**
 * Props and naming shared by every Nightshift stack.
 *
 * Stacks are named `nightshift-<stage>-<role>` (D-P2-07): `data` for the stateful
 * stack, `api` for the stateless one, and from P11 (D-P11-02) `studio` for the
 * hosted console and `studio-cert` for its certificate in `us-east-1`. `stage`
 * defaults to `dev` in the app entry and is overridden with `-c stage=...`. The
 * one unstaged stack is `nightshift-dns` (D-P3-18): a hosted zone is per
 * account, and two stages creating two zones of the same name would each get
 * different nameservers and only one could be delegated.
 */
import type { StackProps } from "aws-cdk-lib";
import { DEFAULT_HOSTNAMES_MODE, type HostnamesMode } from "./hostnames.js";

/** Props for every Nightshift stack. `stage` names the deployment stage. */
export interface NightshiftStackProps extends StackProps {
  /** Deployment stage, e.g. `dev`. Part of every stack name and export name. */
  readonly stage: string;
  /** Whether to create the certificate and custom domain (D-P3-18). Default `full`. */
  readonly hostnames?: HostnamesMode;
}

export const hostnamesModeOf = (props: { readonly hostnames?: HostnamesMode }): HostnamesMode =>
  props.hostnames ?? DEFAULT_HOSTNAMES_MODE;

/** The account-wide DNS stack's name. Not staged, on purpose. */
export const DNS_STACK_NAME = "nightshift-dns";

/**
 * Lowercase letters, digits and hyphens, starting with a letter. The stage ends
 * up inside the Cognito domain prefix, which accepts nothing else, so a bad stage
 * is refused at synth rather than at deploy.
 */
const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;

export const assertValidStage = (stage: string): void => {
  if (!STAGE_PATTERN.test(stage)) {
    throw new Error(
      `invalid stage "${stage}": use 1-20 lowercase letters, digits or hyphens, starting with a letter`,
    );
  }
};

/** The staged stacks' roles. */
export type StackRole = "data" | "api" | "studio" | "studio-cert" | "runner";

/** `nightshift-<stage>-<role>`. */
export const stackNameFor = (stage: string, role: StackRole): string =>
  `nightshift-${stage}-${role}`;

/**
 * The DNS stack's CloudFormation exports, consumed by the API stack by name
 * (never by construct reference), the same way it consumes the data stack's.
 */
export const DNS_EXPORT_KEYS = ["HostedZoneId", "ZoneName", "NameServers"] as const;
export type DnsExportKey = (typeof DNS_EXPORT_KEYS)[number];
export const dnsExportName = (key: DnsExportKey): string => `${DNS_STACK_NAME}-${key}`;
