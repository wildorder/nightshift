# T6 — Deploy, the live two-principal proof, as-built

**Program:** `p4-identity-and-tenancy`
**Depends on:** T4, T5
**Unblocks:** the exit gate
**Decisions applied:** all; SC-P4-11

## Deliverables

1. Deploy both stacks. The data stack gains the key and the client; the API
   stack swaps the authorizer. Confirm the operator's existing `nightshift login`
   session still works against the new authorizer before anything else.
2. `npm run smoke`, twice. `npm run slice` with the real Claude worker: the
   worker completes the P3 fixture job holding only an execution token; read
   its `Agent` and events back and confirm the writer was the execution
   principal.
3. As-built in the contract §12: task states, the key type chosen and why, the
   authorizer's measured latency, the smoke matrix results, the SC table; on
   ratification, `architecture.md` A-19 amended in place, the A-21 and A-27
   non-guarantee text retired with a pointer to this program, A-33 … A-36
   added; `AGENTS.md` short form.

## Acceptance

```sh
npm run verify
AWS_PROFILE=nightshift npm run deploy -- --require-approval never
AWS_PROFILE=nightshift npm run smoke
npm run slice
```
