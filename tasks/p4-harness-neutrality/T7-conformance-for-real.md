# T7 — Conformance for real, slice axis, as-built

**Program:** `p4-harness-neutrality`
**Depends on:** T3, T5, T6
**Unblocks:** the exit gate
**Decisions applied:** D-P4-04, D-P4-07; SC-P4-18

## Objective

Run the shared suite through all three adapters against the deployed control
plane, extend the slice suite's harness axis, and record what it cost.

## Deliverables

1. `npm run conformance [--harness …]`: account guard; materialise the fixture;
   for each adapter, the three fixture jobs through the real orchestrator-role
   server against the deployed plane; §4.3 asserted from the control plane;
   cleanup; a table of wall clock, tokens and cost per adapter and job.
2. Run it for `claude`, `codex`, `agentcore`. Twice, for cleanup.
3. `npm run slice` accepts `codex` and `agentcore` for its Claude phase's
   harness, and runs the completing fixture through each.
4. `npm run smoke`, twice, against the redeployed stack.
5. **As-built** in the contract §13: every task's state and location; the three
   command lines or invocations as they actually ran; the T4 spike's answers;
   the per-adapter table; anything the first real Codex or AgentCore worker
   did that the brief had to be changed for; the SC table discharging
   SC-P4-01 … SC-P4-18; `AGENTS.md` pins and conventions; on ratification,
   `docs/architecture.md` A-33 … A-35.

## Acceptance

```sh
npm run verify
AWS_PROFILE=nightshift npm run smoke
npm run conformance -- --harness all
npm run slice
```

## Notes

- Expect the first real Codex and AgentCore workers to surface brief problems
  the scripted harness cannot, as the first Claude worker did in P3. Each is a
  brief or enforcement change and a §12 entry, never a suite edit.
- Do not run two conformance suites at once; the fixture ids are deterministic.
