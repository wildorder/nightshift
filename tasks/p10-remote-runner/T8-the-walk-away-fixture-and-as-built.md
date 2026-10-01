# T8 — The walk-away fixture and as built

**Program:** `p10-remote-runner`
**Depends on:** T5, T6, T7; H-P10-06 (satisfied)
**Unblocks:** program close
**Decisions applied:** all; SC-14, SC-15, SC-16

## Objective

One command proves the program's exit gate on real infrastructure against the
disposable repository, cleans up after itself, and reports what it could not.
The documents say what was built.

## Deliverables

1. **The fixture repository's content** (`test/fixtures/remote-fixture/`,
   pushed to `wildorder/nightshift-remote-fixture` by the script's first step
   when the repository is empty or behind): a small Node 24 project with a
   lockfile, `nightshift.config.json` with `npm ci --prefer-offline` as setup
   and `npm test` as verification, and a ratified program under
   `docs/programs/remote-fixture/` with three strands small enough to run in
   minutes, one of them classified so the routing ladder sends a job to
   AgentCore on Bedrock. The plan is ratified by the script through the API
   as the fixture org's user.
2. **`npm run remote`** (`scripts/remote.mjs` + `apps/api/src/smoke/remote.smoke.ts`),
   opt-in, never in CI, refuses outside the v1 account:
   1. onboards a fixture org through the product's own path: `org github
      install --installation <id>` (the real installation 166952409) and `org
      providers set` for both providers, reading the keys from the operator's
      environment (`NIGHTSHIFT_SMOKE_ANTHROPIC_KEY`, `NIGHTSHIFT_SMOKE_OPENAI_KEY`),
      never from the repository;
   2. dispatches on `good`, asserts the printed tier, class and price;
   3. kills the CLI process and drops the network path (the script simply
      exits the child and continues from a second process with no handle);
   4. waits for `running`, then `kill -9` the runner over SSM and asserts
      recovery under the same run id and `generation 2`;
   5. waits for the next landing, then terminates the instance and asserts
      recovery again (`generation 3`), with the stale-write event present if
      the old runner got a word in;
   6. waits for the run to end; asserts the fixture repository's program
      branch head equals `publication.head`, that every landed commit is on
      it, and that no other ref was pushed;
   7. asserts `ComputeUtilization` exists with samples, the snapshot is in
      `WarmCache`, and the dispatch is `stopped` with empty `cleanup.failures`;
   8. runs a second dispatch and asserts SC-P10-08's warm ratio;
   9. runs a third, then `compute recommend` answers with evidence;
   10. cancels a fourth mid-run and asserts `stopped` within two heartbeat
       intervals of the cancel;
   11. cleanup: every instance, volume and snapshot tagged with the fixture id
       is removed, the fixture org's credentials deleted, the program branches
       on the fixture repository deleted; what could not be removed is listed
       at the end and the script exits non-zero if the list is not empty.
   `--keep` leaves the last run's volume for inspection.
3. **Regression**: `npm run verify`, `npm run check:architecture`, `npm run
   local:e2e`, `npm run conformance -- --harness all`, `npm run smoke`, `npm
   run slice`, `npm run routing`, `npm run correction` all green on the
   program branch; a local run and a remote run of the fixture produce the
   same canonical records apart from the `Dispatch` and the
   `ComputeUtilization` (a script diffs the two record sets by kind and
   asserts the difference is exactly those, SC-P10-14).
4. **Documents**: `docs/programs/p10-remote-runner.md` §15 as built (what a
   later program needs and cannot derive: the measurement table from T2, the
   subscription record from T5, the generation rule, the volume layout, the
   credentials path, the fixture's cost per run); `staging.md`'s P10 row to
   closed with the date; `architecture.md`: A-51 written (EC2 and EBS per run,
   A-14 struck through with the pointer), O-03, O-05 and O-06 struck through as
   resolved; `AGENTS.md` gains the "As built for P10" paragraph in the style of
   P11 … P14 and its `--remote` sentence updated; `docs/vision.md`'s remote
   row names EC2; the `plan-program` and `run-program` skills mention
   `--remote` and `--compute`.
5. **Prices revisited**: the first three live runs' metered cost is written
   beside D-P10-19 and the owner asked whether $300 and $50 stand.

## Acceptance

- `npm run remote` passes end to end with an empty could-not-remove list, and
  its log is attached to the program's closing commit message by path.
- Every SC-P10 row in §7 is marked proven with the task that proved it.
- The owner has dispatched one real program of their own with `--remote`,
  closed the laptop, and read the result; that is the program's close.
