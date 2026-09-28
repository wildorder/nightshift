/**
 * CDK app entry point. Compiled to `dist/bin/app.js`, which is what
 * `cdk.json` invokes (D-P1-10) — no TypeScript loader is involved.
 *
 * Five stacks: the stateful `nightshift-<stage>-data` and the stateless
 * `nightshift-<stage>-api` (D-P2-07), the account-wide `nightshift-dns` holding
 * the one hosted zone (D-P3-18), and from P11 the Studio's
 * `nightshift-<stage>-studio-cert` in `us-east-1` and `nightshift-<stage>-studio`
 * (D-P11-02). The first three are environment-agnostic; the Studio's two carry
 * an explicit account and region because CloudFront's certificate must live in
 * `us-east-1` and CDK carries it across regions only between stacks that know
 * where they are. Synth still works with no credentials, no profile, and no
 * network: an explicit environment is a constant, not a lookup.
 *
 * `-c hostnames=zone-only` omits the API's certificate and custom domain and
 * both Studio stacks. It is the first deploy of a new account: land the zone,
 * read its `NameServers` output, delegate, then deploy again without the flag.
 * `-c hostedZoneId=…` names the zone for the Studio's certificate (see
 * `studio-cert-stack.ts` for why an export cannot); `cdk.json` carries the v1
 * account's. `-c studioAssets=<dir>` deploys a directory other than
 * `apps/studio/dist` or the placeholder.
 *
 * The composition itself is `lib/stacks.ts`, so a test can build it with a
 * context of its own.
 */
import { App } from "aws-cdk-lib";
import { composeNightshiftStacks } from "../lib/stacks.js";

composeNightshiftStacks(new App());
