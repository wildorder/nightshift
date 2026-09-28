# T3 — `decision reverse`, `decision brief`, and the correction

**Program:** `p9-decision-graph-replay`
**Depends on:** T1, T2
**Unblocks:** T5
**Decisions applied:** D-P9-02, D-P9-03, D-P9-04, D-P9-05, D-P9-06

## Objective

The owner reverses any decision with one verb, gets a brief a planner can start
from, plans the correction in `plan-program`, and runs it like any program, with
an irreversible reversal confirmed first.

## Deliverables

1. **`nightshift decision reverse <program> <decisionId> --choice <new> --reason
   <why> [--run <id>]`**: finds the decision in the program's runs, records a
   superseding `human` decision through `overrideDecision` (which already refuses
   softening the class or an agent overriding a human), prints the reversed
   decision's class, and the next step: `nightshift decision brief …`, then
   `plan-program` in correction mode. `ruling reverse` becomes this verb (its P8
   tests still pass).
2. **`nightshift decision brief <program> <decisionId> [--out <path>]`**: markdown,
   from the control plane and the repository alone:
   - the original decision (context, alternatives and why each was rejected,
     choice, rationale, class, where it was made: plan, strand or job);
   - the reversing decision and its reason;
   - `checkpointBefore`, and the commits it produced with the files each touched
     and its subject;
   - every later commit on the program branch, with files;
   - the plan section of its strand, or the plan decision's text;
   - the run's report;
   - later decisions on the same strand or naming it;
   - a flag when the class is `compensatable` or `irreversible`.
   Default path `docs/programs/<new-id>/brief.md` when `--for <new-id>` is given.
3. **`plan-program` correction mode** (the skill): when asked to correct a
   decision, read the brief first; plan the change the new decision calls for,
   wherever it reaches, not only the produced commits; write `corrects` into the
   contract; say in the plan what the correction keeps, changes and why; carry a
   compensatable reversal's compensation as a human prerequisite. The template
   and `plan check` accept it.
4. **The irreversible flag and confirmation** (D-P9-05): `plan check` reports
   each `corrects` entry whose decision is `irreversible` or `compensatable` as a
   flag (not a failure); `nightshift run` refuses a correction with an unconfirmed
   irreversible reversal, naming it, until `--confirm-irreversible <decisionId>`,
   which records the confirmation (T1) before the run starts.
5. **The report links** (D-P9-06): a correction's report opens with what it
   corrects (the decision, the reversal, the original run); the decision graph
   (T2) shows a reversed decision's correction.
6. The `nightshift` and `run-program` skills say how to read the decision graph
   and how to reverse a decision.
7. Tests through the real CLI against the real handler: reversing a plan
   decision, an orchestrator's decision and a ruling; the brief's sections; a
   correction contract checked, ratified and refused when it names an
   unreversed decision; `run` refusing then accepting an irreversible reversal.

## Acceptance

- SC-P9-03 … SC-P9-07 proven offline.
