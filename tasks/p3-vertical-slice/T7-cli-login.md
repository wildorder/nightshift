# T7 — The CLI: login, run, and project bootstrap

**Program:** `p3-vertical-slice`
**Depends on:** T3
**Unblocks:** T10
**Decisions applied:** D-P3-01, D-P3-12, D-P3-17; A-16, A-19, A-32; P2 T9 notes

## Objective

Give the operator a way to sign in, to authorize a run, and to create a project,
in `apps/cli`, as a thin client. This is the interactive login P2 deferred: authorization code with
PKCE against the interactive app client, using the loopback redirect the data
stack already reserves.

## Deliverables

1. `nightshift login --api <url> --auth-domain <domain> --client-id <id>
   [--stage dev]`: writes `profile.json` (T3), starts a loopback listener on
   port 47821, opens the browser at the Cognito authorize endpoint with a PKCE
   challenge and the scopes `openid email profile` plus the resource-server
   scope, receives the code at `/callback`, exchanges it at `/oauth2/token`,
   stores the refresh token and the subject in `credentials.json`, and prints
   the signed-in email. Flags are remembered in the profile, so a second login
   needs none. If the browser cannot be opened, print the URL.
2. `nightshift logout`: deletes the credentials file. Revoking at Cognito is a
   nice-to-have; say whether it was done.
3. `nightshift whoami`: subject and email from a freshly minted ID token, and
   the org resolution as the control plane sees it (`GET /projects` succeeds or
   returns the typed refusal, which is printed verbatim).
4. `nightshift project create --name <name>`: mints a `proj_` id, `PUT`s the
   project through the http adapter, prints the id. The org comes from the
   token (D-P2-13); the CLI never sends one.
5. `nightshift run <contract> [--repo <path>]` (D-P3-17): validates the authored
   Program Contract, `PUT`s the program, creates the run (`pending`), its root
   node and the initial checkpoint through the same execution-layer function
   the MCP `run.start` uses (T6 exports it; the CLI must not reimplement it),
   and prints the run id with one line telling the operator to open their
   orchestrator in the repository so the Nightshift MCP server can attach.
   `--remote` is accepted and refused with "remote execution arrives in P8", so
   the flag's shape exists from day one. Nothing is spawned.
6. `nightshift id <prefix>`: prints a fresh identifier for any prefix in
   `ID_PREFIXES`, so a human can author a program contract with a stable
   `programId`.
7. Argument parsing with `node:util` `parseArgs`; no CLI framework. A `bin`
   (`nightshift`) running from `dist`.
8. Tests: the PKCE flow with an injected `fetch` and an injected browser
   opener, driven end to end by the test posting to the loopback listener; the
   profile and credentials files written with the right permissions; each
   command's output against the local control plane. The layer table gains
   `core` and `persistence` for `apps/cli` (D-P3-12), and the architecture
   negative fixture proves `apps/cli` still cannot import `./aws`.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
```

Then, by hand, once H-P3-02 has been satisfied:

```sh
nightshift login --api https://4xnsx809u6.execute-api.us-west-2.amazonaws.com \
  --auth-domain nightshift-dev-755348349819.auth.us-west-2.amazoncognito.com \
  --client-id <InteractiveClientId from the data stack outputs>
nightshift whoami
nightshift project create --name slice-demo
nightshift run ./nightshift.program.json
```

The manual check is recorded in the as-built (T10), with the subject it
produced and the project id.

## Notes

- Port 47821 is fixed by the data stack (`LOOPBACK_CALLBACK_URL`); do not choose
  a port at runtime. Fail clearly if it is taken.
- The listener accepts exactly one request, checks `state`, and closes. It
  binds to `127.0.0.1`, not `0.0.0.0`.
- Cognito's authorize endpoint for a pool domain is
  `https://<domain>/oauth2/authorize`; the interactive client has no secret, so
  the token exchange sends `client_id` in the form body and no `Authorization`
  header. The T3 token provider already does the refresh half.
- No domain, routing or execution logic here (A-16). `nightshift run` calls one
  exported function that does the control-plane writes; if it needs anything
  from `@nightshift/execution` beyond that, the seam is in the wrong place. The
  layer table gains `execution` for `apps/cli` only if that function lives
  there; prefer exporting it from a package the CLI already references.
