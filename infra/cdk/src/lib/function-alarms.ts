/**
 * Alarms on the runner's background functions.
 *
 * The reconciler threw on every tick for six days (2026-11-11 to 11-17: a line
 * record the current schema refused) and nothing said so; lines with work were
 * never restarted and promotions never refreshed. A function that fails in
 * every one of {@link FAILING_PERIODS} consecutive {@link PERIOD} periods is
 * persistently broken, not unlucky, and the alarm mails the operator.
 */
import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

export const PERIOD = Duration.minutes(5);
export const FAILING_PERIODS = 3;

export interface FunctionAlarmsProps {
  /** Where an alarm is mailed; the address confirms the subscription once. */
  readonly notifyEmail: string;
  /** By the name the alarm carries. */
  readonly functions: Readonly<Record<string, lambda.IFunction>>;
}

export class FunctionAlarms extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: FunctionAlarmsProps) {
    super(scope, id);
    this.topic = new sns.Topic(this, "Topic");
    this.topic.addSubscription(new subscriptions.EmailSubscription(props.notifyEmail));
    for (const [name, fn] of Object.entries(props.functions)) {
      const alarm = new cloudwatch.Alarm(this, `${name}Failing`, {
        alarmDescription: `${name} has failed in each of the last ${FAILING_PERIODS} ${PERIOD.toMinutes()}-minute periods; read its log group.`,
        metric: fn.metricErrors({ period: PERIOD, statistic: cloudwatch.Stats.SUM }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: FAILING_PERIODS,
        datapointsToAlarm: FAILING_PERIODS,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new actions.SnsAction(this.topic));
      alarm.addOkAction(new actions.SnsAction(this.topic));
    }
  }
}
