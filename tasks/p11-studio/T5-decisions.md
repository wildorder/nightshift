# T5 — Decisions

**Program:** `p11-studio`
**Depends on:** T4
**Unblocks:** T6
**Decisions applied:** D-P11-08, D-P11-10

## Objective

The decision graph is readable in the Studio, and a decision is reversed from
it exactly as the CLI reverses one, with the correction's next step shown.

## Deliverables

1. **The graph**: from `gatherDecisionGraph` in `core`: every decision placed
   (plan, run, strand, job, ruling), with context, alternatives and why each was
   rejected, choice, rationale, class, authority, `checkpointBefore` and
   `checkpointAfter`, `produced` commits, and its reversal when there is one,
   with the correction that followed. Close calls are visible: alternatives are
   not hidden behind a click.
2. **A decision's page**: the above for one decision, with the node and agent it
   was made on and the events around it.
3. **Reverse**: a form with the new choice and the reason, both required; the
   record built by `reversalOf` (T1) with an id from `core`'s id generator and
   the browser clock, written with `decision.put` as the CLI writes it; refused
   before the form for a decision that is itself a reversal (`mayReverse`) or
   already reversed, with the CLI's messages. Afterwards the page shows the
   reversal in the graph and the next step: the `nightshift decision brief`
   command for this program and decision, and one sentence that the correction
   is planned with the owner in a session (D-P9-04).
4. Tests: the record written from the page is deep-equal to the CLI's for the
   same inputs (both over memory stores, the same clock and ids); the refusals;
   the graph over the P9 correction fixture shows the reversal and its
   correction.

## Acceptance

- SC-P11-07 proven offline.
- `npm run verify` green.
