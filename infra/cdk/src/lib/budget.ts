/**
 * Monthly cost budget for the account (T8, D-P2-11, A-17).
 *
 * With one account doing the work of both a sandbox and production, an unnoticed
 * runaway has nowhere else to be. The forecast notification is the one that gives
 * useful warning; the actual-spend thresholds are confirmation.
 *
 * **Region.** AWS Budgets is a global service: budgets belong to the account, not
 * to a region, and the Budgets API itself is served from us-east-1. CloudFormation's
 * `AWS::Budgets::Budget` resource is nonetheless expected to deploy from any
 * commercial region, including us-west-2, because the resource handler calls the
 * global endpoint on the stack's behalf. That expectation is verified by T7's
 * first deploy and `aws budgets describe-budgets`, not assumed; if it fails, the
 * budget moves to its own us-east-1 stack.
 *
 * **Stages.** The budget lives in the data stack, so deploying a second stage
 * would create a second, independent budget on the same account. Budgets carry no
 * hand-set name, so two would not collide, but both would mail on the same spend.
 *
 * No account number is needed: the budget is created in whichever account the
 * stack is deployed to, which keeps synth environment-agnostic.
 */
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { Construct } from "constructs";

export interface MonthlyCostBudgetProps {
  /** Monthly limit in US dollars. */
  readonly limitUsd: number;
  /** Where every notification is mailed. */
  readonly notifyEmail: string;
}

/** Percentages of the limit at which actual spend notifies. */
export const ACTUAL_THRESHOLDS = [50, 80, 100] as const;
/** Percentage of the limit at which forecast spend notifies. */
export const FORECAST_THRESHOLD = 100;

export class MonthlyCostBudget extends Construct {
  readonly budget: CfnBudget;

  constructor(scope: Construct, id: string, props: MonthlyCostBudgetProps) {
    super(scope, id);

    const subscribers = [{ subscriptionType: "EMAIL", address: props.notifyEmail }];
    const notify = (notificationType: "ACTUAL" | "FORECASTED", threshold: number) => ({
      notification: {
        notificationType,
        comparisonOperator: "GREATER_THAN",
        threshold,
        thresholdType: "PERCENTAGE",
      },
      subscribers,
    });

    this.budget = new CfnBudget(this, "Budget", {
      budget: {
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.limitUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        ...ACTUAL_THRESHOLDS.map((threshold) => notify("ACTUAL", threshold)),
        notify("FORECASTED", FORECAST_THRESHOLD),
      ],
    });
  }
}
