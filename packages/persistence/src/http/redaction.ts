/**
 * What this process must never send to the control plane (A-62): the values of
 * the project's secrets it holds. Registered once, by the composition root, as
 * soon as it knows which names the program declares, and applied by every
 * transport and every artifact upload this process makes, whichever made them:
 * a step's log, an event, a transcript, a record. The values are this
 * process's, so the registry is too.
 */
import { redactSecrets } from "@nightshift/contracts";

const known: Record<string, string> = {};

/** Adds secrets to redact from everything this process sends from now on. */
export const redactFromNowOn = (secrets: Readonly<Record<string, string>>): void => {
  Object.assign(known, secrets);
};

/** `text` with every registered secret's value replaced by its name. */
export const redactOutbound = (text: string): string =>
  Object.keys(known).length === 0 ? text : redactSecrets(text, known);

/** For a suite: forgets every registered secret. */
export const forgetRedactions = (): void => {
  for (const name of Object.keys(known)) delete known[name];
};
