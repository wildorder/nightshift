# Fixtures

## codex-rollout-measured.jsonl

A sanitized Codex session rollout measured on codex-cli 0.155.1: two launches
of one thread. The first is a two-request turn with a shell tool call; the
second is a resume (`thread_settings_applied`, then a new `task_started`) with
one request.

Produced by running the real `codex` binary against a loopback fake Responses
provider that answers with synthetic usage counts (input/cached/cache-write/
output/reasoning): 1007/500/0/41/10, 2007/1000/0/42/20, and 1007/500/0/41/10 on
the resume. The thread totals are therefore 3014 input after the first launch
and 4021 after the resume.

Sanitized afterwards: every message, instruction, tool-call argument and
output text is replaced by `<text omitted>`, the working directory and
`world_state` lines are dropped, rate limits are dropped, and ordinals are
renumbered from 0. No counts were altered.

## Regenerating

`NIGHTSHIFT_MEASUREMENT_FIXTURES=write npx vitest run packages/harness-codex/src/probe-offline.test.ts`
re-runs the offline probe (the real `codex` against a loopback provider, a
temporary `CODEX_HOME`) and rewrites `codex-rollout-measured.jsonl`,
`codex-otlp-journal-launch1.jsonl`, `codex-otlp-journal-launch2.jsonl` and
`codex-otlp-cancelled.jsonl` through `sanitizeRolloutLine` / `sanitizeJournalLine`,
plus `docs/programs/p20-measurements/codex-capability-offline.json`. It asserts
that every committed line type and attribute key is still present, and that a
sentinel prompt appears in nothing written.

A regenerated rollout keeps the original ordinals (a `world_state` line becomes a
placeholder rather than being dropped) and fresh ids and timestamps, and the
journal fixtures carry the conversation id Codex generated. The committed
fixtures are referenced by id and ordinal in `rollout.test.ts`, `telemetry.test.ts`
and `capture.test.ts`, so a regeneration is followed by updating those
expectations. `codex-otlp-retry.jsonl` is hand-built (a scripted provider does
not make Codex retry) and is never regenerated.
