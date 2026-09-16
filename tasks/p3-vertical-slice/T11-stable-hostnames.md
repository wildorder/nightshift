# T11 — Stable hostnames and a zero-flag login

> **Built 2026-09-16, narrowed by the owner.** The Cognito custom domain
> (deliverable 3, the `edge` stack and the placeholder `A` record) was dropped:
> the derived pool domain is already stable, and the branded name would have
> cost a second-region certificate, cross-region references and custom-resource
> Lambdas. The hosted zone landed in an unstaged account-wide `nightshift-dns`
> stack rather than the data stack, and the CLI restates the hostname rule
> rather than importing it from `contracts`. Contract §12 and §13.11 record
> the reasons and the result.

**Program:** `p3-vertical-slice` (see `docs/programs/p3-vertical-slice.md`)
**Depends on:** T7, T10 (everything is built and deployed; this changes how it is reached)
**Unblocks:** the close of P3
**Decisions applied:** D-P3-18, D-P3-16; A-16, A-17, A-19, A-24

## Objective

Give Nightshift hostnames it owns, so the CLI can ship them as defaults and
`nightshift login` takes no flags, and so the API and data stacks can be
replaced beneath those names without breaking an installed CLI.

## Why this is P3's

The exit gate's last leg, a human logging in from a second machine, needed a
three-flag command whose values are CloudFormation outputs a user has no way to
know. Worse, the `--api` value is a hostname API Gateway generated, which
D-P2-07 explicitly allows us to throw away with the API stack. T7 shipped a
login that only a developer can run and that a redeploy can break. That is a
defect in a P3 deliverable, and P4's theme is harnesses, not DNS.

## Design

```text
wildorder.dev                          zone in the wildorder management account
 └─ nightshift.wildorder.dev           NS → the four nameservers below   (H-P3-05, human)
      zone in the Nightshift account, data stack, RETAIN
      ├─ dev.nightshift.wildorder.dev          A  (placeholder; Cognito requires the parent to resolve)
      ├─ api.dev.nightshift.wildorder.dev      A/AAAA alias → API Gateway custom domain
      ├─ auth.dev.nightshift.wildorder.dev     A alias → Cognito custom domain (CloudFront)
      └─ _acme…                                CNAMEs for certificate validation
```

The stage is in the hostname from the start (D-P3-18), so a later `prod` is a
new pair of records and a one-constant change to the CLI's default stage. The
hostname rule is one function, shared by CDK and the CLI through
`@nightshift/contracts` so the two cannot drift:
`api.<stage>.nightshift.wildorder.dev`, `auth.<stage>.nightshift.wildorder.dev`.

## Deliverables

1. **Hosted zone**, in the data stack: `nightshift.wildorder.dev`, public,
   `RemovalPolicy.RETAIN`, exported nameservers as a stack output so H-P3-05
   can be done from the console output. Also the placeholder `A` record at
   `<stage>.nightshift.wildorder.dev`: Cognito refuses a custom domain whose
   parent has no `A` record. Say so in a comment where the record is declared,
   because it looks pointless.
2. **API custom domain**, in the api stack: an ACM certificate for
   `api.<stage>.…`, DNS-validated against the zone (same account, so validation
   records are written automatically); an API Gateway v2 `DomainName` with an
   `ApiMapping` to the `$default` stage; an alias record. The generated
   `execute-api` endpoint stays and the smoke suite keeps using it, because it
   is reachable before delegation is. Export the custom hostname beside
   `ApiEndpoint`.
3. **Cognito custom domain**, in the data stack: `auth.<stage>.…`. Two things
   only a deploy would otherwise teach:
   - Cognito fronts the hosted UI with CloudFront, so its certificate **must be
     in `us-east-1`**. The data stack is in `us-west-2`. Use a small
     `nightshift-<stage>-edge` stack in `us-east-1` holding that certificate,
     with `crossRegionReferences: true` on both stacks so the ARN crosses
     regions through CDK's own mechanism rather than a hand-copied string. It
     is stateless, so no termination protection; its cert is DNS-validated
     against the same zone.
   - The custom domain's parent must resolve (deliverable 1).
   The alias record targets the domain's CloudFront distribution. The
   pool-domain from P2 (`nightshift-<stage>-<account>`) stays, so the existing
   sign-in URL keeps working during the switch.
4. **Exports and templates**: `AuthDomain` and `HostedSignInUrl` (P2 T9, P3
   T2) now name the custom domain; the invitation template (D-P3-16) does too;
   `npm run admin:user` prints the new URL.
5. **The hostname rule** as `controlPlaneHostnames(stage)` in
   `@nightshift/contracts` (pure, no dependency), used by both stacks and the
   CLI. Tested once, there.
6. **CLI defaults** (`apps/cli`): `DEFAULT_STAGE = "dev"`; with no stored
   profile and no flags, `login` derives the API endpoint and auth domain from
   the rule and uses a shipped `DEFAULT_INTERACTIVE_CLIENT_ID`. `--stage`
   selects another deployment; `--api`, `--auth-domain`, `--client-id` still
   override for developers and are moved under a "developer flags" heading in
   the usage text. The profile records what was resolved, as today. A profile
   that holds a generated `execute-api` or `amazoncognito.com` hostname is
   rewritten to the stable one on the next login, with a line saying so.
7. **CDK assertion tests**: the zone is retained; the placeholder record
   exists; each certificate's domain matches the rule; the API mapping targets
   `$default`; the edge stack is in `us-east-1`; the P2 assertion that every
   route carries the authorizer is unchanged.
8. **Smoke**: phase 1 gains the custom hostname: no token → 401, valid token →
   200, through `api.<stage>.…`, and a TLS handshake that presents a
   certificate for that name. Skipped with the reason in its name until the
   `NS` record exists (`dig NS nightshift.wildorder.dev` answers).
9. **Docs**: the exit-gate recipe in the contract §13.4 becomes
   `nightshift login`; the P2 and P3 environment tables gain the hostnames;
   `AGENTS.md` gains the hostname convention; the P3 as-built §13.10 records
   T11 and closes the program.

## Sequencing, because delegation is a human step

```text
deploy data + edge stacks  ─►  read NameServers output  ─►  H-P3-05: NS record in wildorder.dev (human)
        │                                                          │
        └── the certificates sit PENDING_VALIDATION until here ◄───┘
                                                                   │
                                                deploy api stack ◄─┘  (custom domain needs an issued cert)
                                                                   │
                                          smoke; nightshift login on both machines
```

Deploy the data and edge stacks first: CloudFormation will wait on
`PENDING_VALIDATION` certificates, so **do not** include the certificates in
that first deploy, or it hangs for the delegation. Land the zone and its
nameserver output, do H-P3-05, confirm `dig NS nightshift.wildorder.dev` from a
public resolver, then deploy the certificates and domains.

## Acceptance

```sh
npm run build && npm run typecheck && npm run lint && npm test
npm run synth                     # three stacks now
AWS_PROFILE=nightshift npm run deploy -- --require-approval never
AWS_PROFILE=nightshift npm run smoke
```

Then, on a machine with no `profile.json`, macOS and Windows (SC-P3-18):

```sh
nightshift login
nightshift whoami
```

Both succeed with no flags, and `profile.json` names
`api.dev.nightshift.wildorder.dev`, not `execute-api`.

## Notes

- Nothing here changes a route, a record shape, the execution layer, or a
  harness. If a diff touches `packages/execution` or `apps/mcp`, stop.
- The Nightshift credentials cannot see the wildorder account, by design
  (A-17). The `NS` record is the human's; write the exact four values into the
  contract's as-built when it is done.
- Cognito custom domains take up to fifteen minutes to become active after
  creation and CloudFormation returns before that. Budget for it, and check
  `describe-user-pool-domain` for `ACTIVE` before the smoke run.
- Keep the P2 pool domain. Deleting it would break the sign-in URL the operator
  already has, for nothing.
