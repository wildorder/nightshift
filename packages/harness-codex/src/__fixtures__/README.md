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
