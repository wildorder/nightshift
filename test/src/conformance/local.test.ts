/**
 * The local adapter (P12, D-P12-02) against the same port conformance suite the
 * memory and AWS adapters pass: `createInMemoryStores` over SQLite tables.
 */
import { createLocalStores } from "@nightshift/persistence/local";
import { describeLinePortConformance } from "./line-ports.js";
import { describePortConformance } from "./persistence-ports.js";

describePortConformance(
  "local (SQLite)",
  (clock) => createLocalStores({ file: ":memory:", now: clock.now }),
  {
    identity: (stores) => stores,
    seedLegacyRun: (stores, run) => stores.seedRunWithoutMarker(run),
  },
);

describeLinePortConformance("local (SQLite)", (clock) =>
  createLocalStores({ file: ":memory:", now: clock.now }),
);
