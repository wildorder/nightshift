import type { LineVerifierPort } from "./ports.js";

/** Shaped by the verifier job. */
// biome-ignore lint/suspicious/noEmptyInterface: declared open for a later job to shape
export interface LineVerifierOptions {}

export const createLineVerifier = (_options: LineVerifierOptions): LineVerifierPort => {
  throw new Error("not implemented");
};
