# T3 — The Codex adapter

**Program:** `p4-harness-neutrality`
**Depends on:** T1
**Unblocks:** T7
**Decisions applied:** D-P4-02, D-P4-09; D-P3-09, D-P3-15

## Objective

Implement version 1 of the contract for Codex in `packages/harness-codex`, the
same shape as the Claude adapter with Codex's command line, stream grammar and
sandbox.

## Deliverables

1. **Launch.** `codex exec --json <brief> -C <worktree> --sandbox
   workspace-write --approve-for-me --ephemeral --ignore-user-config
   --skip-git-repo-check -m <model>`, with the worker MCP server supplied as
   `-c mcp_servers.nightshift.command=… -c mcp_servers.nightshift.args=[…]
   -c mcp_servers.nightshift.env={…}` from `input.mcp`, unchanged. Environment
   sanitised as the Claude adapter does. Verify every flag against the
   installed 0.149.0 and record the exact command line in a comment.
2. **Hook channel** from the JSONL events: session start → `agent.started`;
   each tool or command invocation → `tool.called` / `tool.completed` with the
   tool name and a bounded summary; the final event → the ending. Record which
   event kinds carry which mapping, and which contract events have no Codex
   source (if any, configure a Codex hook or state that the property cannot be
   met and stop).
3. **Exit mapping** as a table, measured: a clean final message is
   `completed`; non-zero exit or no final message is `failed`; a signal is
   `interrupted`; `cancel` is `cancelled`. Check whether an interrupted
   `codex exec` exits 0, as Claude does, before trusting the exit code.
4. **Permissions**: `workspace-write` plus `--approve-for-me`; no git write
   command approved; `fs.read` alone maps to `read-only`.
5. **Transcript** to the given path; `usage` from the stream's token counts
   where present, `capabilities.usage` set accordingly.
6. **Tests without Codex**: a recorded stream from one real headless run of the
   completing fixture, checked in; parser and mapping tested against it; launch
   arguments against a fake spawn; cancel escalation with a fake process.
7. T1's conformance suite runs against this adapter only when
   `NIGHTSHIFT_CONFORMANCE_HARNESS=codex`, otherwise skipped by name.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

`packages/harness-codex` depends on `contracts`, `core` and `harness`; no
`openai` import.

## Notes

- Codex reads `$CODEX_HOME` for authentication. Pass it through; pass nothing
  else from the operator's environment.
- The ChatGPT login is the operator's. Nothing here moves it (D-P4-09).
