# T3 — Examination

**Program:** `p8-routing-examination`
**Depends on:** T1, T2
**Unblocks:** T4
**Decisions applied:** D-P8-09, D-P8-10, D-P8-11, D-P8-12, D-P8-13, D-P8-14, D-P8-15

## Objective

Verified work whose risk warrants it is examined by an independent examiner,
beside the merge queue, against evidence; a material finding goes back to the
orchestrator that delegated the job; a dispute under a blocking policy goes to an
arbiter; the owner can reverse the arbiter.

## Deliverables

1. **When**: `examinationRequired(classification, effectivePolicy)` in `core`.
   `assertExaminable`'s refusal is retired.
2. **Beside the queue** (D-P8-09, `packages/execution`): when a node that needs
   examining reaches `implemented`, the execution layer verifies its snapshot in
   a clean checkout of the snapshot commit (the P3 verification runner, a
   `Verification` of its own marked `phase: candidate`), then starts an examiner.
   The node stays `implemented` and does not enter the merge queue until its
   examination has passed or its findings are resolved. A candidate verification
   that fails is the job's failure (`verification_failed`), as it would have been
   in the queue. Concurrency: examiners take slots from the same parent limit as
   workers.
3. **The examiner** (D-P8-10, D-P8-11): route chosen by T1's `mayExamine` over the
   effective policy (another ladder when `mustDifferProvider`; the frontier tier at
   high risk); its own agent and execution token (`role: examiner`);
   `NIGHTSHIFT_ROLE=examiner` registers `examination.ask` and `examination.submit` only; a detached
   checkout of the snapshot commit. Its brief (`packages/harness`): the Program
   and Job Contracts, the diff, the changed tests, the candidate verification's
   results and logs, the interfaces the scope touches. **Not** the worker's
   summary, transcript or commit message; a test asserts none of them appears.
   The report goes to S3 as an artifact.
4. **Questions to the builder** (D-P8-15). `examination.ask { questions }`: at
   most three, once per examination. Each adapter records the builder's session
   id on its agent record (Claude's `session_id` from its init frame, Codex's
   thread id) and gains an optional capability, `answer(sessionId, questions,
   checkoutPath)`, which resumes that session in a read-only detached checkout
   of the builder's snapshot with a brief that says only answer. When the
   capability is absent or the resume fails, the execution layer starts the
   builder's route fresh with the saved transcript and the questions. The answer
   records which. The examiner's tool call returns the answers; the examination
   stores them. The conformance suite gains an `answer` case for both adapters.
5. **Carry-over** (D-P8-09): the examination records the diff's
   `git patch-id --stable`. In the queue, after verification on the head, a node
   whose replayed diff has the same patch id goes `verified → examining → sealed`
   at once, citing the examination; a different patch id is examined again, in
   the queue, before `sealed`.
6. **Findings to the orchestrator** (D-P8-13). Advisory: findings are recorded,
   returned by `job.wait`, and the node proceeds to the queue. Blocking: an
   examination with material findings ends the node `examination_failed`; `job.wait` returns the findings
   with their evidence. `job.retry` carries them into the next attempt's brief (a
   fix, climbing per T2); the engine refuses a third fix of the same job (the
   count is `fixAttempt`, read from the record). A new tool, `finding.dispute { examinationId, findingId,
   reason }`, for the root and sub-orchestrators.
7. **The arbiter** (D-P8-13): under `blockOnMaterialFindings`, a dispute, or a
   material finding still standing after the second fix, starts an arbiter: frontier tier, a model neither side used (a third provider's ladder if
   the org has one), chosen by `mayArbitrate`; `role: arbiter`;
   `NIGHTSHIFT_ROLE=arbiter` registers `finding.rule` only; given the finding, its
   evidence, the examiner's questions and answers, any dispute, and the diff. **Overturned**: the finding is resolved and
   the node proceeds to the queue. **Upheld**: the node fails and its strand parks
   with its cone (P7). Each ruling is a `Decision`, authority `agent`, by the
   arbiter's agent, naming the finding, with `checkpointBefore` a checkpoint of
   the program head before the ruled work could land and, for an overturn,
   `checkpointAfter` the checkpoint once it has. The run moves on either way.
   Under a non-blocking policy a dispute
   stands and is recorded, with no arbiter.
8. **Reversal**: `nightshift ruling reverse <decisionId> --reason …` writes a
   `human` decision superseding the arbiter's. It is recorded and reported and
   replays nothing (D-P8-13; replay is P9). The CLI says so when it runs, and
   prints the `checkpointBefore` ref to reset to by hand.
9. **Deferral** (D-P8-14): a node with deferred checks is examined at `resume`,
   after its deferred checks pass, before it lands.
10. Events: `examination.requested`, `examination.completed`, and new
   `finding.disputed` and `finding.ruled`, with the writer rules of A-30.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

Offline, with the scripted harness: an examiner that passes, one that raises a
material finding with evidence, one whose finding has none (refused), an
advisory finding that lands, questions answered from a resumed session and from
a transcript, a fix that passes re-examination, a third fix refused, a finding
standing after two fixes sent to the arbiter, a dispute overturned, a dispute upheld (strand parked), a
carry-over, and a replay that changes the patch and is examined again.

## Notes

- The scripted harness gains `examine pass|finding|no-evidence|ask`, `answer`, and
  `rule overturn|uphold` scripts, tagged like P7's `orchestrate`.
- If this task runs long, it is the split point staging names: T1 and T2 can
  close as their own program.
