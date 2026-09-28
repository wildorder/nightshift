# T4 — The run page

**Program:** `p11-studio`
**Depends on:** T1, T2
**Unblocks:** T5
**Decisions applied:** D-P11-05, D-P11-06, D-P11-07, D-P11-10

## Objective

A run page that says what happened, from the control plane alone, and keeps up
while the run is under way.

## Deliverables

1. **The report's views**, from `gatherReport` in `core`: the header (program,
   objective, run status, started, ended, outcome); rulings first when there
   are any, as the markdown report leads with them; strands with outcome,
   acceptance, blockers, attempts, what they wait on, and their departures;
   success criteria met or not and by which strands; pending prerequisites;
   usage by harness, model and purpose with tokens, cost, `estimated` and
   `unpriced` shown as the report shows them; corrections when the program is
   one.
2. **Jobs**: per strand and for the unplanned run alike: objective, status,
   attempts, commit, reason; routes in order with tier, rung, target, outcome
   and usage (`RoutingDecision`); verifications by node with phase, outcome,
   and each command's step, command, exit code, duration, deferral and log;
   examinations with route, blocking, findings (severity, summary, evidence,
   resolution), questions and answers, rulings followed, and the report artifact.
3. **The tree and agents**: nodes from `node.list` as a tree by `parentNodeId`
   (kind, depth, status, scope summary, commit), each with its agents
   (`agent.listByNode`: role, harness, provider, model, status, exit code,
   reason, times). Checkpoints listed.
4. **The timeline**: events ordered by `orderEvents`, with type, source, node,
   agent, time and a payload summary (the `activity.ts` phrasing in `apps/mcp` is
   the reference for what each type says); large payloads open their artifact.
5. **Artifacts**: transcripts, build and verification logs, examination reports
   and diffs opened through `artifact.createDownloadUrl` in a viewer or a new
   tab; size and content type shown before fetching.
6. **Polling** (D-P11-05): while `run.status` is live, `event.list` with
   `afterSequence` of the last numbered event seen, on an interval of a few
   seconds; each new event invalidates the queries for the records it names
   (node, agent, verification, examination, routing decision, decision,
   checkpoint, artifact, the run) and appends to the timeline; stops when the
   run settles. Events with `sequence: null` are never counted as seen.
7. Tests over memory stores with the P6 tree fixture and the P8 and P9 fixtures:
   the page renders every record class; appending an event while mounted (fake
   timers) updates the timeline and the named record within one interval.

## Acceptance

- SC-P11-03, SC-P11-04 (offline half) and SC-P11-05 (offline half) proven.
- The page over the tree fixture makes the same reads `nightshift report`
  makes, plus the artifact and event reads; counted in a test so growth is seen.
- `npm run verify` green.
