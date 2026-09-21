# T4 — The CLI: `init`, `plan check`, `plan ratify`, `preflight`, config

**Program:** `p7-planning`
**Depends on:** T1, T2
**Unblocks:** T6
**Decisions applied:** D-P7-01, D-P7-02, D-P7-06, D-P7-07

## Deliverables

1. **`nightshift.config.json`**: `projectId`, `visionPath`, `contextDocs`,
   default `verification`, `modelPolicy`, `delegationLimits`, `costPolicy`. A
   manifest inherits what it does not state.
2. **`nightshift init`**: creates the project if the config has none, writes the
   config (detecting verification commands from `package.json` scripts and
   asking), installs the skills, registers the MCP server for the directory at
   local scope, and says what it did. Idempotent. `--yes` for no questions.
3. **`nightshift plan check {id}`**: reads the manifest and specs, runs
   `checkPlan`, prints `READY` or every reason. Exit code is the answer.
4. **`nightshift plan ratify {id}`**: refuses unless `READY`; refuses a dirty
   plan (uncommitted manifest or specs); records the hash; prints what was
   ratified.
5. **`nightshift preflight {id}`**: runs every pending `verifyCommand` as a
   subprocess with the verification runner's sanitised environment and a
   timeout, records each result, prints the remediation for each failure.
6. `nightshift run {id}` resolves a program id to its manifest (T6 makes it run
   end to end).
7. Tests over a temporary repository for each command, both CI legs.

## Notes

- Ratify refuses a dirty plan because the hash has to name something git can
  reproduce.
