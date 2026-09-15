/**
 * Props and naming shared by every Nightshift stack.
 *
 * Stacks are named `nightshift-<stage>-<role>` (D-P2-07): `data` for the stateful
 * stack, `api` for the stateless one. `stage` defaults to `dev` in the app entry
 * and is overridden with `-c stage=...`.
 */
import type { StackProps } from "aws-cdk-lib";

/** Props for every Nightshift stack. `stage` names the deployment stage. */
export interface NightshiftStackProps extends StackProps {
  /** Deployment stage, e.g. `dev`. Part of every stack name and export name. */
  readonly stage: string;
}

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

/** `nightshift-<stage>-<role>`. */
export const stackNameFor = (stage: string, role: "data" | "api"): string =>
  `nightshift-${stage}-${role}`;
