# T8 — Budget alarm

**Program:** `p2-control-plane`
**Depends on:** nothing (may run any time)
**Decisions applied:** D-P2-11; A-17

## Objective

Put a cost guard on the account. With one account doing the work of both a sandbox
and production (A-17), an unnoticed runaway has nowhere else to be.

## Deliverables

1. An AWS Budgets monthly cost budget on account `755348349819`, notifying
   `tim+nightshift@wingitlabs.com` (D-P2-11).
2. Thresholds at 50%, 80% and 100% of budgeted spend, plus a forecasted-to-exceed
   notification. Forecast is the one that gives useful warning; the others are
   confirmation.
3. The monthly amount is 500 dollars - leaving enough headroom for P6's model spend. 
4. Define it in CDK in the data stack, not by hand in the console, so it is
   reviewable and reproducible. Note that Budgets is a global service: the budget
   must be declared in `us-east-1` or handled accordingly, and CDK needs the
   account number, which is fine here since A-17 fixes it.
5. A short note in the P2 contract's as-built section recording the amount, the
   thresholds and the address.

## Acceptance

```sh
npm run synth
npx vitest run --project @nightshift/cdk      # assertion test for the budget
AWS_PROFILE=nightshift npm run deploy
aws budgets describe-budgets --account-id 755348349819 --profile nightshift
```

The final command must list the budget with the expected thresholds and
subscriber.

## Notes

- Confirm the notification actually arrives. An alarm nobody receives is worse
  than none, because it is believed. Send a test notification, or set a
  deliberately low temporary threshold, confirm the mail lands, then set the real
  figure.
- This is the only P2 task that touches billing configuration. Keep it separate
  from everything else so it can be reviewed on its own.
