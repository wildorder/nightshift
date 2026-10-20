# Nightshift's gate standard

Optional troubleshooting guidance for repository checks, also used by the
examiner of an explicitly delegated repair. These are not planning readiness
requirements: no audit or certification is required before work can start.

Nightshift runs every gate in a fresh checkout nobody is watching: the landing
gates on every job, the gates declared `at: "end"` once on the program head
when the run finishes. A gate that only passes on the developer's machine, or
on the second try, or after another gate has run, fails the run at 3 a.m. and
lands nothing.

The rules are numbered, and a finding names its rule by number. **The numbers
never change.** The standard is short on purpose: report what breaks a run or
will, not matters of taste. A finding is worth the human's attention only if it
leads to a fix they would want, or to a "leave it" they should know they chose.

## 1. Declares setup

**Means.** Installs and code generation are the contract's `setup`, never
folded into a gate or a pre-hook. Setup runs once per checkout and is skipped
when nothing changed; a gate runs on every verification.

**Check.** Read `nightshift.config.json` / the contract's `setup` and
`verification`, and every package script a gate calls, with its `pre`/`post`
hooks. The mechanical audit notes lockfiles committed with no setup. Smells:
`pretest: npm ci`, `prebuild: npm install`, a check that runs `codegen` first,
a gate that installs only when `node_modules` is missing.

**Typical fix.** Move the install or codegen into `setup` and delete it from
the hook or script.

## 2. Passes on a fresh checkout of the base

**Means.** With setup, in the gate order, every gate passes on the base commit
in a checkout with nothing else in it.

**Check.** Run `nightshift gates {id}`; it does exactly this. Any red gate is a
finding. Read what it said: a missing file nobody commits, an env var only the
developer's shell sets, a step that only CI's image provides.

**Typical fix.** Repair the failure within authorized work, or commit (or
generate in setup) what it was missing. A gate that cannot be
made to pass is removed from verification only with the human's answer, and the
plan says what checks its ground instead.

## 3. Is hermetic

**Means.** No gate reads what an earlier run, another gate or the developer's
machine left behind. Two gates never write different builds to one output
folder.

**Check.** Read the build and test configs for their output and cache
directories (`outDir`, `dist`, `.next`, `coverage`, a test runner's cache).
Smells: two gates writing one output folder (an e2e build and the production
build both into `dist`), a test that reads a fixture another test writes, a
path under the home directory, a global tool assumed installed.

**Typical fix.** Give each build its own output folder; generate fixtures in
the test that needs them; install the tool as a dependency.

## 4. Declares outside dependencies

**Means.** Docker, a database, a network service or a credential is a
prerequisite (`HP-nn`) with a `verifyCommand`, and each verification step that
needs it says `requires`.

**Check.** Read the test setup and the gate scripts for what they connect to:
`docker compose`, `testcontainers`, a database URL, an HTTP endpoint, a cloud
SDK, a token in the environment. Smell: any of these needed with no
prerequisite and no `requires`.

**Typical fix.** Add the prerequisite with a headless `verifyCommand`
(`docker info`, `pg_isready -h …`) and `requires` on the step; or make the
suite start what it needs itself (an in-memory or containerised service the
gate owns).

## 5. Is deterministic

**Means.** No sleeps or timing races, no reliance on test order, no unseeded
randomness, and no fixed ports shared between gates or between parallel tests.

**Check.** Search the tests for `sleep`, `setTimeout` waits, `Date.now()`
assumptions, `Math.random()` without a seed, hard-coded ports (`:3000`,
`listen(8080)`), and shared state between test files. If the mechanical run
failed once and passed when repeated, it is this rule.

**Typical fix.** Wait on a condition, not a clock; fake time; seed the random
source; listen on port 0 and read the port back; isolate the shared state.

## 6. Can be kept healthy by the work

**Means.** A registry or allow-list that new work must extend (a suite list, a
route table a test enumerates, a lint allow-list, a snapshot index) is one the
plan knows about: the strands that extend it say so, and do not extend it at the
same time.

**Check.** For each gate, ask what a new module, test or route has to be added
to before the gate counts it or lets it pass. Smell: that registry lies outside
every strand's planned paths (`scripts/test-suites.json` when the strands are
planned in `src/**`), so nothing tells the work it must be extended and the gate
fails, or silently skips the new work; or strands that run at once all extend it,
and conflict.

**Typical fix.** Name the registry in the planned paths of the strands that
extend it, and order them; or replace it with discovery by convention (a glob)
so there is nothing to extend.

## 7. Costs what it should

**Means.** One verification's time, multiplied by `maxConcurrency`, is said out
loud in the plan. Every job is verified on a clean checkout with every landing
gate; a gate that proves the whole program runs at the end (rule 9).

**Check.** Read the verification plan `nightshift gates {id}` prints: each
step's measured duration, how long it was quiet before its first output, and
what a landing costs. Smells: one landing gate dominating the total, work
repeated across gates (a build each gate redoes), a whole-repository run where
the tool can be told what to cover, a gate quiet for a minute or more before
it says anything (a service starting on every verification). A step measured over 80% of its
`timeoutSeconds` (absent, 600), or killed by it, is one a slower night will fail.

**Typical fix.** Make the gate cheaper without making it check less: move
shared work into setup, stop gates repeating each other's build, use the
tool's own caching or parallelism. A service a gate needs (a database, a
broker) is the project's to keep alive across verifications, with each
verification given state of its own: a database created from a template named
by a hash of the migrations, named for the verification by
`NIGHTSHIFT_VERIFICATION_ID`, dropped afterwards. State keyed by content, never
by the last run. A step measured over 80% of its timeout, or killed by it, gets
`timeoutSeconds` from the measurement (about 1.5 times it, at most 7200); a step
that creates something outside the checkout gets `cleanupSeconds` for its
teardown (at most 3600). The fix is the contract edit `nightshift gates`
prints. Or lower `maxConcurrency`. Never drop a check from
verification or run it for some strands only to save time: every landing is
verified against every landing gate, and that is what keeps unverified work
from integrating.

## 8. Declares its runtimes

**Means.** The repository pins every language runtime it uses, in one file
per runtime (`.nvmrc`, `.node-version`, `.tool-versions` or `package.json`'s
`volta`/`engines` for Node; `.python-version`; `.ruby-version`;
`.go-version`; `.java-version`; `rust-toolchain.toml`; and so on), and the
gates are audited on those versions.

**Check.** `nightshift gates {id}` prints this rule's findings mechanically
(via `resolvePins`): a runtime the repository plainly uses with no pin
(`package.json` and nothing pinning Node, `pyproject.toml` and nothing
pinning Python, `go.mod` and no `.go-version`, and so on); pins that disagree
(naming both files and the versions); and a runtime on the auditing machine
that does not satisfy its pin, or is not installed.

**Typical fix.** Add the pin file; reconcile pins that disagree; install the
pinned version on the machine that is missing it or running another. A
remote run's machine installs the pinned versions itself; the laptop's runtime
is not a remote dispatch prerequisite.

## 9. Proves the whole at the end

**Means.** A gate that proves the program rather than a job — an end-to-end
suite against a built, migrated system — is declared `"at": "end"`. It runs
once, on the program head, when the run finishes as succeeded, and again after
each fix that lands; never per job. The gates that catch a job's own mistakes
(build, typecheck, lint, unit) stay landing gates.

**Check.** Read what each landing gate resolves to. A browser-driven or
end-to-end runner (Playwright, Cypress, WebDriver) on every landing is a
finding. Time alone is not: a slow unit suite is a slow landing gate, not a
whole-system gate.

**Typical fix.** Set `"at": "end"` on the step in the program contract. The
gate audit before the run still runs it.
