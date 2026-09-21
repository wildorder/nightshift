# T5 — The engine: dependency gating, parking, `awaiting_human`

**Program:** `p7-planning`
**Depends on:** T1, T2
**Unblocks:** T6, T7
**Decisions applied:** D-P7-10

## Deliverables

1. The engine takes the ratified plan. `submit` carries a workstream id; a node
   whose dependencies have not integrated stays `queued` with a `waitingFor` of
   `dependencies` naming them, alongside P6's `parent_full` and
   `wall_clock_spent`.
2. **Parking**: when a workstream settles without integrating and its retries
   are spent, the engine computes `blockedBy`, cancels the cone's queued nodes
   with a reason naming the blocker, emits `workstream.parked` and
   `workstream.blocked`, and keeps scheduling everything else.
3. **`awaiting_human`**: a node whose prerequisite is `pending` at start time
   goes there instead of starting; a later preflight that satisfies it requeues
   it.
4. `JobContract.dependencies` is written from the plan, so the record says what
   the engine enforced.
5. Tests over the fake harness and real git: dependency order is never violated
   under any finishing order (property test over random DAGs and finish orders);
   a failed workstream parks exactly its cone; `awaiting_human` blocks exactly
   its cone.
