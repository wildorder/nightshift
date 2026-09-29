#!/usr/bin/env node
/** `nightshift-local`: the local instance of the control plane (P12, D-P12-01). */
import { main } from "../local/main.js";

main(process.argv.slice(2), process.env).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
