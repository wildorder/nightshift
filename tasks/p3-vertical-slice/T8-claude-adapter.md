# T8 — The Claude Code adapter

**Program:** `p3-vertical-slice`
**Depends on:** T1
**Unblocks:** T10
**Decisions applied:** D-P3-03, D-P3-09, D-P3-15; source plan "Harness Architecture", "Hooks and Telemetry"

## Objective

Implement T1's `Harness` for Claude Code in `packages/harness-claude`, driving
the installed CLI headless as a child process in the worktree, with the Nightshift
MCP server configured and the P3 lifecycle events produced from the process
itself. Everything Claude-specific lives here.

## Deliverables

1. **Launch.** `start` spawns `claude` with, at minimum: `-p` with the rendered
   worker brief (T1's helper, plus anything Claude-specific), `--output-format
   stream-json` with the verbosity the stream needs, `--mcp-config <file>`
   naming the worker MCP server from `input.mcp` (command, args, env including
   the seven identity variables), `--model` from the route target, a permission
   configuration derived from `scope.permissions` (deliverable 3), and session
   persistence off. Working directory is the worktree. The environment passed
   to the child is sanitized the way T4 sanitizes verification steps: Claude
   needs its own auth from the operator's machine, which it finds itself; it
   does not need the parent's variables. Verify every flag against the
   installed 2.1.272 (`claude --help`) and record the exact command line in a
   comment; flags drift between releases and the comment is what a future
   upgrade diffs against.
2. **Hook channel** (D-P3-09). Parse the structured stream and emit through the
   `HookSink`: `agent.started` on the initial system message, `tool.called` /
   `tool.completed` per tool use and result with the tool name and a bounded
   summary in the payload, `agent.subagent_created` when a sub-agent tool is
   invoked, `agent.context_compacted` when the stream reports a compaction, and
   `agent.completed` on the final result. Where the stream does not carry an
   event the contract lists, configure a Claude hook through a settings file
   that appends to a local hook log the adapter tails; do not skip the event
   and do not ask the worker to report it. State in the module comment which
   events came from which mechanism.
3. **Permissions** (D-P3-15). Map `fs.read` to read-only tools, `fs.write` to
   edit and write tools, `shell.exec` to the shell tool, and always exclude git
   write commands from the shell allowance. Run with permission prompts resolved
   by this policy and never by a human; a tool the policy does not allow is
   denied, not escalated. Record the exact flags.
4. **Exit and cancel.** Map the process exit to `HarnessExit`: zero with a
   result message is `completed`; non-zero is `failed { exitCode }`; a signal
   is `interrupted { signal }`; a `cancel` sends the cooperative stop the CLI
   honours, then SIGTERM, then SIGKILL after the grace, and settles as
   `cancelled`. On Windows, document what a kill looks like (no signal, exit
   code 1) and return `failed`.
5. **Transcript.** The raw stream is written to the agent's transcript path
   under the state directory as it arrives, and named on the handle so T5
   uploads it.
6. **Tests without Claude.** Record a real stream from one headless run of the
   fixture job (T9's repository) and check the recording in as a fixture. Test
   the parser and the event mapping against it, and the launch arguments
   against a fake spawn. Cover: the mapping of every lifecycle event; a stream
   that ends without a result is `failed`; the permission mapping for every
   subset of the vocabulary; cancel escalation timing with a fake process.
7. **T1's conformance test** runs against this adapter with the real CLI only
   when `NIGHTSHIFT_SLICE_HARNESS=claude` is set; otherwise it is skipped with
   a message, never silently passed.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

`packages/harness-claude` depends on `@nightshift/contracts`, `@nightshift/core`
and `@nightshift/harness`. No `@anthropic-ai/*` import: the adapter drives the
CLI, not the API. Only `apps/mcp`'s composition module may import this package
(T6).

## Notes

- The stream format is the ground truth the hook channel rests on. If an event
  the contract requires cannot be produced from either the stream or a hook
  without the worker's cooperation, stop and surface it; D-P3-09 is the
  invariant, not the mechanism.
- Model names: pass through what routing chose. Do not maintain a list of
  Claude models here; the policy on the Program Contract is where allowed
  models live.
- The worker brief must tell the model to call `job.complete` when done and
  `job.fail` when stuck, and that its edits are collected by Nightshift, not by
  committing. That text is shared through T1's helper; add here only what is
  Claude-specific (how tools are named to it, for example).
