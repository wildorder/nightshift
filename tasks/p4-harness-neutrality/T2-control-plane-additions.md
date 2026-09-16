# T2 — Control-plane additions: download URL, routing-decision table, `finishRun`

**Program:** `p4-harness-neutrality`
**Depends on:** nothing
**Unblocks:** T5, T6
**Decisions applied:** D-P4-03, D-P4-06; A-05, A-08, A-13

## Objective

Three small, bounded changes to the API and `core` that the adapters and the
exit gate need, each with its rule in `core` and its route covered by the smoke
suite.

## Deliverables

1. **`GET …/artifacts/{artifactId}/download-url`**: a presigned S3 `GET` for an
   existing `Artifact`'s key, expiring in minutes. The function gains
   `s3:GetObject` on the bucket's objects, for signing only, beside the `PUT`
   from P3; the assertion test that pins the S3 action set grows by exactly one
   action and says why. Response shape in `contracts` `api.ts`.
2. **`ArtifactKind`** gains `workspace` and `workspace-result`.
3. **Routing-decision update semantics** (D-P4-06): a table in
   `packages/core/src/rules/routing-transitions.ts`: `usage` may be set once
   when the stored value is `{}`; `outcome` may move from `pending` to any
   terminal value and never again; every other field is immutable. `PUT
   …/routing-decisions/{id}` applies it; a second identical `PUT` is a 200; a
   change the table forbids is a 409.
4. **`finishRun`** in `core`: given a run's terminal status, the program node's
   terminal status (`integrated`, `failed`, `cancelled` per D-P4-06). The
   execution layer's `run.finish` and shutdown apply it; `PUT node` accepts the
   resulting transition because the table already allows `running → failed |
   cancelled` and adds `running → integrated` **for program nodes only**, with a
   test that a job node still cannot take that edge.
5. **Smoke**: the download URL round trip (upload, sign a download, fetch, bytes
   equal); a routing decision updated with usage then refused a second change;
   a run finished with its root node ending `integrated`.
6. Redeploy happens with T4's, once.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run check:architecture
```

Then, with T4: `npm run deploy`, `npm run smoke`, twice.

## Notes

- `finishRun` is a rule about program nodes only. Do not let it touch a job
  node's lifecycle; A-05's path through `verified` is for jobs and stays.
- The presigned `GET` is the same posture as the `PUT`: a signature the function
  can only issue because its role holds the action. It does not read an
  object.
