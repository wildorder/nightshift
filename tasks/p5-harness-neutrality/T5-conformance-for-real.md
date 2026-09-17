# T5 — Conformance for real, slice axis, as-built

**Program:** `p5-harness-neutrality`
**Depends on:** T3, T4
**Unblocks:** the exit gate
**Decisions applied:** D-P5-03; SC-P5-17

## Objective

Run the shared suite through both adapters against the deployed control plane,
extend the slice suite's harness axis, and record what it cost in time and
tokens.

## Deliverables

1. `npm run conformance [--harness …]`: account guard; materialise the fixture;
   for each adapter, the three fixture jobs through the real orchestrator-role
   server against the deployed plane; §4.2 asserted from the control plane;
   cleanup; a table of wall clock and, where reported, tokens per adapter and
   job.
2. Run it for `claude` and `codex`. Twice, for cleanup.
3. `npm run slice` accepts `codex` for its real-harness phase and runs the
   completing fixture through it.
4. `npm run smoke`, twice, against the redeployed stack.
5. **As-built** in the contract §13: every task's state and location; the two
   command lines as they actually ran; the per-adapter table; anything the
   first real Codex worker did that the brief had to be changed for; the SC
   table discharging SC-P5-01 … SC-P5-17; `AGENTS.md` conventions; on
   ratification, `docs/architecture.md` entries for D-P5-01 and D-P5-04.

## Acceptance

```sh
npm run verify
AWS_PROFILE=nightshift npm run smoke
npm run conformance -- --harness all
npm run slice
```

## Notes

- Expect the first real Codex worker to surface brief problems the scripted
  harness cannot, as the first Claude worker did in P3. Each is a brief or
  enforcement change and a §12 entry, never a suite edit.
- Do not run two conformance suites at once; the fixture ids are deterministic.
