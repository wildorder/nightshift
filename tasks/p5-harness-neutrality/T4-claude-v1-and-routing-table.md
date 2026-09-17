# T4 — Claude to v1, the compatibility table, `delegate { harness, model }`, the composition switch

**Program:** `p5-harness-neutrality`
**Depends on:** T1, T2
**Unblocks:** T5
**Decisions applied:** D-P5-01, D-P5-04, D-P5-05, D-P5-06; A-13, A-31

## Objective

Bring the existing adapter and the surrounding machinery to version 1, and make
harness and model a configured choice from a compatibility table.

## Deliverables

1. **Claude adapter to v1**: `capabilities { usage: true }`; `usage` from the
   `result` frame's `usage.input_tokens`, `output_tokens` and `total_cost_usd`
   on the exit. No other behaviour changes.
2. **Execution layer**: the runner passes `tools` and `mcp`; writes `usage` and
   the terminal `outcome` to the routing decision after exit (T2's table);
   applies `finishRun` on `run.finish` and on shutdown. Tests for each write and
   for the 409 path.
3. **Worker MCP role** calls `WorkerTools` (T1) rather than `worker.ts`
   directly, so the two transports share one path.
4. **`HARNESS_COMPATIBILITY`** in `packages/routing`: per harness, the providers
   and model families it can run and how each authenticates (§4.3 of the
   contract). The `agentcore` row is present with an empty implementation
   marker so P9 fills a row rather than changing a shape.
5. **`configuredRoute`**: the Program Contract's model policy intersected with
   the table; `delegate { harness?, model? }` honoured within the intersection
   and recorded with `wasOverride`; otherwise the first compatible pair in the
   policy's provider order; typed refusals for a provider the program does not
   allow, a harness the table does not know, and a harness/model pair the table
   says is incompatible. Every option considered is recorded. Rule id
   `p5-configured`. `fixedRoute` is removed; its tests move.
6. **Composition root**: one `switch` over `claude | codex`, constructing only
   the adapter the route chose; the scripted-harness module injection stays.
   The architecture negative fixture proves no other file names an adapter,
   and AR-2 lists `@nightshift/harness-codex` beside `-claude`.
7. **`delegate`** gains `harness` and keeps `model`; the skill documents both in
   one sentence and says the contract decides.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

## Notes

- Routing still does no cost reasoning. If a change here starts to look like
  P7, stop.
- Constructing only the chosen adapter matters: a machine without Codex should
  run a Claude job without the Codex adapter complaining about a missing
  binary.
