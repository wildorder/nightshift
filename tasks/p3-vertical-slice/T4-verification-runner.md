# T4 — The verification runner

**Program:** `p3-vertical-slice`
**Depends on:** nothing
**Unblocks:** T5
**Decisions applied:** D-P3-06; A-05, A-08

## Objective

Run a Program Contract's verification steps deterministically and produce the
per-step evidence a `Verification` record is built from. `packages/verification`
knows how to run commands and capture output; it does not know about nodes,
worktrees, git or S3. The execution layer (T5) supplies the directory and does
something with the logs.

## Deliverables

1. `packages/verification/src/`:
   - `runVerificationSteps({ steps, cwd, env, timeoutMs, spawn?, sink })` →
     `StepResult[]`: for each `VerificationStep` in order, `stepId`, `command`,
     `exitCode`, `durationMs`, and the captured combined output as bytes. Steps
     run sequentially; a failing step does not stop the rest, because the
     contract's `commands` array records every step and a reader wants to know
     whether the lint failed as well as the tests.
   - Commands run through the platform shell (`sh -c` / `cmd /c`) with the
     given `cwd` and a sanitized environment: `PATH`, `HOME`, the platform
     essentials, plus what the caller adds. Never the parent's whole
     environment, which holds the operator's tokens.
   - A per-step timeout that kills the process tree and records a non-zero
     exit code and `timed_out: true`, never a hang.
   - `sink` receives output chunks as they arrive, for later streaming; the
     buffered result is what P3 uses.
   - `toVerificationCommands(results, logArtifactIds)` → the `commands` array
     for a `Verification`, and `outcomeOf(results)` → `passed | failed`, so the
     schema's cross-check (passed requires every exit code zero) is computed in
     one place.
2. Tests with an injected spawn and with real processes (`node -e`): a passing
   sequence; a failing middle step still runs the last; a timeout; output larger
   than the inline event bound is captured whole; the environment passed to a
   step does not contain a variable the test planted in `process.env`; Windows
   and POSIX shells both run a command containing quotes.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```

`packages/verification` depends on `@nightshift/contracts` and
`@nightshift/core`. It may import Node builtins; it is not a pure package.

## Notes

- This package produces evidence; it does not decide anything about a node. The
  `Verification` record's writer is the execution layer (D-P3-06), and the rule
  that turns a record into `verified` is in `core`. Keep those three apart.
- Environment sanitization is a real boundary, not hygiene: a verification step
  is whatever the Program Contract says, and the contract is human-authored
  data in a target repository.
- Process-tree killing on timeout differs by platform. Test it on both; CI does.
