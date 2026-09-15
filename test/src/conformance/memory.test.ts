/**
 * The in-memory adapter against the shared conformance suite, in both numbering
 * modes.
 *
 * The deferred run is the one that matters for P2: it holds the in-memory adapter
 * to the same timing the DynamoDB adapter has, where `append` returns an
 * unnumbered event and the Streams consumer numbers it later (A-22, D-P2-16). The
 * smoke suite wires the same suite, unchanged, to the AWS adapter.
 */
import { createInMemoryStores } from "@nightshift/persistence/memory";
import { describePortConformance } from "./persistence-ports.js";

describePortConformance("in-memory", () => createInMemoryStores());

describePortConformance(
  "in-memory, deferred sequencing",
  () => createInMemoryStores({ deferSequencing: true }),
  {
    settle: (stores) => {
      stores.materializeSequences();
    },
  },
);
