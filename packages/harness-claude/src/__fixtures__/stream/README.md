# Stream fixtures for measurement decoding

None of these is a verbatim recording. Each is **hand-built from recorded
shapes**: the frame layout of the 2.1.273 recording in `../claude-stream-success.jsonl`
plus the 2.1.286 usage semantics (`modelUsage` and `total_cost_usd` are whole-tree
session totals, restored on `--resume` since 2.1.277; assistant messages repeat one
`message.id` for parallel tool calls; the `<synthetic>` assistant frame after an
auth failure). They are sanitized: placeholder ids and paths, no prompt text, and
tool inputs/outputs reduced to short placeholders. The `claude_code_version` they
carry (`2.1.286`) is the version whose semantics they follow, not a recording's.

| Fixture | Provenance | Shows |
|---|---|---|
| `subagent.jsonl` | hand-built | `parent_tool_use_id` frames (one id repeated), `task_started`, two models in `modelUsage` |
| `compaction.jsonl` | hand-built (`compact_boundary` schema as in the stream test) | assistant/result frames after a compaction |
| `resumed.jsonl` | hand-built | `modelUsage` far larger than the turn's own `usage`, as a resumed session restores |
| `interrupted.jsonl` | hand-built from the recorded `aborted_streaming` shape | `is_error: true`, `error_during_execution`, non-empty `modelUsage` |
| `no-result.jsonl` | hand-built | a stream that ends with no `result` frame |
| `auth-failure.jsonl` | hand-built | `<synthetic>` assistant frame, then a zeroed result with empty `modelUsage` |

No fixture here was recorded on 2.1.286.
