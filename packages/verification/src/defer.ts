/**
 * How a verification command says it **could not run** (P7, D-P7-10).
 *
 * Nightshift never guesses whether a red check was a failure or a hurdle: that
 * guess is the loophole A-05 forbids. A command that cannot run for want of
 * something only a human can supply says so, deterministically:
 *
 * - it exits {@link DEFER_EXIT_CODE} (75, `EX_TEMPFAIL` in sysexits: "try again
 *   later"), **and**
 * - its output contains a line `NIGHTSHIFT_DEFER HP-nn <what is missing>`.
 *
 * Both, or it is a failure like any other. The step is deferred, the
 * prerequisite is recorded as discovered mid-run with that description, and the
 * remediation is the command's own to give on a second line if it likes
 * (`NIGHTSHIFT_REMEDIATION <how to fix it>`).
 */
export const DEFER_EXIT_CODE = 75;

const DEFER_LINE = /^NIGHTSHIFT_DEFER\s+(HP-\d{2,})\s+(.+?)\s*$/m;
const REMEDIATION_LINE = /^NIGHTSHIFT_REMEDIATION\s+(.+?)\s*$/m;

export interface DeferSignal {
  readonly prerequisiteId: string;
  readonly description: string;
  readonly remediation: string;
}

/** The deferral a command declared, or `undefined` when it did not (a plain failure). */
export const deferSignalOf = (exitCode: number, output: string): DeferSignal | undefined => {
  if (exitCode !== DEFER_EXIT_CODE) return undefined;
  const defer = DEFER_LINE.exec(output);
  if (defer === null) return undefined;
  return {
    prerequisiteId: defer[1] as string,
    description: defer[2] as string,
    remediation: REMEDIATION_LINE.exec(output)?.[1] ?? "",
  };
};
