/**
 * The local adapter (P12, D-P12-02) against the same port conformance suite the
 * memory and AWS adapters pass: `createInMemoryStores` over SQLite tables.
 */
import { createLocalStores } from "@nightshift/persistence/local";
import { describePortConformance } from "./persistence-ports.js";

describePortConformance("local (SQLite)", () => createLocalStores({ file: ":memory:" }), {
  identity: (stores) => stores,
});
