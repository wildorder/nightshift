/**
 * What a step is told about the verification it runs in (P17, D-P17-06).
 *
 * The project owns its services and their semantics; Nightshift owns the facts
 * about the context it created, and tells them. With these three a project's
 * script can keep a service alive across verifications and give each one a
 * database of its own, named by the id, or run only what changed since the
 * base. Nightshift learns nothing about the service.
 */

/** Unique per verification, and the same for a check's rerun within it. */
export const VERIFICATION_ID_ENV = "NIGHTSHIFT_VERIFICATION_ID";
/** The commit under verification. */
export const HEAD_SHA_ENV = "NIGHTSHIFT_HEAD_SHA";
/**
 * The commit the one under verification is being landed onto: the program head
 * in the queue, the job's base in a candidate check. Absent where there is
 * none: the gate audit and the run's end gates verify a head, not a change.
 */
export const BASE_SHA_ENV = "NIGHTSHIFT_BASE_SHA";

export interface VerificationFacts {
  readonly verificationId: string;
  readonly headSha: string;
  readonly baseSha?: string | undefined;
}

/** The facts as a step's environment carries them. */
export const verificationFacts = (facts: VerificationFacts): Readonly<Record<string, string>> => ({
  [VERIFICATION_ID_ENV]: facts.verificationId,
  [HEAD_SHA_ENV]: facts.headSha,
  ...(facts.baseSha === undefined ? {} : { [BASE_SHA_ENV]: facts.baseSha }),
});
