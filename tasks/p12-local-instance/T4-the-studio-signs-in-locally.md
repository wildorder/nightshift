# T4 — The Studio signs in locally

**Program:** `p12-local-instance`
**Depends on:** —
**Unblocks:** T5
**Decisions applied:** D-P12-04

## Objective

The Studio's startup selects its session from `config.json`: Cognito as in
P11, or a token from the start URL for a local instance.

## Deliverables

1. **`StudioConfigSchema`** gains `auth: { kind: "cognito", authDomain,
   clientId } | { kind: "token" }`; a config with the flat `authDomain` and
   `clientId` and no `auth` is read as cognito (the deployed `config.json`
   until the stack is redeployed). `hostnames.ts`'s defaults are cognito.
2. **`auth/token-session.ts`**: reads `token` from `location.hash`, stores it in
   `sessionStorage` under one key, replaces the URL without the fragment,
   provides it as the bearer; with no fragment and nothing stored, shows a page
   saying to open the URL `nightshift local` printed. Identity: `subject` and
   `email` `local-operator`, org from the projects list as today. Sign-out
   clears `sessionStorage` and shows that page.
3. **`main.tsx`** composes either session; everything below `App` is unchanged.
4. **The hosted stack** writes `auth: { kind: "cognito", authDomain, clientId }`
   into `config.json` beside the existing keys (a stack test pins it); no other
   infrastructure change.
5. Tests: the token session (fragment read once, stored, stripped, provided;
   sign-out); `loadConfig` over the three shapes; the existing suites unchanged.

## Acceptance

- The Studio's suite green, including the P11 tests unchanged; SC-P12-06's
  offline half.
