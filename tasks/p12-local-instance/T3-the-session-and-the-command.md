# T3 — The session and the command

**Program:** `p12-local-instance`
**Depends on:** T2
**Unblocks:** T5
**Decisions applied:** D-P12-01, D-P12-05, D-P12-08

## Objective

The CLI and the MCP server hold one profile per stage, switch between them
without a browser, and start the local instance.

## Deliverables

1. **Profiles per stage** in `persistence/http/session`: `ProfileSchema` gains
   `auth: { kind: "cognito", authDomain, clientId } | { kind: "token", path }`
   (the flat `authDomain`/`clientId` accepted on read and rewritten on write);
   paths `profilesDir()`, `profilePath(stage)`, `credentialsPath(stage)`,
   `currentStagePath()`; `readProfile()`/`requireProfile()` resolve the current
   stage; `writeProfile` makes its stage current; `createTokenProvider`
   dispatches on `auth.kind`, the `token` kind reading the file on each mint
   (cheap, and a rotated secret is picked up). **Migration**: on first read, a
   flat `profile.json` and `credentials.json` are moved under
   `profiles/<stage>/` and `current` written; tested against a captured pre-P12
   layout on POSIX and Windows paths.
2. **`nightshift use <stage>`**: sets `current` to a stage that has a profile,
   refuses one that does not, prints what it switched to. `whoami` prints the
   current stage and its auth kind.
3. **`nightshift local [--port] [--state] [--no-open]`**: resolves the bin and
   the Studio dist from the CLI's assets (`apps/api/bin/nightshift-local.js`,
   `apps/studio/dist`; "this build does not carry it" when absent, as `init`
   says of the skills); spawns it with `--no-warnings=ExperimentalWarning`,
   stdio inherited; once the bin prints its URL, writes the `local` profile
   (`apiEndpoint`, `auth: { kind: "token", path }`), makes it current, prints
   the URL and opens the browser unless `--no-open`; on exit restores nothing
   (the profile stays; `nightshift use dev` switches back). `login`'s `--stage`
   writes and selects that stage's profile.
4. **The MCP server** reads the current profile through the same module; a
   worker's environment is unchanged (endpoint and execution token).
5. Tests: `use` and `login` over a temp config dir; the token provider over a
   token profile; `local` over a fake bin (the CLI tests inject `exec`); the
   migration.

## Acceptance

- SC-P12-07 proven offline; `nightshift local` starts the T2 bin end to end in
  one CLI test with the real bin from `dist`.
