# T2 — Stamping decisions, and the report's decision graph

**Program:** `p9-decision-graph-replay`
**Depends on:** T1
**Unblocks:** T3
**Decisions applied:** D-P9-01, D-P9-06, D-P9-08

## Objective

Every decision is tied to the commits it produced, and the report shows every
decision a run made: its alternatives, its class, what it produced, whether it
was reversed.

## Deliverables

1. **Stamping a job's decisions.** When the merge queue integrates a node, the
   engine lists the decisions made on that node and, for each without
   `produced`, sets `checkpointAfter` to the landing's checkpoint and `produced`
   to the commit the queue actually landed (after replay onto the head, never the
   worker's snapshot).
2. **Stamping a strand's or sub-program's decisions.** When a sub-program node
   completes, each decision made on it is stamped with the commits its subtree
   landed after the decision's `checkpointBefore`, in landing order.
3. **Stamping plan decisions.** At run end (`run.finish`, attended or not), each
   plan decision the run recorded is stamped with what the strands it `touches`
   landed (all strands for `touches: "all"`).
4. A decision whose node never landed stays unstamped; the report says "produced
   nothing that landed".
5. **The report's decision graph**: a section listing every decision of the run,
   grouped by where it was made (plan, strand, job, ruling), each with its
   alternatives and why they were rejected, its class, its produced commits
   (short sha and subject), and, when superseded, the reversing decision and the
   correction that followed (from any contract whose `corrects` names it).
6. **`nightshift report <program> [--run <id>]`** regenerates `report.md` from the
   control plane, so the original report shows a reversal after the fact.
7. Tests over real git: a job's decision stamped with exactly its landed commit;
   a rebased job stamped with the rebased commit; a strand's decision with its
   subtree's commits after it and none before; a plan decision with its touched
   strands' commits; an unlanded node's decision unstamped.

## Acceptance

- SC-P9-01, SC-P9-02 and SC-P9-10 proven offline.
- Stamping never blocks a landing: a failure to stamp is recorded and the landing
  stands.
