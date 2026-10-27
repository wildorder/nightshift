/**
 * The in-memory adapter against the shared conformance suite, in both numbering
 * modes.
 *
 * The deferred run is the one that matters for P2: it holds the in-memory adapter
 * to the same timing the DynamoDB adapter has, where `append` returns an
 * unnumbered event and the Streams consumer numbers it later (A-22, D-P2-16). The
 * smoke suite wires the same suite, unchanged, to the AWS adapter.
 *
 * The in-memory adapter implements both halves of the split (T2), so it supplies
 * `identity` and the identity section runs.
 */
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describePortConformance } from "./persistence-ports.js";

describePortConformance("in-memory", (clock) => createInMemoryStores({ now: clock.now }), {
  identity: (stores) => stores,
  seedLegacyRun: (stores, run) => stores.seedRunWithoutMarker(run),
});

describePortConformance(
  "in-memory, deferred sequencing",
  (clock) => createInMemoryStores({ deferSequencing: true, now: clock.now }),
  {
    identity: (stores) => stores,
    seedLegacyRun: (stores, run) => stores.seedRunWithoutMarker(run),
    settle: (stores) => {
      stores.materializeSequences();
    },
  },
);
