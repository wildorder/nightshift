# T6 — Claude to v1, `configuredRoute`, `delegate { harness }`, the composition switch

**Program:** `p4-harness-neutrality`
**Depends on:** T1, T2
**Unblocks:** T7
**Decisions applied:** D-P4-01, D-P4-05, D-P4-06; A-13, A-31

## Objective

Bring the existing adapter and the surrounding machinery to version 1, and make
harness choice a matter of configuration.

## Deliverables

1. **Claude adapter to v1**: `capabilities { workspace: "local", usage: true }`;
   `usage` from the `result` frame's `usage.input_tokens`, `output_tokens` and
   `total_cost_usd` on the exit. No other behaviour changes.
2. **Execution layer**: the runner passes `tools` and `mcp`; writes `usage` and
   the terminal `outcome` to the routing decision after exit (T2's table);
   applies `finishRun` on `run.finish` and on shutdown. Tests for each write and
   for the 409 path.
3. **Worker MCP role** calls `WorkerTools` (T1) rather than `worker.ts`
   directly, so the two transports share one path.
4. **`configuredRoute`** in `packages/routing`: provider order from
   `modelPolicy.allowedProviders`; provider→harness map `anthropic → claude`,
   `openai → codex`, `bedrock → agentcore`; model from the policy or a
   documented per-provider default; `delegate { harness?, model? }` honoured
   within policy and recorded with `wasOverride`; typed refusals for a provider
   the program does not allow and a harness that does not exist. Rule id
   `p4-configured`. `fixedRoute` is removed; its tests move.
5. **Composition root**: one `switch` over `claude | codex | agentcore`,
   constructing only the adapter the route chose; the scripted-harness module
   injection stays. The architecture negative fixture proves no other file
   names an adapter, and AR-2 now lists all three implementation packages.
6. **`delegate`** gains `harness`; the skill documents it in one sentence.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

## Notes

- Routing still does no cost reasoning. If a change here starts to look like
  P6, stop.
- Constructing only the chosen adapter matters: a machine without Codex should
  run a Claude job without the Codex adapter complaining about a missing
  binary.
