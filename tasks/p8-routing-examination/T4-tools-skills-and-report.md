# T4 — Orchestrator tools, skills, configuration commands, the report and the export

**Program:** `p8-routing-examination`
**Depends on:** T2, T3
**Unblocks:** T5
**Decisions applied:** D-P8-01, D-P8-02, D-P8-03, D-P8-13; SC-P8-13, SC-P8-15

## Objective

What an orchestrator and a human touch: how a job is classified, how the org's
policy is set, what the report says, and the dataset.

## Deliverables

1. **Tools**: `delegate` and `strand.delegate` take the classification and the
   pins, each described so an orchestrator can classify honestly (what
   `testability: strong` means, and that leaving a field unset is the
   conservative choice, not the cheap one).
2. **`nightshift org config get | set <file> | edit`** in `apps/cli`, calling
   the API; `set` shows the refusal reasons when the policy is invalid.
   `nightshift init` no longer writes routing into the repository; it writes a
   config that inherits the org's, and says which org policy it inherits.
3. **Skills**: `nightshift` (classify a job; what a finding is; fix or dispute),
   `plan-program` (a strand's risk is the plan's to state; examination follows
   from it), `run-program` (arbiter rulings are read first; how to reverse one).
   The skill tests hold each to the tool names and fields.
4. **The report** (`packages/execution/src/report.ts`): **arbiter rulings first**,
   each with what reversing it means before P9; then per strand the routes tried
   and why (rule, ladder, rung, effort, fallbacks, escalations), cost with
   estimates labelled, each examination and its findings with their resolution;
   a run total against the budgets.
5. **`nightshift routes export <runId> | --project <id>`**: JSON Lines, one per
   routing decision, self-contained (D-P8-01 … D-P8-08 fields, the effective
   policy version, the verification and examination outcomes of the attempt).
   A schema for the line in `contracts`, so a consumer can validate it.
6. `run.activity` and `job.wait` lines for routing (`routed`, `unavailable`,
   `escalated`) and examination (`examining`, `finding`, `disputed`, `ruled`).

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

## Notes

- The CLI stays thin (A-16): the report is gathered by `execution`, the export
  reads the API, and `org config` validates with `contracts`, not its own rules.
