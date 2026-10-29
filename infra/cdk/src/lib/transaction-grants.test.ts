/**
 * Every role that writes the main table may make the condition checks the
 * DynamoDB adapter issues inside its transactions, and the API, which serves
 * the adapter's whole store surface, may make every kind of item they hold
 * (P23, 2026-10-27). IAM authorises each item of a TransactWriteItems by its
 * own action, so a ConditionCheck needs `dynamodb:ConditionCheckItem` and a
 * Delete `dynamodb:DeleteItem`; the adapter's tests run on a fake table with no
 * IAM, so a missing grant passed them all, and in production refused every run
 * start (the check) and then every run's end (the live-run marker's delete).
 */
import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { NightshiftApiStack } from "./api-stack.js";
import { NightshiftRunnerStack } from "./runner-stack.js";

const adapter = readFileSync(
  new URL("../../../../packages/persistence/src/aws/stores.ts", import.meta.url),
  "utf8",
);

interface Statement {
  readonly Action: string | readonly string[];
  readonly Resource: unknown;
}

const strings = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
};

/** The IAM action that authorises each kind of TransactWriteItems item. */
const ITEM_ACTIONS: Record<string, string> = {
  Put: "dynamodb:PutItem",
  Update: "dynamodb:UpdateItem",
  Delete: "dynamodb:DeleteItem",
  ConditionCheck: "dynamodb:ConditionCheckItem",
};

/** The kinds of item the adapter's transactions hold, read from its source. */
const transactionItemKinds = (): string[] =>
  Object.keys(ITEM_ACTIONS).filter((kind) => new RegExp(`\\b${kind}: \\{`).test(adapter));

const tableWritersOf = (
  template: Template,
): { readonly role: string; readonly actions: string[] }[] =>
  Object.entries(template.findResources("AWS::IAM::Policy")).flatMap(([id, policy]) => {
    const statements = (policy as { Properties: { PolicyDocument: { Statement: Statement[] } } })
      .Properties.PolicyDocument.Statement as Statement[];
    return statements
      .filter((statement) => {
        const actions = [statement.Action].flat();
        const resources = strings(statement.Resource);
        return (
          actions.includes("dynamodb:PutItem") &&
          resources.some((r) => r.endsWith("TableArn") && !r.endsWith("CredentialsTableArn"))
        );
      })
      .map((statement) => ({ role: id, actions: [statement.Action].flat() as string[] }));
  });

describe("the table's writers and the adapter's transactions", () => {
  const templates = () => {
    const app = () => new App({ context: { "aws:cdk:bundling-stacks": [] } });
    return [
      Template.fromStack(new NightshiftApiStack(app(), "Api", { stage: "dev" })),
      Template.fromStack(
        new NightshiftRunnerStack(app(), "Runner", {
          stage: "dev",
          runnerCommit: "3bf02c0a3bf02c0a3bf02c0a3bf02c0a3bf02c0a",
          imageVersion: "1.0.0",
        }),
      ),
    ];
  };

  it("grants every role that puts to the main table every action an item of the adapter's transactions needs", () => {
    // The adapter is shared: any writer may meet its condition checks, and any
    // writer that puts a run ends one, which deletes the live-run marker
    // (A-66). A writer granted less refuses at runtime what every test on the
    // fake table passed (2026-10-27: the API; 2026-10-29: the publisher and the
    // reconciler, which now start line runs).
    const kinds = transactionItemKinds();
    expect(kinds).toEqual(expect.arrayContaining(["Put", "Delete", "ConditionCheck"]));
    const writers = templates().flatMap(tableWritersOf);
    expect(writers.length).toBeGreaterThan(0);
    const byRole = new Map<string, string[]>();
    for (const writer of writers) {
      byRole.set(writer.role, [...(byRole.get(writer.role) ?? []), ...writer.actions]);
    }
    for (const [role, granted] of byRole) {
      for (const kind of kinds) expect(granted, `${role} ${kind}`).toContain(ITEM_ACTIONS[kind]);
    }
  });
});
