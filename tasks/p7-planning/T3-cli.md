# T3 — The CLI: `init`, `plan check`, `plan ratify`, `preflight`, config

**Program:** `p7-planning`
**Depends on:** T1
**Unblocks:** T4
**Decisions applied:** D-P7-02, D-P7-03, D-P7-05, D-P7-07

## Deliverables

1. **`nightshift.config.json`**: `projectId`, `visionPath`, `contextDocs`,
   default `verification`, `modelPolicy`, `delegationLimits`, `costPolicy`. A
   program's contract inherits what it does not state.
2. **`nightshift init`**: creates the project if the config names none, writes
   the config (detecting verification commands from `package.json` scripts and
   asking), installs the skills, registers the MCP server for the directory at
   local scope, and says what it did. Idempotent. `--yes` for no questions.
3. **`nightshift plan check {id}`**: reads `docs/programs/{id}/`, splits the plan
   into strand sections, runs `checkPlan`, prints `READY` or every reason. The
   exit code is the answer.
4. **`nightshift plan ratify {id}`**: refuses unless `READY`; refuses a plan with
   uncommitted changes, because the hash has to name something git can
   reproduce; uploads `plan.md`, then records the hash with the document's
   reference; prints what was ratified. If the upload fails, nothing is ratified.
5. **`nightshift preflight {id}`**: runs every pending `verifyCommand` as a
   subprocess with the verification runner's sanitised environment and a
   timeout, records each result, and prints the remediation for each failure.
6. `nightshift run {id}` resolves a program id to its directory (T4 makes it run
   end to end). `nightshift run <contract path>` keeps working.
7. Tests over a temporary repository for each command, on both CI legs.
