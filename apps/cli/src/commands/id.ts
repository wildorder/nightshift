/**
 * `nightshift id <prefix>` — one fresh identifier, for a human authoring a file.
 *
 * A Program Contract is written by hand and carries its own `programId`, so the
 * author needs a well-formed prefixed ULID before there is anything to store.
 * Minting one with `uuidgen` produces something the contract schema refuses, and
 * inventing one by hand produces something that sorts wrongly — prefixed ULIDs
 * sort lexicographically by time, which is what makes them usable as range keys.
 *
 * Every prefix in `ID_PREFIXES` is offered rather than just `prog`: the table is
 * the authority on what identifiers exist, and a command that knew about a
 * subset of it would be a second, staler copy.
 */
import type { IdPrefix } from "@nightshift/contracts";
import { ID_PREFIXES } from "@nightshift/contracts";
import type { CliEnvironment } from "../environment.js";
import { UsageError } from "../failures.js";

const isIdPrefix = (value: string): value is IdPrefix =>
  (ID_PREFIXES as readonly string[]).includes(value);

export const mintId = (environment: CliEnvironment, prefix: string): string => {
  if (!isIdPrefix(prefix)) {
    throw new UsageError(
      `\`${prefix}\` is not a Nightshift identifier prefix`,
      `Known prefixes: ${ID_PREFIXES.join(", ")}.`,
    );
  }
  const id = environment.ids.next(prefix);
  environment.out(id);
  return id;
};
