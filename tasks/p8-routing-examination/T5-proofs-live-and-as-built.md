# T5 — Fixture proofs; the live suite; the exit gate's trial; as-built

**Program:** `p8-routing-examination`
**Depends on:** T4
**Decisions applied:** SC-P8-01 … SC-P8-18

## Deliverables

1. **`test/src/routing/`**: one test per success criterion SC-P8-01 …
   SC-P8-15 (with SC-P8-12a), through the real MCP server binary, engine, merge queue and git with
   the scripted harness, reading the control plane. **SC-P8-14's fixture** runs one
   program under two org configurations and asserts the two different paths, with
   no code between them.
2. **`npm run routing`** (`scripts/routing.mjs`), opt-in, never in CI. A
   **preflight** first: every route on the org's ladders answers a one-line prompt
   headless, and a failing one is named. Then, with real Claude Code and Codex
   against the deployed control plane: a bounded job on the cheap rung
   integrates; a job whose cheap attempt fails verification climbs and integrates;
   a pinned override; a route marked unavailable falls back across ladders; a
   medium-risk job examined by a different model; a high-risk job examined by the
   Codex ladder, with a **planted defect** the examiner finds with evidence and a
   fix removes before it lands; an examiner's question answered by the builder's
   resumed session; a disputed finding ruled on by an arbiter, its checkpoints
   recorded. Each
   phase prints its routes, cost and timings.
3. **The owner's org** set to §4.2's ladders with `nightshift org config set`,
   read back.
4. `npm run smoke` twice, `npm run conformance -- --harness all`,
   `npm run slice`, to show P4 … P7 still hold.
5. **The trial** (SC-P8-18), on the repository the owner names (H-P8-04): plan a
   program with `plan-program`, ratify, run with the owner's org configuration,
   to a report. Record per rule how often the cheap rung reached verified, what
   escalated, what examinations found and what the arbiter ruled, and the cost.
6. **As-built** in the contract §13: task states; the SC table; what changed in
   earlier suites and why; the trial's numbers; build decisions for ratification.
   `AGENTS.md` conventions and as-built; `docs/architecture.md` entries for the
   lasting decisions (D-P8-02/03, D-P8-06/07, D-P8-09, D-P8-13) on ratification;
   the stale "P7" references to routing in P5's and P6's contracts get a note.
7. PR into `v1`.

## Notes

- The live suite's planted defect must be one the candidate verification does
  **not** catch (a contract clause the tests do not exercise), or the examiner is
  proving nothing.
- The measure of the trial is the owner's: did the ladders save anything, and
  were the findings worth the time.
